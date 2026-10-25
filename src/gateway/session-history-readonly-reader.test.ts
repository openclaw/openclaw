import { DatabaseSync, type StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  isSessionNodePayloadSelect,
  observeSqliteReadSql,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  appendTranscriptMessage,
  readLatestSessionTranscriptMessageEvent,
  replaceSessionEntry,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import { readActiveTranscriptEntryAnchor } from "../config/sessions/session-accessor.sqlite-transcript-anchor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { captureDurableSessionActor } from "../config/sessions/session-actor-durable.js";
import { readSessionActorProjectionReceipt } from "../config/sessions/session-actor-replica.js";
import {
  markCanonicalSessionValidationPending,
  setCanonicalSqliteSessionMainKey,
} from "../config/sessions/session-canonical-key.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { withSessionTranscriptProjectionReceipt } from "../config/sessions/session-transcript-projection-facts-scope.js";
import { runWithSessionTranscriptReadFence } from "../config/sessions/session-transcript-read-fence.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import {
  OpenClawAgentDatabaseReadOnlyScope,
  withScopedOpenClawAgentDatabaseReadOnly,
} from "../state/openclaw-agent-db-readonly-scope.js";
import { invalidateOpenClawAgentDatabaseValidation } from "../state/openclaw-agent-db-validation-cache.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { expectMessageIds, messageEvent } from "./session-history-events.test-support.js";
import type { PreparedSessionHistoryReadTarget } from "./session-history-read.types.js";
import { createReadonlySessionHistoryReader } from "./session-history-readonly-reader.js";
import { readSessionHistoryRequest } from "./session-history-worker-reader.js";

type HistoryTarget = PreparedSessionHistoryReadTarget & { transcript: { sessionKey: string } };
type HistoryReader = ReturnType<typeof createReadonlySessionHistoryReader>;
type RecentOptions = Parameters<HistoryReader["readRecentSessionMessagesWithStatsAsync"]>[1];

async function withHistory(
  read: (fixture: {
    target: HistoryTarget;
    database: ReturnType<typeof openOpenClawAgentDatabase>;
    reader: HistoryReader;
    readRecent: (
      options?: Partial<RecentOptions>,
    ) => ReturnType<HistoryReader["readRecentSessionMessagesWithStatsAsync"]>;
  }) => Promise<void>,
  options: { sharedStore?: boolean } = {},
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const databasePath = options.sharedStore ? state.statePath("shared-history.sqlite") : undefined;
    const scope = {
      agentId: "main",
      sessionId: "requested-history",
      sessionKey: "agent:main:readonly-history",
      storePath: databasePath ?? `${state.sessionsDir()}/sessions.json`,
    };
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: scope.sessionId },
      messageEvent("requested-message", { role: "user", content: "Requested history" }),
    ]);
    await waitForSessionTranscriptProjection(scope);
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      env: state.env,
      ...(databasePath ? { path: databasePath } : {}),
    });
    const target: HistoryTarget = {
      transcript: { ...scope, sessionFile: scope.sessionKey },
      database: { agentId: database.agentId, path: database.path },
      entryValidationKey: scope.sessionKey,
    };
    const reader = createReadonlySessionHistoryReader(target);
    await read({
      database,
      target,
      reader,
      readRecent: (readOptions) =>
        reader.readRecentSessionMessagesWithStatsAsync(target.transcript, {
          maxMessages: 10,
          ...readOptions,
        }),
    });
  });
}

