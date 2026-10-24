import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { readSessionArchiveContentSync } from "./archive-compression.js";
import { isRetainedSessionTranscriptArchiveName } from "./artifacts.js";
import { setCleanupDeleteFault } from "./cleanup-service.delete-fault.test-support.js";
import { runSessionsCleanup, type SessionsCleanupOptions } from "./cleanup-service.js";
import {
  afterCleanupRead,
  appendUserMessage,
  sessionScope,
} from "./cleanup-service.test-support.js";
import {
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
  const { cleanupFaultWorker } = await import("./cleanup-service.delete-fault.test-support.js");
  return cleanupFaultWorker(await importOriginal<typeof import("node:worker_threads")>());
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

let storePath: string;

const cleanup = (opts: SessionsCleanupOptions = { enforce: true, fixMissing: true }) =>
  runSessionsCleanup({ cfg: {}, opts, targets: [{ agentId: "main", storePath }] });
const archives = () => listDeletedArchives(path.dirname(storePath));
const databasePath = () =>
  resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path;
const sql = (query: string) =>
  openOpenClawAgentDatabase({ agentId: "main", path: databasePath() }).db.prepare(query);
const archiveRow = (sessionId: string) =>
  sql("SELECT 1 FROM session_transcript_archives WHERE session_id = ?").get(sessionId);
const pruneArchives = () =>
  prunePublishedSessionArchivesByRetention({
    scope: { agentId: "main", path: databasePath() },
    rules: [{ reason: "deleted", olderThanMs: 10 }],
    nowMs: 100,
  });
const seed = async (sessionId: string) => {
  const scope = sessionScope(storePath, sessionId);
  await replaceSessionEntry(scope, { sessionId, updatedAt: Date.now() });
  return scope;
};

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
    appendUserMessage(beta, "beta-user-message", "Keep this conversation.");

    const result = await runSessionsCleanup({
      cfg,
      opts: { agent: "beta", dryRun: true, fixMissing: true },
    });

    expect(result.previewResults[0]?.summary).toMatchObject({ beforeCount: 1, missing: 0 });
    expect(loadSessionEntry(beta)).toMatchObject({ sessionId: "beta-global" });
  });
});

// A malformed row cannot prove the transcript has no message, with or without a readable one.
it.each([true, false])(
  "preserves session state when a transcript row is malformed (readable message: %s)",
  async (readableMessage) => {
    const scope = await seed(readableMessage ? "malformed-after-message" : "malformed-only");
    const { sessionId } = scope;
    if (readableMessage) {
      appendUserMessage(scope, "readable-user-message", "keep this conversation");
    }
    appendTranscriptEventSync(scope, { type: "proof", id: "row-to-corrupt" });

    sql(
      `UPDATE transcript_events
         SET event_json = '{malformed'
         WHERE session_id = ? AND seq = (
           SELECT MAX(seq) FROM transcript_events WHERE session_id = ?
         )`,
    ).run(sessionId, sessionId);

    const result = await cleanup();

    expect(result.appliedSummaries[0]?.missing).toBe(0);
    expect(loadSessionEntry(scope)).toMatchObject({ sessionId });
    expect(archives()).toEqual([]);
  },
);

it("recreates every derived file from pending canonical archives after commit", async () => {
  const sessionIds = Array.from({ length: 6 }, (_, index) => `pending-export-${index}`);
  const rawEventJson = (sessionId: string) =>
    `{  "content": "recover after commit ${sessionId}", "type": "proof"  }`;
  for (const sessionId of sessionIds) {
    const scope = await seed(sessionId);
    appendTranscriptEventSync(scope, {
      type: "proof",
      content: `recover after commit ${sessionId}`,
    });
    sql("UPDATE transcript_events SET event_json = ? WHERE session_id = ?").run(
      rawEventJson(sessionId),
      sessionId,
    );
  }

  await cleanup();

  const published = archives();
  expect(published).toHaveLength(sessionIds.length);
  for (const archivePath of published) {
    fs.rmSync(archivePath);
  }
  sql(
    `UPDATE session_transcript_archives
         SET published_at = NULL, last_publish_error = 'simulated crash'`,
  ).run();

  await cleanup();

  const recovered = archives();
  expect(recovered).toHaveLength(sessionIds.length);
  for (const sessionId of sessionIds) {
    const archivePath = recovered.find((candidate) =>
      path.basename(candidate).startsWith(`${sessionId}.jsonl.deleted.`),
    );
    expect(archivePath).toBeTruthy();
    expect(readSessionArchiveContentSync(archivePath ?? "")).toBe(`${rawEventJson(sessionId)}\n`);
  }
  const statuses = sql(
    `SELECT session_id, published_at, publish_attempts, last_publish_error
         FROM session_transcript_archives ORDER BY session_id`,
  ).all();
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
  const scope = await seed("collision");
  const { sessionId } = scope;
  appendTranscriptEventSync(scope, { type: "proof", content: "canonical bytes" });
  await cleanup();
  const archivePath = archives()[0];
  expect(archivePath).toBeTruthy();
  fs.writeFileSync(archivePath ?? "", "different bytes", "utf8");
  sql("UPDATE session_transcript_archives SET published_at = NULL WHERE session_id = ?").run(
    sessionId,
  );

  await expect(cleanup()).rejects.toThrow("remain pending in SQLite");

  expect(fs.readFileSync(archivePath ?? "", "utf8")).toBe("different bytes");
  expect(
    sql(
      "SELECT published_at, last_publish_error FROM session_transcript_archives WHERE session_id = ?",
    ).get(sessionId),
  ).toMatchObject({
    last_publish_error: expect.stringContaining("collision"),
    published_at: null,
  });
});

