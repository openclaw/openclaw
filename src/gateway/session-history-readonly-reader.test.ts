import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import {
  readLatestSessionTranscriptMessageEvent,
  replaceSessionEntry,
  replaceTranscriptEvents,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import { readActiveTranscriptEntryAnchor } from "../config/sessions/session-accessor.sqlite-transcript-anchor.js";
import { setCanonicalSqliteSessionMainKey } from "../config/sessions/session-canonical-key.js";
import { runWithSessionTranscriptReadFence } from "../config/sessions/session-transcript-read-fence.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import {
  OpenClawAgentDatabaseReadOnlyScope,
  withScopedOpenClawAgentDatabaseReadOnly,
} from "../state/openclaw-agent-db-readonly-scope.js";
import { assertOpenClawAgentCurrentRuntimeSchema } from "../state/openclaw-agent-db-schema-helpers.js";
import { invalidateOpenClawAgentDatabaseValidation } from "../state/openclaw-agent-db-validation-cache.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { PreparedSessionHistoryReadTarget } from "./session-history-read.types.js";
import { createReadonlySessionHistoryReader } from "./session-history-readonly-reader.js";
import { readChatHistoryMessageId } from "./session-history-tail.js";

async function withHistory(
  read: (fixture: {
    target: PreparedSessionHistoryReadTarget & { transcript: { sessionKey: string } };
    database: ReturnType<typeof openOpenClawAgentDatabase>;
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
      {
        type: "message",
        id: "requested-message",
        parentId: null,
        message: { role: "user", content: "Requested history" },
      },
    ]);
    await waitForSessionTranscriptProjection(scope);
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      env: state.env,
      ...(databasePath ? { path: databasePath } : {}),
    });
    await read({
      database,
      target: {
        transcript: { ...scope, sessionFile: scope.sessionKey },
        database: { agentId: database.agentId, path: database.path },
        entryValidationKey: scope.sessionKey,
      },
    });
  });
}