it.each(["entry", "actor"] as const)(
  "reuses %s accounting facts and reloads them after a transcript write",
  async (source) => {
    await withHistory(async ({ target, database, reader }) => {
      const identity = readOpenClawAgentDatabaseIdentity(database);
      if (typeof identity.identity !== "string") {
        throw new Error("Accounting receipt proof requires a physical database");
      }
      const actorTarget = {
        sessionKey: target.transcript.sessionKey,
        database: {
          kind: "file" as const,
          physicalIdentity: identity.identity,
          birthtime: identity.birthtime,
          nativeLocation: database.path,
        },
      };
      const authority = { assertCurrent() {}, assertReadable() {}, authorize() {} };
      const actor = captureDurableSessionActor({
        database: target.database,
        target: actorTarget,
        lifetime: authority,
      });
      const owner = new OpenClawAgentDatabaseReadOnlyScope();

      const options = { includeByteSize: true, includeUsage: false };
      const read = () => owner.run(target.database, () => reader.readTranscriptAccounting(options));
      try {
        const before = read();
        if (source === "actor") {
          await actor.read(authority);
        } else {
          await readSessionEntryReadOnlyInWorker(target.transcript);
        }
        const receipt = readSessionActorProjectionReceipt({
          path: database.path,
          sessionKey: actorTarget.sessionKey,
          sessionId: target.transcript.sessionId,
        });
        const observed = observeSqliteReadSql(
          Object.getPrototypeOf(database.db.prepare("SELECT 1")),
        );
        const redundant = () =>
          observed.queries.filter(
            (sql) =>
              sql.includes('from "session_nodes"') ||
              sql.includes('from "session_participants"') ||
              (source === "actor" && sql.includes('"reset_active_position"')),
          );
        try {
          expect(withSessionTranscriptProjectionReceipt(receipt, read)).toEqual(before);
          expect(redundant()).toEqual([]);
          await appendTranscriptMessage(target.transcript, {
            eventId: "accounting-next",
            parentId: "requested-message",
            message: { role: "user", content: "Updated accounting" },
          });
          await waitForSessionTranscriptProjection(target.transcript);
          observed.queries.length = 0;
          expect(withSessionTranscriptProjectionReceipt(receipt, read).eventCount).toBe(
            before.eventCount! + 1,
          );
          expect(redundant().length).toBeGreaterThan(0);
        } finally {
          observed.restore();
        }
      } finally {
        await actor.release();
        owner.close();
      }
    });
  },
);

it.each([
  { source: { data: "aGVsbG8=" }, mode: "bytes" },
  { source: { url: "https://example.com/result.txt", sizeBytes: 5 }, mode: "url" },
])(
  "reuses $mode artifact summaries without download payloads and invalidates after transcript writes",
  async ({ source, mode }) => {
    await withHistory(async ({ target, database }) => {
      const owner = new OpenClawAgentDatabaseReadOnlyScope();
      const transcript = target.transcript;
      const message = (title: string, role = "assistant") => ({
        role,
        content: [{ type: "file", title, ...source, mimeType: "text/plain" }],
      });
      const read = async (assistantOnly = false, includeDownloadData = false) => {
        const result = await owner.run(target.database, () =>
          readSessionHistoryRequest(
            {
              kind: "artifacts",
              params: {
                target: transcript,
                query: {
                  kind: "list",
                  sessionKey: transcript.sessionKey,
                  includeDownloadData,
                  ...(assistantOnly ? { messageRole: "assistant" as const } : {}),
                },
              },
            },
            target,
          ),
        );
        if (result.kind !== "artifacts" || result.result.kind !== "list") {
          throw new Error("expected artifact list");
        }
        return result.result.artifacts;
      };
      const replace = async (title: string) => {
        await replaceTranscriptEvents(transcript, [
          { type: "session", version: 3, id: transcript.sessionId },
          messageEvent("artifact", message(title)),
        ]);
        await waitForSessionTranscriptProjection(transcript);
      };
      const prototype: StatementSync = Object.getPrototypeOf(database.db.prepare("SELECT 1"));
      const payloadReads: string[] = [];
      // oxlint-disable-next-line typescript/unbound-method -- Forward with the native statement receiver.
      const iterate = prototype.iterate;
      const observer = vi.spyOn(prototype, "iterate").mockImplementation(function (
        this: StatementSync,
        ...args
      ) {
        if (
          this.sourceSQL.includes("event_json") &&
          this.sourceSQL.includes("session_transcript_active_events")
        ) {
          payloadReads.push(this.sourceSQL);
        }
        return iterate.apply(this, args);
      });
      try {
        await replace("first.txt");
        // Cold canonical admission uses a publication scope, which cannot populate derived caches.
        await owner.run(target.database, () =>
          createReadonlySessionHistoryReader(target).readSessionMessageCountAsync(transcript),
        );
        const first = await read();
        expect(first).toMatchObject([{ title: "first.txt", sizeBytes: 5, download: { mode } }]);
        expect(first[0]).not.toHaveProperty("data");
        expect(first[0]).not.toHaveProperty("url");
        expect(payloadReads.length).toBeGreaterThan(0);
        payloadReads.length = 0;
        expect(await read()).toEqual(first);
        expect(payloadReads).toEqual([]);
        expect((await read(false, true))[0]).toMatchObject(source);

        await appendTranscriptMessage(transcript, {
          eventId: "upload",
          parentId: "artifact",
          message: message("uploaded.txt", "user"),
        });
        await waitForSessionTranscriptProjection(transcript);
        expect((await read()).map((a) => a.title)).toEqual(["first.txt", "uploaded.txt"]);
        expect((await read(true)).map((a) => a.title)).toEqual(["first.txt"]);
        await replace("replacement.txt");
        expect((await read()).map((a) => a.title)).toEqual(["replacement.txt"]);
        await replace("same-length-rewrite.txt");
        expect((await read()).map((a) => a.title)).toEqual(["same-length-rewrite.txt"]);
        await replaceTranscriptEvents(transcript, [
          { type: "session", version: 3, id: transcript.sessionId },
        ]);
        expect(await read()).toEqual([]);
      } finally {
        observer.mockRestore();
        owner.close();
      }
    });
  },
);

