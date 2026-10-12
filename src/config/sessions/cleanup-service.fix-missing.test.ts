import fs from "node:fs";
import path from "node:path";
import type { WorkerOptions } from "node:worker_threads";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { readSessionArchiveContentSync } from "./archive-compression.js";
import { isRetainedSessionTranscriptArchiveName } from "./artifacts.js";
import * as cleanupReads from "./cleanup-service-read.js";
import { setCleanupDeleteFault } from "./cleanup-service.delete-fault.test-support.js";
import { runSessionsCleanup } from "./cleanup-service.js";
import {
  appendTranscriptMessageSync,
  inspectTranscriptEventsSync,
  loadSessionEntry,
  replaceSessionEntry,
} from "./session-accessor.js";
import { prunePublishedSessionArchivesByRetention } from "./session-accessor.sqlite-archive-store.js";
import {
  appendTranscriptEventSync,
  replaceTranscriptEventsSync,
} from "./session-accessor.sqlite-transcript-write.test-support.js";
import * as entryReaders from "./session-entry-read-runtime.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const { withCleanupDeleteFault } = await import("./cleanup-service.delete-fault.test-support.js");
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: WorkerOptions) {
        super(filename, withCleanupDeleteFault(options));
      }
    },
  };
});

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-cleanup-fix-missing-");

function listDeletedArchives(directory: string): string[] {
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs
    .readdirSync(directory)
    .filter(isRetainedSessionTranscriptArchiveName)
    .map((entry) => path.join(directory, entry));
}