it.each(["cold", "warm", "policy", "receipt"] as const)(
  "keeps canonical admission and history materialization on one retained snapshot (%s)",
  async (admission) => {
    await withHistory(async ({ target, database }) => {
      const scope = new OpenClawAgentDatabaseReadOnlyScope();
      const retained = scope.run(target.database, () =>
        withScopedOpenClawAgentDatabaseReadOnly(({ db }) => db, target.database),
      );
      if (!retained.found) {
        throw new Error("expected retained history reader");
      }
      const connection = retained.value;
      const reader = createReadonlySessionHistoryReader(target);
      const read = () =>
        scope.run(target.database, () =>
          reader.readRecentSessionMessagesWithStatsAsync(target.transcript, { maxMessages: 10 }),
        );
      const external = new DatabaseSync(target.database.path);
      try {
        if (admission !== "cold") {
          expect((await read()).messages.map(readChatHistoryMessageId)).toEqual([
            "requested-message",
          ]);
        }
        if (admission === "policy") {
          setCanonicalSqliteSessionMainKey(database, "custom");
        } else if (admission === "receipt") {
          invalidateOpenClawAgentDatabaseValidation(database.path);
        }
        clearNodeSqliteKyselyCacheForDatabase(connection);
        const prepare = connection.prepare.bind(connection);
        let selectedInTransaction: boolean | undefined;
        const prepareSpy = vi.spyOn(connection, "prepare").mockImplementation((sql) => {
          const statement = prepare(sql);
          if (
            selectedInTransaction === undefined &&
            /^select \* from "session_nodes" where "session_key" = /i.test(sql)
          ) {
            selectedInTransaction = connection.isTransaction;
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
                    JSON.stringify({
                      type: "message",
                      id: "requested-message",
                      parentId: null,
                      message: { role: "user", content: "Changed history" },
                    }),
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
            expect(page.messages.map(readChatHistoryMessageId)).toEqual(["requested-message"]);
            expect(page.messages[0]).toMatchObject({ content: "Requested history" });
          }
          expect(selectedInTransaction).toBe(admission !== "warm");
          expect(connection.isTransaction).toBe(false);
          await expect(read()).rejects.toThrow("openclaw doctor --fix");
          expect(connection.isOpen).toBe(true);
        } finally {
          prepareSpy.mockRestore();
        }
      } finally {
        external.close();
        scope.close();
      }
      expect(connection.isOpen).toBe(false);
    });
  },
);

it("observes a row changed after preparation and before the first worker read", async () => {
  await withHistory(async ({ target, database }) => {
    const reader = createReadonlySessionHistoryReader(target);
    database.db
      .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
      .run("{", target.entryValidationKey!);
    await expect(
      reader.readRecentSessionMessagesWithStatsAsync(target.transcript, { maxMessages: 10 }),
    ).rejects.toThrow("openclaw doctor --fix");
  });
});

it("revalidates the retained handle between paged and anchored reader invocations", async () => {
  await withHistory(async ({ target, database }) => {
    const scope = new OpenClawAgentDatabaseReadOnlyScope();
    const reader = createReadonlySessionHistoryReader(target);
    try {
      await scope.run(target.database, async () => {
        const first = await reader.readRecentSessionMessagesWithStatsAsync(target.transcript, {
          maxMessages: 10,
          captureReadWindow: true,
        });
        expect(first.messages.map(readChatHistoryMessageId)).toEqual(["requested-message"]);
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
    expect(page.messages.map(readChatHistoryMessageId)).toEqual(["requested-message"]);
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
      const reader = createReadonlySessionHistoryReader(target);
      const page = await reader.readRecentSessionMessagesWithStatsAsync(target.transcript, {
        maxMessages: 10,
      });
      expect(page.messages.map(readChatHistoryMessageId)).toEqual(["requested-message"]);
      expect(target.transcript.sessionId).toBe("requested-history");
    });
  },
);

it("keeps canonical key validation on each admitted reader handle", async () => {
  await withHistory(async ({ target, database }) => {
    const reader = createReadonlySessionHistoryReader(target);
    const firstScope = new OpenClawAgentDatabaseReadOnlyScope();
    try {
      await firstScope.run(target.database, () =>
        reader.readRecentSessionMessagesWithStatsAsync(target.transcript, { maxMessages: 10 }),
      );
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
    await expect(
      reader.readRecentSessionMessagesWithStatsAsync(target.transcript, { maxMessages: 10 }),
    ).rejects.toThrow("openclaw doctor --fix");
  });
});

it("observes a committed main-key policy change before a later read", async () => {
  await withHistory(async ({ target, database }) => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath: target.database.path,
    };
    await replaceSessionEntry(scope, { sessionId: "main-window", updatedAt: 1 });
    const reader = createReadonlySessionHistoryReader(target);
    await reader.readRecentSessionMessagesWithStatsAsync(target.transcript, { maxMessages: 10 });
    setCanonicalSqliteSessionMainKey(database, "work");
    await expect(
      reader.readRecentSessionMessagesWithStatsAsync(target.transcript, { maxMessages: 10 }),
    ).rejects.toThrow("openclaw doctor --fix");
  });
});

it("validates participant projection on the current reader handle", async () => {
  await withHistory(async ({ target, database }) => {
    const reader = createReadonlySessionHistoryReader(target);
    await reader.readRecentSessionMessagesWithStatsAsync(target.transcript, { maxMessages: 10 });
    database.db
      .prepare(
        "INSERT INTO session_participants (session_key, identity_namespace, actor_id, contribution_count) VALUES (?, ?, ?, ?)",
      )
      .run(target.entryValidationKey!, "{}", "invalid-participant", 1);
    await expect(
      reader.readRecentSessionMessagesWithStatsAsync(target.transcript, { maxMessages: 10 }),
    ).rejects.toThrow("Session participant identity is invalid");
  });
});

it("admits history without creating a missing additive participant table", async () => {
  await withHistory(async ({ target, database }) => {
    database.db.exec("DROP TABLE session_participants");
    expect(() =>
      assertOpenClawAgentCurrentRuntimeSchema(database.db, {
        agentId: database.agentId,
        pathname: database.path,
      }),
    ).not.toThrow();
    const reader = createReadonlySessionHistoryReader(target);
    const page = await reader.readRecentSessionMessagesWithStatsAsync(target.transcript, {
      maxMessages: 10,
    });
    expect(page.messages.map(readChatHistoryMessageId)).toEqual(["requested-message"]);
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
        {
          type: "message",
          id: "shared-message",
          parentId: null,
          message: { role: "user", content: "Shared physical store" },
        },
      ]);
      await waitForSessionTranscriptProjection(scope);
      const reader = createReadonlySessionHistoryReader({
        ...target,
        transcript: { ...scope, sessionFile: scope.sessionKey },
        entryValidationKey: scope.sessionKey,
      });
      const page = await reader.readRecentSessionMessagesWithStatsAsync(scope, { maxMessages: 10 });
      expect(page.messages.map(readChatHistoryMessageId)).toEqual(["shared-message"]);
      expect(database.agentId).toBe("main");
    },
    { sharedStore: true },
  );
});

it("keeps display history separate from the current-turn context cutoff", async () => {
  await withHistory(async ({ target }) => {
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
        const reader = createReadonlySessionHistoryReader(target);
        await reader.readRecentSessionMessagesWithStatsAsync(target.transcript, {
          maxMessages: 10,
        });
        const admission = { ...anchor, logicalTurnId: "read-fence", role: "user" as const };
        const page = await runWithSessionTranscriptReadFence(admission, () => {
          // Context excludes the admitted turn; display history retains it and validates its identity.
          expect(
            readLatestSessionTranscriptMessageEvent({
              ...target.transcript,
              storePath: target.database.path,
            }),
          ).toBeUndefined();
          return reader.readRecentSessionMessagesWithStatsAsync(target.transcript, {
            maxMessages: 10,
          });
        });
        expect(page.messages.map(readChatHistoryMessageId)).toEqual(["requested-message"]);
        expect(page.totalMessages).toBe(1);
        await expect(
          runWithSessionTranscriptReadFence(
            { ...admission, storePath: `${target.database.path}.other` },
            () =>
              reader.readRecentSessionMessagesWithStatsAsync(target.transcript, {
                maxMessages: 10,
              }),
          ),
        ).rejects.toThrow("different transcript store");
      });
    } finally {
      retained.close();
    }
  });
});