it.each(["cold", "warm", "policy", "receipt"] as const)(
  "keeps canonical admission and history materialization on one retained snapshot (%s)",
  async (admission) => {
    await withHistory(async ({ target, database, readRecent }) => {
      const scope = new OpenClawAgentDatabaseReadOnlyScope();
      const retained = scope.run(target.database, () =>
        withScopedOpenClawAgentDatabaseReadOnly(({ db }) => db, target.database),
      );
      if (!retained.found) {
        throw new Error("expected retained history reader");
      }
      const connection = requireNativeSqliteDatabase(retained.value);
      const read = () => scope.run(target.database, () => readRecent());
      const external = new DatabaseSync(target.database.path);
      const selectedConnections: DatabaseSync[] = [];
      try {
        if (admission === "cold") {
          // The host fixture writer can already have published canonical admission.
          markCanonicalSessionValidationPending(database);
        } else {
          expectMessageIds((await read()).messages, ["requested-message"]);
          // The race must reach SQLite while canonical admission stays warm.
          const missingEntryReader = createReadonlySessionHistoryReader({
            ...target,
            entryValidationKey: "agent:main:missing-row",
          });
          await scope.run(target.database, () =>
            missingEntryReader.readRecentSessionMessagesWithStatsAsync(target.transcript, {
              maxMessages: 10,
            }),
          );
        }
        if (admission === "policy") {
          setCanonicalSqliteSessionMainKey(database, "custom");
        } else if (admission === "receipt") {
          invalidateOpenClawAgentDatabaseValidation(database.path);
        }
        clearNodeSqliteKyselyCacheForDatabase(connection);
        // oxlint-disable-next-line typescript/unbound-method -- Forward with the actual native reader.
        const prepare = DatabaseSync.prototype.prepare;
        let selectedInTransaction: boolean | undefined;
        const prepareSpy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
          this: DatabaseSync,
          sql,
        ) {
          const statement = prepare.call(this, sql);
          if (
            selectedInTransaction === undefined &&
            this !== external &&
            this !== database.db &&
            this.location() === target.database.path &&
            isSessionNodePayloadSelect(sql) &&
            / from "session_nodes" where "session_key" = /i.test(sql)
          ) {
            selectedConnections.push(this);
            selectedInTransaction = this.isTransaction;
            // Commit after admission but before the exact row read. The same snapshot
            // must protect both row validation and the history payload returned to callers.
            runSqliteImmediateTransactionSync(external, () => {
              external
                .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
                .run("{", target.entryValidationKey!);
              expect(
                external
                  .prepare(
                    "UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = 1",
                  )
                  .run(
                    JSON.stringify(
                      messageEvent("requested-message", {
                        role: "user",
                        content: "Changed history",
                      }),
                    ),
                    target.transcript.sessionId,
                  ).changes,
              ).toBe(1);
            });
          }
          return statement;
        });
        try {
          if (admission === "warm") {
            await expect(read()).rejects.toThrow("openclaw doctor --fix");
          } else {
            const page = await read();
            expectMessageIds(page.messages, ["requested-message"]);
            expect(page.messages[0]).toMatchObject({ content: "Requested history" });
          }
          expect(selectedInTransaction).toBe(admission !== "warm");
          const selectedConnection = selectedConnections[0]!;
          expect(selectedConnection.isTransaction).toBe(false);
          await expect(read()).rejects.toThrow("openclaw doctor --fix");
          expect(selectedConnection.isOpen).toBe(true);
        } finally {
          prepareSpy.mockRestore();
        }
      } finally {
        external.close();
        scope.close();
      }
      expect(selectedConnections[0]?.isOpen).toBe(false);
      expect(connection.isOpen).toBe(false);
    });
  },
);