it("rolls back the canonical archive when lifecycle deletion fails", async () => {
  const sessionId = "rollback-delete";
  setCleanupDeleteFault({
    databasePath: databasePath(),
    sessionId,
    message: "injected lifecycle delete failure",
  });
  const scope = await seed(sessionId);
  appendTranscriptEventSync(scope, { type: "proof", content: "must remain live" });

  await expect(cleanup()).rejects.toThrow("injected lifecycle delete failure");

  expect(loadSessionEntry(scope)).toMatchObject({ sessionId });
  expect(sql("SELECT 1 FROM transcript_events WHERE session_id = ?").get(sessionId)).toEqual({
    1: 1,
  });
  expect(archiveRow(sessionId)).toBeUndefined();
  expect(archives()).toEqual([]);
});

it("keeps a foreign append after worker classification through lifecycle commit", async () => {
  const scope = await seed("worker-classification");
  let classified = 0;
  afterCleanupRead((_snapshot, fixMissing) => {
    if (fixMissing && ++classified === 1) {
      appendUserMessage(scope, "foreign-message-after-inspection", "Keep this new turn.");
    }
  });

  const result = await cleanup();

  expect(classified).toBe(1);
  expect(result.appliedSummaries[0]).toMatchObject({
    applied: true,
    appliedCount: 1,
    beforeCount: 1,
    afterCount: 1,
    missing: 0,
    wouldMutate: false,
  });
  expect(inspectTranscriptEventsSync(scope).events).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: "foreign-message-after-inspection" })]),
  );
  expect(loadSessionEntry(scope)).toMatchObject({ sessionId: scope.sessionId });
  expect(archives()).toEqual([]);
});

it("reclassifies a rewritten generation after a warmed message-bearing inspection", async () => {
  const scope = await seed("rewritten-inspection");
  appendUserMessage(scope, "message-before-rewrite", "Previous generation.");
  const preview = await cleanup({ dryRun: true, fixMissing: true });
  expect(preview.previewResults[0]?.summary.missing).toBe(0);
  expect(
    replaceTranscriptEventsSync(scope, [{ type: "proof", id: "replacement-generation" }]),
  ).toBe(true);

  const result = await cleanup();

  expect(result.appliedSummaries[0]?.missing).toBe(1);
  expect(loadSessionEntry(scope)).toBeUndefined();
  const published = archives();
  expect(published).toHaveLength(1);
  expect(readSessionArchiveContentSync(published[0]!)).toContain("replacement-generation");
});

it.each([false, true])(
  "refuses physical replacement after cleanup classification (initially absent=%s)",
  async (initiallyAbsent) => {
    const scope = sessionScope(storePath, "replaced-cleanup");
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
    let replaced = false;
    let replacementBytes: Buffer | undefined;
    afterCleanupRead((snapshot) => {
      if (!replaced) {
        expect(snapshot.missing).toHaveLength(1);
        fs.renameSync(sqlitePath, savedPath);
        fs.copyFileSync(savedPath, sqlitePath);
        replacementBytes = fs.readFileSync(sqlitePath);
        replaced = true;
      }
    });
    try {
      await expect(cleanup()).rejects.toThrow(/changed|physical|owner|identity/i);
      expect(replaced).toBe(true);
      expect(appeared).toBe(initiallyAbsent);
      expect(fs.readFileSync(sqlitePath)).toEqual(replacementBytes);
      expect(archives()).toEqual([]);
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
  const scope = await seed("retention");
  const { sessionId } = scope;
  appendTranscriptEventSync(scope, { type: "proof", content: "expire together" });
  await cleanup();
  const archivePath = archives()[0];
  expect(archivePath).toBeTruthy();
  sql("UPDATE session_transcript_archives SET created_at = 1 WHERE session_id = ?").run(sessionId);

  expect(await pruneArchives()).toBe(0);
  expect(archiveRow(sessionId)).toEqual({ 1: 1 });

  fs.rmSync(archivePath ?? "");
  expect(await pruneArchives()).toBe(1);
  expect(archiveRow(sessionId)).toBeUndefined();
});