describe("sessions cleanup --fix-missing", () => {
  let storePath: string;

  beforeEach(() => {
    const tempDir = sessionDirs.make();
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  });

  afterEach(() => {
    setCleanupDeleteFault(undefined);
    vi.restoreAllMocks();
  });

  it("inspects unscoped transcript keys in the selected agent's fixed-store partition", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      storePath = state.statePath("shared.json");
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {}, beta: {} } },
        session: { store: storePath },
      };
      await state.writeConfig(cfg);
      const main = { agentId: "main", sessionKey: "global", sessionId: "main-global", storePath };
      const beta = { agentId: "beta", sessionKey: "global", sessionId: "beta-global", storePath };
      for (const scope of [main, beta]) {
        await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: Date.now() });
      }
      appendTranscriptMessageSync(beta, {
        eventId: "beta-user-message",
        message: { role: "user", content: [{ type: "text", text: "Keep this conversation." }] },
      });

      const result = await runSessionsCleanup({
        cfg,
        opts: { agent: "beta", dryRun: true, fixMissing: true },
      });

      expect(result.previewResults[0]?.summary).toMatchObject({ beforeCount: 1, missing: 0 });
      expect(loadSessionEntry(beta)).toMatchObject({ sessionId: "beta-global" });
    });
  });

  it("preserves readable session state when a later transcript row is malformed", async () => {
    const sessionKey = "agent:main:malformed-after-message";
    const sessionId = "malformed-after-message";
    const scope = { sessionKey, sessionId, storePath };
    await replaceSessionEntry(scope, { sessionId, updatedAt: Date.now() });
    appendTranscriptMessageSync(scope, {
      eventId: "readable-user-message",
      message: { role: "user", content: [{ type: "text", text: "keep this conversation" }] },
    });
    appendTranscriptEventSync(scope, { type: "proof", id: "row-to-corrupt" });

    const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path;
    if (!sqlitePath) {
      throw new Error("expected SQLite session store");
    }
    const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath });
    database.db
      .prepare(
        `UPDATE transcript_events
         SET event_json = '{malformed'
         WHERE session_id = ? AND seq = (
           SELECT MAX(seq) FROM transcript_events WHERE session_id = ?
         )`,
      )
      .run(sessionId, sessionId);

    const result = await runSessionsCleanup({
      cfg: {},
      opts: { enforce: true, fixMissing: true },
      targets: [{ agentId: "main", storePath }],
    });

    expect(result.appliedSummaries[0]?.missing).toBe(0);
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({ sessionId });
    expect(listDeletedArchives(path.dirname(storePath))).toEqual([]);
  });

  it("recreates every derived file from pending canonical archives after commit", async () => {
    const sessionIds = Array.from({ length: 6 }, (_, index) => `pending-export-${index}`);
    const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path;
    const rawEventJson = (sessionId: string) =>
      `{  "content": "recover after commit ${sessionId}", "type": "proof"  }`;
    for (const sessionId of sessionIds) {
      const scope = {
        sessionId,
        sessionKey: `agent:main:${sessionId}`,
        storePath,
      };
      await replaceSessionEntry(scope, { sessionId, updatedAt: Date.now() });
      appendTranscriptEventSync(scope, {
        type: "proof",
        content: `recover after commit ${sessionId}`,
      });
      openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath })
        .db.prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ?")
        .run(rawEventJson(sessionId), sessionId);
    }

    await runSessionsCleanup({
      cfg: {},
      opts: { enforce: true, fixMissing: true },
      targets: [{ agentId: "main", storePath }],
    });

    const archives = listDeletedArchives(path.dirname(storePath));
    expect(archives).toHaveLength(sessionIds.length);
    for (const archivePath of archives) {
      fs.rmSync(archivePath);
    }
    openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath })
      .db.prepare(
        `UPDATE session_transcript_archives
         SET published_at = NULL, last_publish_error = 'simulated crash'`,
      )
      .run();

    await runSessionsCleanup({
      cfg: {},
      opts: { enforce: true, fixMissing: true },
      targets: [{ agentId: "main", storePath }],
    });

    const recovered = listDeletedArchives(path.dirname(storePath));
    expect(recovered).toHaveLength(sessionIds.length);
    for (const sessionId of sessionIds) {
      const archivePath = recovered.find((candidate) =>
        path.basename(candidate).startsWith(`${sessionId}.jsonl.deleted.`),
      );
      expect(archivePath).toBeTruthy();
      expect(readSessionArchiveContentSync(archivePath ?? "")).toBe(`${rawEventJson(sessionId)}\n`);
    }
    const statuses = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath })
      .db.prepare(
        `SELECT session_id, published_at, publish_attempts, last_publish_error
         FROM session_transcript_archives ORDER BY session_id`,
      )
      .all();
    expect(statuses).toHaveLength(sessionIds.length);
    for (const status of statuses) {
      expect(status).toMatchObject({
        last_publish_error: null,
        publish_attempts: 2,
        published_at: expect.any(Number),
      });
    }
  });

  it("never overwrites a different derived-file collision", async () => {
    const sessionKey = "agent:main:collision";
    const sessionId = "collision";
    const scope = { sessionKey, sessionId, storePath };
    await replaceSessionEntry(scope, { sessionId, updatedAt: Date.now() });
    appendTranscriptEventSync(scope, { type: "proof", content: "canonical bytes" });
    await runSessionsCleanup({
      cfg: {},
      opts: { enforce: true, fixMissing: true },
      targets: [{ agentId: "main", storePath }],
    });
    const archivePath = listDeletedArchives(path.dirname(storePath))[0];
    expect(archivePath).toBeTruthy();
    fs.writeFileSync(archivePath ?? "", "different bytes", "utf8");
    const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path;
    if (!sqlitePath) {
      throw new Error("expected SQLite session store");
    }
    const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath });
    database.db
      .prepare("UPDATE session_transcript_archives SET published_at = NULL WHERE session_id = ?")
      .run(sessionId);

    await expect(
      runSessionsCleanup({
        cfg: {},
        opts: { enforce: true, fixMissing: true },
        targets: [{ agentId: "main", storePath }],
      }),
    ).rejects.toThrow("remain pending in SQLite");

    expect(fs.readFileSync(archivePath ?? "", "utf8")).toBe("different bytes");
    expect(
      database.db
        .prepare(
          "SELECT published_at, last_publish_error FROM session_transcript_archives WHERE session_id = ?",
        )
        .get(sessionId),
    ).toMatchObject({
      last_publish_error: expect.stringContaining("collision"),
      published_at: null,
    });
  });

  it("rolls back the canonical archive when lifecycle deletion fails", async () => {
    const sessionKey = "agent:main:rollback-delete";
    const sessionId = "rollback-delete";
    const scope = { sessionKey, sessionId, storePath };
    const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path;
    if (!sqlitePath) {
      throw new Error("expected SQLite session store");
    }
    setCleanupDeleteFault({
      databasePath: sqlitePath,
      sessionId,
      message: "injected lifecycle delete failure",
    });
    await replaceSessionEntry(scope, { sessionId, updatedAt: Date.now() });
    appendTranscriptEventSync(scope, { type: "proof", content: "must remain live" });
    const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath });

    await expect(
      runSessionsCleanup({
        cfg: {},
        opts: { enforce: true, fixMissing: true },
        targets: [{ agentId: "main", storePath }],
      }),
    ).rejects.toThrow("injected lifecycle delete failure");

    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({ sessionId });
    expect(
      database.db.prepare("SELECT 1 FROM transcript_events WHERE session_id = ?").get(sessionId),
    ).toEqual({ 1: 1 });
    expect(
      database.db
        .prepare("SELECT 1 FROM session_transcript_archives WHERE session_id = ?")
        .get(sessionId),
    ).toBeUndefined();
    expect(listDeletedArchives(path.dirname(storePath))).toEqual([]);
  });

  it("keeps a foreign append after worker classification through lifecycle commit", async () => {
    const sessionKey = "agent:main:worker-classification";
    const scope = { sessionKey, sessionId: "worker-classification", storePath };
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: Date.now() });
    const readStore = cleanupReads.withSessionCleanupStore;
    let classified = 0;
    vi.spyOn(cleanupReads, "withSessionCleanupStore").mockImplementation(
      (target, consume, options) =>
        readStore(
          target,
          (owner) =>
            consume({
              ...owner,
              read: async (fixMissing) => {
                const result = await owner.read(fixMissing);
                if (fixMissing && ++classified === 2) {
                  appendTranscriptMessageSync(scope, {
                    eventId: "foreign-message-after-inspection",
                    message: {
                      role: "user",
                      content: [{ type: "text", text: "Keep this new turn." }],
                    },
                  });
                }
                return result;
              },
            }),
          options,
        ),
    );

    const result = await runSessionsCleanup({
      cfg: {},
      opts: { enforce: true, fixMissing: true },
      targets: [{ agentId: "main", storePath }],
    });

    expect(classified).toBe(2);
    expect(result.appliedSummaries[0]?.missing).toBe(0);
    expect(inspectTranscriptEventsSync(scope).events).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "foreign-message-after-inspection" })]),
    );
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      sessionId: scope.sessionId,
    });
    expect(listDeletedArchives(path.dirname(storePath))).toEqual([]);
  });

  it("reclassifies a rewritten generation after a warmed message-bearing inspection", async () => {
    const scope = {
      sessionKey: "agent:main:rewritten-inspection",
      sessionId: "rewritten-inspection",
      storePath,
    };
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: Date.now() });
    appendTranscriptMessageSync(scope, {
      eventId: "message-before-rewrite",
      message: { role: "user", content: [{ type: "text", text: "Previous generation." }] },
    });
    const target = { agentId: "main", storePath };
    const preview = await runSessionsCleanup({
      cfg: {},
      opts: { dryRun: true, fixMissing: true },
      targets: [target],
    });
    expect(preview.previewResults[0]?.summary.missing).toBe(0);
    expect(
      replaceTranscriptEventsSync(scope, [{ type: "proof", id: "replacement-generation" }]),
    ).toBe(true);

    const result = await runSessionsCleanup({
      cfg: {},
      opts: { enforce: true, fixMissing: true },
      targets: [target],
    });

    expect(result.appliedSummaries[0]?.missing).toBe(1);
    expect(loadSessionEntry(scope)).toBeUndefined();
    const archives = listDeletedArchives(path.dirname(storePath));
    expect(archives).toHaveLength(1);
    expect(readSessionArchiveContentSync(archives[0]!)).toContain("replacement-generation");
  });

  it.each([false, true])(
    "refuses physical replacement between cleanup preview and apply (initially absent=%s)",
    async (initiallyAbsent) => {
      const scope = {
        sessionKey: "agent:main:replaced-cleanup",
        sessionId: "replaced-cleanup",
        storePath,
      };
      const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: "main",
      }).path;
      const seedPath = `${sqlitePath}.seed.sqlite`;
      await replaceSessionEntry(
        { ...scope, storePath: initiallyAbsent ? seedPath : storePath },
        { sessionId: scope.sessionId, updatedAt: Date.now() },
      );
      let appeared = false;
      if (initiallyAbsent) {
        await closeOpenClawAgentDatabaseByPathAsync(seedPath);
        expect(fs.existsSync(sqlitePath)).toBe(false);
        const withReader = entryReaders.withSessionStoreReaderInWorker;
        vi.spyOn(entryReaders, "withSessionStoreReaderInWorker").mockImplementation(
          (input, read, options) =>
            withReader(
              input,
              (owner) => {
                if (input.storePath === storePath && !appeared) {
                  // The existing owner has already captured absence; the real worker will supply the receipt.
                  expect(owner.database.path).toBe(sqlitePath);
                  fs.copyFileSync(seedPath, sqlitePath);
                  appeared = true;
                }
                return read(owner);
              },
              options,
            ),
        );
      }
      const savedPath = `${sqlitePath}.saved`;
      const readStore = cleanupReads.withSessionCleanupStore;
      let replaced = false;
      let replacementBytes: Buffer | undefined;
      vi.spyOn(cleanupReads, "withSessionCleanupStore").mockImplementation(
        async (target, consume, options) => {
          const result = await readStore(target, consume, options);
          if (!replaced) {
            expect(result).toMatchObject({ result: { summary: { beforeCount: 1, missing: 1 } } });
            fs.renameSync(sqlitePath, savedPath);
            fs.copyFileSync(savedPath, sqlitePath);
            replacementBytes = fs.readFileSync(sqlitePath);
            replaced = true;
          }
          return result;
        },
      );
      try {
        await expect(
          runSessionsCleanup({
            cfg: {},
            opts: { enforce: true, fixMissing: true },
            targets: [{ agentId: "main", storePath }],
          }),
        ).rejects.toThrow(/changed|physical|owner|identity/i);
        expect(replaced).toBe(true);
        expect(appeared).toBe(initiallyAbsent);
        expect(fs.readFileSync(sqlitePath)).toEqual(replacementBytes);
        expect(listDeletedArchives(path.dirname(storePath))).toEqual([]);
      } finally {
        if (replaced) {
          fs.rmSync(sqlitePath);
          fs.renameSync(savedPath, sqlitePath);
        }
      }
      expect(loadSessionEntry(scope)).toMatchObject({ sessionId: scope.sessionId });
    },
  );

  it("drops a retained canonical row only after retention removes its derived file", async () => {
    const sessionKey = "agent:main:retention";
    const sessionId = "retention";
    const scope = { sessionKey, sessionId, storePath };
    await replaceSessionEntry(scope, { sessionId, updatedAt: Date.now() });
    appendTranscriptEventSync(scope, { type: "proof", content: "expire together" });
    await runSessionsCleanup({
      cfg: {},
      opts: { enforce: true, fixMissing: true },
      targets: [{ agentId: "main", storePath }],
    });
    const archivePath = listDeletedArchives(path.dirname(storePath))[0];
    expect(archivePath).toBeTruthy();
    const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path;
    if (!sqlitePath) {
      throw new Error("expected SQLite session store");
    }
    const database = openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath });
    database.db
      .prepare("UPDATE session_transcript_archives SET created_at = 1 WHERE session_id = ?")
      .run(sessionId);

    expect(
      await prunePublishedSessionArchivesByRetention({
        scope: { agentId: "main", path: sqlitePath },
        rules: [{ reason: "deleted", olderThanMs: 10 }],
        nowMs: 100,
      }),
    ).toBe(0);
    expect(
      database.db
        .prepare("SELECT 1 FROM session_transcript_archives WHERE session_id = ?")
        .get(sessionId),
    ).toEqual({ 1: 1 });

    fs.rmSync(archivePath ?? "");
    expect(
      await prunePublishedSessionArchivesByRetention({
        scope: { agentId: "main", path: sqlitePath },
        rules: [{ reason: "deleted", olderThanMs: 10 }],
        nowMs: 100,
      }),
    ).toBe(1);
    expect(
      database.db
        .prepare("SELECT 1 FROM session_transcript_archives WHERE session_id = ?")
        .get(sessionId),
    ).toBeUndefined();
  });
});