it("revalidates the retained handle between paged and anchored reader invocations", async () => {
  await withHistory(async ({ target, database, reader, readRecent }) => {
    const scope = new OpenClawAgentDatabaseReadOnlyScope();

    try {
      await scope.run(target.database, async () => {
        const first = await readRecent({ captureReadWindow: true });
        expectMessageIds(first.messages, ["requested-message"]);
        database.db
          .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
          .run("{", target.entryValidationKey!);
        await expect(
          reader.readSessionMessagesPageWithStatsAsync(target.transcript, {
            offset: 0,
            maxMessages: 10,
            expectedReadWindow: first.readWindow,
          }),
        ).rejects.toThrow("openclaw doctor --fix");
        await expect(
          reader.readSessionMessagesAroundIdWithStatsAsync(target.transcript, {
            messageId: "requested-message",
            maxMessages: 10,
          }),
        ).rejects.toThrow("openclaw doctor --fix");
      });
    } finally {
      scope.close();
    }
  });
});

it("retains the matching-entry and blank-key validation bypass", async () => {
  await withHistory(async ({ target, database }) => {
    database.db
      .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
      .run("{", target.entryValidationKey!);
    const { entryValidationKey: _key, ...prepared } = target;
    const reader = createReadonlySessionHistoryReader(prepared);
    const page = await reader.readRecentSessionMessagesWithStatsAsync(target.transcript, {
      maxMessages: 10,
    });
    expectMessageIds(page.messages, ["requested-message"]);
  });
});

it.each(["missing", "successor", "retained"] as const)(
  "does not retarget or reject requested history for a %s entry",
  async (state) => {
    await withHistory(async ({ target, database }) => {
      if (state === "missing") {
        target.entryValidationKey = "agent:main:missing-row";
        target.transcript.sessionKey = target.entryValidationKey;
      } else if (state === "successor") {
        await replaceSessionEntry(
          { ...target.transcript, storePath: target.database.path },
          { sessionId: "successor-history", updatedAt: 2 },
        );
      } else {
        database.db
          .prepare("UPDATE session_nodes SET entry_json = '{}' WHERE session_key = ?")
          .run(target.entryValidationKey!);
        database.db
          .prepare("UPDATE session_nodes SET entry_valid = -1 WHERE session_key = ?")
          .run(target.entryValidationKey!);
      }
      const page = await createReadonlySessionHistoryReader(
        target,
      ).readRecentSessionMessagesWithStatsAsync(target.transcript, { maxMessages: 10 });
      expectMessageIds(page.messages, ["requested-message"]);
      expect(target.transcript.sessionId).toBe("requested-history");
    });
  },
);

it("revalidates canonical keys when repair publishes pending rows", async () => {
  await withHistory(async ({ target, database, readRecent }) => {
    const firstScope = new OpenClawAgentDatabaseReadOnlyScope();
    try {
      await firstScope.run(target.database, () => readRecent());
    } finally {
      firstScope.close();
    }
    database.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) SELECT ?, current_session_id, entry_json, updated_at FROM session_nodes WHERE session_key = ?",
      )
      .run("Agent:main:readonly-history", target.entryValidationKey!);
    database.db
      .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
      .run("Agent:main:readonly-history");
    markCanonicalSessionValidationPending(database, ["Agent:main:readonly-history"]);
    await expect(readRecent()).rejects.toThrow("openclaw doctor --fix");
  });
});

it("revalidates unrelated lineage after a committed main-key policy change", async () => {
  await withHistory(async ({ target, database, readRecent }) => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath: target.database.path,
    };
    await replaceSessionEntry(scope, { sessionId: "main-window", updatedAt: 1 });
    await readRecent();
    setCanonicalSqliteSessionMainKey(database, "work");
    database.db
      .prepare("UPDATE session_nodes SET parent_session_key = ? WHERE session_key = ?")
      .run("agent:main:unrecorded-parent", scope.sessionKey);
    await expect(readRecent()).rejects.toThrow("openclaw doctor --fix");
  });
});

it("validates participant projection on the current reader handle", async () => {
  await withHistory(async ({ target, database, readRecent }) => {
    await readRecent();
    database.db
      .prepare(
        "INSERT INTO session_participants (session_key, identity_namespace, actor_id, contribution_count) VALUES (?, ?, ?, ?)",
      )
      .run(target.entryValidationKey!, "{}", "invalid-participant", 1);
    await expect(readRecent()).rejects.toThrow("Session participant identity is invalid");
  });
});

it("admits history without creating a missing additive participant table", async () => {
  await withHistory(async ({ database, readRecent }) => {
    database.db.exec("DROP TABLE session_participants");
    const page = await readRecent();
    expectMessageIds(page.messages, ["requested-message"]);
    expect(
      database.db
        .prepare("SELECT name FROM sqlite_schema WHERE name = 'session_participants'")
        .get(),
    ).toBeUndefined();
  });
});

it("keeps logical transcript identity separate from the physical schema owner", async () => {
  await withHistory(
    async ({ target, database }) => {
      const scope = {
        agentId: "other",
        sessionKey: "agent:other:shared-history",
        sessionId: "shared-history",
        storePath: database.path,
      };
      await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await replaceTranscriptEvents(scope, [
        { type: "session", version: 3, id: scope.sessionId },
        messageEvent("shared-message", { role: "user", content: "Shared physical store" }),
      ]);
      await waitForSessionTranscriptProjection(scope);
      const reader = createReadonlySessionHistoryReader({
        ...target,
        transcript: { ...scope, sessionFile: scope.sessionKey },
        entryValidationKey: scope.sessionKey,
      });
      const page = await reader.readRecentSessionMessagesWithStatsAsync(scope, { maxMessages: 10 });
      expectMessageIds(page.messages, ["shared-message"]);
      expect(database.agentId).toBe("main");
    },
    { sharedStore: true },
  );
});

it("keeps display history separate from the current-turn context cutoff", async () => {
  await withHistory(async ({ target, readRecent }) => {
    const anchor = readActiveTranscriptEntryAnchor({
      ...target.transcript,
      storePath: target.database.path,
      entryId: "requested-message",
    });
    if (!anchor) {
      throw new Error("expected requested message anchor");
    }
    const retained = new OpenClawAgentDatabaseReadOnlyScope();
    try {
      await retained.run(target.database, async () => {
        await readRecent();
        const admission = { ...anchor, logicalTurnId: "read-fence", role: "user" as const };
        const page = await runWithSessionTranscriptReadFence(admission, () => {
          // Context excludes the admitted turn; display history retains it and validates its identity.
          expect(
            readLatestSessionTranscriptMessageEvent({
              ...target.transcript,
              storePath: target.database.path,
            }),
          ).toBeUndefined();
          return readRecent();
        });
        expectMessageIds(page.messages, ["requested-message"]);
        expect(page.totalMessages).toBe(1);
        await expect(
          runWithSessionTranscriptReadFence(
            { ...admission, storePath: `${target.database.path}.other` },
            () => readRecent(),
          ),
        ).rejects.toThrow("different transcript store");
      });
    } finally {
      retained.close();
    }
  });
});
