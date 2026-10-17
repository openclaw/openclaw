import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as sqliteRuntime from "../../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  forkSessionAtMessage,
  listSessionBranches,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
  rewindSessionToMessage,
  switchSessionBranch,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  invalidateSessionBranchCache,
  type SessionBranchSummaryReadRequest,
} from "./session-accessor.sqlite-branches.js";
import { readSessionBranchSummariesInWorker } from "./session-accessor.sqlite-branches.worker.js";
import {
  agentId,
  sessionKey,
  useSessionMessageCutFixtures,
} from "./session-accessor.sqlite-message-cut.test-support.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import type { SessionBranchSummary } from "./session-accessor.types.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import * as coldStorage from "./session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  historicalId,
  maintenanceConfig,
} from "./session-cold-storage.test-support.js";
import {
  waitForSessionTranscriptIndexReconcilesInStateDir,
  waitForSessionTranscriptProjection,
} from "./session-transcript-reconcile.js";

const { tempDirs, createSession, createSiblingSession } = useSessionMessageCutFixtures();
const diagnosticCleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of diagnosticCleanups.splice(0)) {
    cleanup();
  }
  vi.restoreAllMocks();
});

function trackFullTranscriptLoads(env: NodeJS.ProcessEnv): () => number {
  const database = openOpenClawAgentDatabase({ agentId, env });
  const { counts } = trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(database.db),
    ["loads"],
    (sqlText) => (isTranscriptLoad(sqlText) ? "loads" : null),
  );
  return () => counts.loads;
}

const isTranscriptLoad = (sql: string) =>
  sql.includes('from "transcript_events"') && sql.includes('order by "seq" asc');
const sibling = (env: NodeJS.ProcessEnv, sessionId: string, headline: string) =>
  createSiblingSession({ env, sessionId, sessionKey: `agent:main:${sessionId}`, headline });
const appendAnswer = (
  scope: Parameters<typeof appendTranscriptMessage>[0],
  content = "third answer",
  parentId = "assistant-2",
) =>
  appendTranscriptMessage(scope, {
    eventId: "assistant-3",
    message: { role: "assistant", content },
    now: Date.parse("2026-07-18T00:00:07.000Z"),
    parentId,
  });

function trackBranchSummaryReads(): () => number {
  let reads = 0;
  const postMessage = Worker.prototype.postMessage;
  vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    ...args: Parameters<Worker["postMessage"]>
  ) {
    const [message] = args;
    if (isRecord(message) && isRecord(message.input) && message.input.kind === "branch-summaries") {
      reads++;
    }
    Reflect.apply(postMessage, this, args);
  });
  return () => reads;
}

const summary = (branches: Partial<SessionBranchSummary>[]) => ({ status: "ok", branches });
const makeBranch = (leafEntryId: string, headline: string, messageCount?: number) => ({
  active: true,
  leafEntryId,
  headline,
  ...(messageCount === undefined ? {} : { messageCount }),
});
function expectBranch(result: unknown, ...args: Parameters<typeof makeBranch>) {
  const branches = expect.arrayContaining([expect.objectContaining(makeBranch(...args))]);
  expect(result).toMatchObject(summary(branches));
}
const rewriteAnswer = (
  events: Parameters<typeof replaceTranscriptEvents>[1],
  id: string,
  content: string,
) =>
  events.map((event) =>
    isRecord(event) && event.id === id
      ? Object.assign({}, event, { message: { role: "assistant", content } })
      : event,
  );
const message = (
  id: string,
  parentId: string | null,
  role: string,
  content: unknown,
  extra = {},
  messageExtra = {},
) => ({ type: "message", id, parentId, message: { role, content, ...messageExtra }, ...extra });
const phasedText = (type: string, text: string, phase: string) => ({
  type,
  text,
  textSignature: JSON.stringify({ v: 1, phase }),
});

function activeBranch(result: Awaited<ReturnType<typeof listSessionBranches>>) {
  assert.ok(result.status === "ok", "expected branch list result");
  return result.branches.find((branch) => branch.active);
}

it("coalesces concurrent viewers and skips restoration for unchanged summaries", async () => {
  const { scope } = await createSession();
  const branchReads = trackBranchSummaryReads();
  const restore = vi.spyOn(coldStorage, "restoreSessionColdTranscript");
  const results = await Promise.all(Array.from({ length: 3 }, () => listSessionBranches(scope)));
  expect(results).toEqual(Array(3).fill(results[0]));
  const second = results[1];
  assert.ok(second?.status === "ok" && second.branches[0], "expected shared branch summaries");
  second.branches[0].headline = "caller mutation";
  expect(results[2]).toEqual(results[0]);
  await expect(listSessionBranches(scope)).resolves.toEqual(results[0]);
  expect(branchReads()).toBe(1);
  expect(restore).not.toHaveBeenCalled();
});

it("carries summaries into fresh readers and invalidates changed transcripts", async () => {
  const { env, scope } = await createSession();
  const database = openOpenClawAgentDatabase({ agentId, env });
  const request: SessionBranchSummaryReadRequest = {
    database: { agentId, path: database.path },
    sessionKey,
  };
  await closeOpenClawAgentDatabaseByPathAsync(database.path, agentId);
  const counters: Array<{ loads: number; watermarks: number }> = [];
  const rowCounters: Array<{ loads: number }> = [];
  const openSqlite = sqliteRuntime.openNodeSqliteDatabase;
  vi.spyOn(sqliteRuntime, "openNodeSqliteDatabase").mockImplementation((pathname, options) => {
    const connection = openSqlite(pathname, options);
    if (pathname === database.path && options?.readOnly) {
      const tracked = trackSqliteStatementExecutions(
        connection,
        ["loads", "watermarks"],
        (sqlText) =>
          (sqlText.includes('from "transcript_events"') && sqlText.includes("max(")) ||
          sqlText.includes('from "transcript_rewrite_watermarks"')
            ? "watermarks"
            : isTranscriptLoad(sqlText)
              ? "loads"
              : null,
      );
      counters.push(tracked.counts);
      rowCounters.push(tracked.rowCounts);
      diagnosticCleanups.push(tracked.restore);
    }
    return connection;
  });
  const rawLoads = () => counters.reduce((total, counter) => total + counter.loads, 0);
  const first = readSessionBranchSummariesInWorker(request);
  expectBranch(first, "assistant-2", "second answer", 4);
  assert.ok(first.status === "ok" && first.branches[0], "expected worker branch summaries");
  request.previous = structuredClone(first);
  // A replacement worker has no isolate-local summary cache.
  invalidateSessionBranchCache(database.path, [scope.sessionId]);
  const watermarkReads = () => counters.reduce((total, counter) => total + counter.watermarks, 0);
  const beforeRepeatedReads = watermarkReads();
  for (let index = 0; index < 7; index++) {
    expect(readSessionBranchSummariesInWorker(request)).toEqual(first);
  }
  expect(rawLoads()).toBe(1);
  expect(watermarkReads() - beforeRepeatedReads).toBeGreaterThan(0);
  expect(watermarkReads() - beforeRepeatedReads).toBeLessThanOrEqual(7);
  const original = structuredClone(first);
  first.branches[0].headline = "caller mutation";
  expect(readSessionBranchSummariesInWorker(request)).toEqual(original);
  expect(rawLoads()).toBe(1);

  const rowsBeforeAppend = rowCounters.reduce((total, counter) => total + counter.loads, 0);
  let parentId = "assistant-2";
  for (const type of ["custom", "custom_message", "compaction", "reset"]) {
    const id = `metadata-${type}`;
    await appendTranscriptEvent(scope, { type, id, parentId });
    parentId = id;
  }
  await appendAnswer(scope, "third answer", parentId);
  expectBranch(readSessionBranchSummariesInWorker(request), "assistant-3", "third answer", 5);
  expect(rawLoads()).toBe(2);
  expect(
    rowCounters.reduce((total, counter) => total + counter.loads, 0) - rowsBeforeAppend,
  ).toBeLessThanOrEqual(5);
  const events = await loadTranscriptEvents(scope);
  await replaceTranscriptEvents(scope, rewriteAnswer(events, "assistant-3", "rewritten answer"));
  await waitForSessionTranscriptIndexReconcilesInStateDir(env.OPENCLAW_STATE_DIR);
  expectBranch(readSessionBranchSummariesInWorker(request), "assistant-3", "rewritten answer", 5);
  expect(rawLoads()).toBe(3);
});

it("refuses cached worker summaries in cold storage and reuses them after restoration", async () => {
  const storePath = path.join(tempDirs.make("openclaw-branch-cold-"), "agent.sqlite");
  const fixture = await createSessionColdStorageFixture(storePath);
  await replaceSessionEntry(fixture.scope, { sessionId: historicalId, updatedAt: 1 });
  const request = {
    database: { agentId, path: storePath },
    sessionKey: fixture.scope.sessionKey,
  };
  const first = readSessionBranchSummariesInWorker(request);
  const expected = summary([makeBranch("history-assistant", "Preserved response", 2)]);
  expect(first).toMatchObject(expected);
  await expect(
    coldStorage.runSessionColdStorageMaintenance({ config: maintenanceConfig(storePath) }),
  ).resolves.toMatchObject({ archivedTranscripts: 1 });
  expect(() => readSessionBranchSummariesInWorker(request)).toThrow(
    expect.objectContaining({ code: "TRANSCRIPT_COLD" }),
  );
  await expect(listSessionBranches(fixture.scope)).resolves.toMatchObject(expected);
  expect(readSessionBranchSummariesInWorker(request)).toEqual(first);
});

it("reuses unchanged summaries across fifty active sessions without repeating worker reads", async () => {
  const { env } = await createSession();
  const scopes = [];
  for (let index = 0; index < 50; index++) {
    scopes.push(await sibling(env, `viewer-${index}`, `Conversation ${index}`));
  }
  const branchReads = trackBranchSummaryReads();
  for (let round = 0; round < 2; round++) {
    for (const scope of scopes) {
      const expected = {
        ...makeBranch(`${scope.sessionId}-user`, scope.headline, 1),
        updatedAt: "2026-07-18T01:00:01.000Z",
      };
      await expect(listSessionBranches(scope)).resolves.toEqual(summary([expected]));
    }
    expect(branchReads()).toBe(scopes.length);
  }
});

it("recomputes summaries after physical database replacement with identical watermarks", async () => {
  const { env, scope } = await createSession();
  const database = openOpenClawAgentDatabase({ agentId, env });
  const branchReads = trackBranchSummaryReads();
  const first = await listSessionBranches(scope);
  expect(first.status).toBe("ok");
  expect(branchReads()).toBe(1);

  // Canonical close drains readers and checkpoints WAL before copying the complete database.
  await closeOpenClawAgentDatabaseByPathAsync(database.path, agentId);
  const replacement = `${database.path}.replacement`;
  fs.copyFileSync(database.path, replacement);
  fs.renameSync(replacement, database.path);

  await expect(listSessionBranches(scope)).resolves.toEqual(first);
  expect(branchReads()).toBe(2);
  await expect(listSessionBranches(scope)).resolves.toEqual(first);
  // Without a host write receipt, a newly admitted read-only database stays uncached.
  expect(branchReads()).toBe(3);
  expect(isOpenClawAgentDatabaseOpen(database.path)).toBe(false);
});

it("refreshes appended and replaced sessions without main-thread SQL", async () => {
  const { env, scope } = await createSession();
  const replacement = await sibling(env, "replacement-source", "replacement conversation");
  await waitForSessionTranscriptIndexReconcilesInStateDir(env.OPENCLAW_STATE_DIR);
  const database = openOpenClawAgentDatabase({ agentId, env });
  const tracked = trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(database.db),
    ["statements"],
    () => "statements",
  );
  diagnosticCleanups.push(tracked.restore);
  const nativeOpen = vi.spyOn(sqliteRuntime, "openNodeSqliteDatabase");
  const branchReads = trackBranchSummaryReads();
  const expectNoSql = (statements = 0) => {
    expect(tracked.counts.statements).toBe(statements);
    expect(nativeOpen).not.toHaveBeenCalled();
  };

  const before = await listSessionBranches({ agentId, env, sessionKey });
  expect(branchReads()).toBe(1);
  expectNoSql();
  await appendAnswer(scope);

  await waitForSessionTranscriptIndexReconcilesInStateDir(env.OPENCLAW_STATE_DIR);
  const statementsAfterAppend = tracked.counts.statements;
  nativeOpen.mockClear();
  const after = await listSessionBranches({ agentId, env, sessionKey });
  expectNoSql(statementsAfterAppend);
  expect(branchReads()).toBe(2);
  expect(after).not.toEqual(before);
  expect(activeBranch(after)).toMatchObject({
    leafEntryId: "assistant-3",
    headline: "third answer",
  });

  await replaceSessionEntry(scope, { sessionId: replacement.sessionId, updatedAt: 2 });
  const statementsAfterReplacement = tracked.counts.statements;
  nativeOpen.mockClear();
  await expect(listSessionBranches({ agentId, env, sessionKey })).resolves.toMatchObject({
    status: "ok",
    branches: [{ headline: "replacement conversation", leafEntryId: "replacement-source-user" }],
  });
  expectNoSql(statementsAfterReplacement);
});

it.each(["rewind", "switch", "fork"] as const)(
  "%s invalidates the source cache and lists the resulting branch",
  async (mode) => {
    const { env, scope } = await createSession();
    const aliasKey = `${sessionKey}:alias`;
    const targetKey = `${sessionKey}:fork`;
    const sourceEntry = loadSessionEntry(scope);
    assert.ok(sourceEntry, "expected source session entry");
    await upsertSessionEntryCore({ agentId, env, sessionKey: aliasKey }, sourceEntry);
    const branchReads = trackBranchSummaryReads();
    await listSessionBranches({ agentId, env, sessionKey });

    const result =
      mode === "rewind"
        ? await rewindSessionToMessage({ ...scope, entryId: "user-2" })
        : mode === "switch"
          ? await switchSessionBranch({ ...scope, leafEntryId: "off-path-user" })
          : await forkSessionAtMessage({ ...scope, entryId: "user-2", targetKey });
    expect(result.status).toBe("created");

    const readsBeforeAliasRead = branchReads();
    await listSessionBranches({ agentId, env, sessionKey: aliasKey });
    expect(branchReads()).toBe(readsBeforeAliasRead + 1);

    const listed = await listSessionBranches({
      agentId,
      env,
      sessionKey: mode === "fork" ? targetKey : sessionKey,
    });
    expect(activeBranch(listed)).toMatchObject({
      leafEntryId: mode === "switch" ? "off-path-user" : "assistant-1",
    });
  },
);

it("keeps opaque payloads in the worker and refreshes phased Unicode headlines after a rewrite", async () => {
  const { env, scope } = await createSession();
  const opaque = "x".repeat(256 * 1024);
  const events = [
    { type: "session", id: scope.sessionId, version: 3 },
    message("prompt", null, "user", "prompt"),
    message(
      "answer",
      "prompt",
      "assistant",
      [
        phasedText("text", "commentary", "commentary"),
        { type: "text", text: "legacy text" },
        phasedText("output_text", "🦞".repeat(130), "final_answer"),
      ],
      {},
      { providerReplay: { opaque } },
    ),
    ...Array.from({ length: 8 }, (_, index) =>
      message(
        `tool-${index}`,
        index === 0 ? "answer" : `tool-${index - 1}`,
        "toolResult",
        opaque,
        {},
        { toolCallId: `call-${index}`, details: { opaque } },
      ),
    ),
  ];
  await replaceTranscriptEvents(scope, events);
  await waitForSessionTranscriptProjection(scope);
  const fullTranscriptLoads = trackFullTranscriptLoads(env);
  const branchReads = trackBranchSummaryReads();

  await expect(listSessionBranches(scope)).resolves.toEqual(
    summary([makeBranch("tool-7", `${"🦞".repeat(119)}…`, 10)]),
  );
  expect(fullTranscriptLoads()).toBe(0);
  expect(branchReads()).toBe(1);

  await replaceTranscriptEvents(scope, rewriteAnswer(events, "answer", "new final answer"));
  await waitForSessionTranscriptProjection(scope);
  await expect(listSessionBranches(scope)).resolves.toMatchObject({
    status: "ok",
    branches: [{ active: true, headline: "new final answer", messageCount: 10 }],
  });
  expect(branchReads()).toBe(2);
});

it("lists current memory branches after writes and leaves missing sessions absent", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-memory-branches-") };
  const scope = {
    agentId,
    env,
    sessionId: "memory-branch-source",
    sessionKey: "agent:main:dashboard:incognito-branches",
    storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId, env }),
  };
  const owner = memorySessionActorOwners.get({ agentId, path: scope.storePath });
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey: scope.sessionKey },
    { assertCurrent() {}, assertReadable() {} },
  );
  try {
    const input = {
      entry: { sessionId: scope.sessionId, updatedAt: 1, incognito: true },
      transcriptEvents: [
        message("user-2", null, "user", "second prompt"),
        message("assistant-2", "user-2", "assistant", "second answer"),
      ],
    };
    const result = await actor.storage!.mutate(
      { type: "session.entry.create", input },
      { assertCurrent() {}, authorize() {} },
    );
    expect(result).toMatchObject({ kind: "committed" });
  } finally {
    await actor.release();
  }
  const branchReads = trackBranchSummaryReads();
  const sqlite = vi.spyOn(sqliteRuntime, "requireNodeSqlite").mockImplementation(() => {
    throw new Error("Memory branch listing opened SQLite");
  });
  try {
    expectBranch(await listSessionBranches(scope), "assistant-2", "second answer");
    await appendAnswer(scope, "fresh memory answer");
    expectBranch(await listSessionBranches(scope), "assistant-3", "fresh memory answer");
    await expect(
      listSessionBranches({ ...scope, sessionKey: "agent:main:dashboard:incognito-missing" }),
    ).resolves.toEqual({ status: "missing-session" });
    memorySessionActorOwners.closeDatabase(owner);
    await expect(listSessionBranches(scope)).resolves.toEqual({ status: "missing-session" });
    expect(sqlite).not.toHaveBeenCalled();
    expect(branchReads()).toBe(0);
  } finally {
    sqlite.mockRestore();
    memorySessionActorOwners.closeDatabase(owner);
  }
});

it("summarizes a large shared branch graph without repeated path walks", async () => {
  const env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("openclaw-large-branches-") };
  const sessionId = "large-branches-source";
  const scope = { agentId, env, sessionId, sessionKey };
  await upsertSessionEntryCore(scope, { sessionId, updatedAt: Date.now() });
  // Warmup uses replacement's resident reader; replacement still forces a fresh scan.
  openOpenClawAgentDatabase({ agentId, env });
  await expect(listSessionBranches(scope)).resolves.toEqual({ status: "ok", branches: [] });
  const events: Parameters<typeof replaceTranscriptEvents>[1] = [
    { type: "session", id: sessionId, version: 3 },
    message("orphan-user", "missing-ancestor", "user", "orphan prompt", {
      timestamp: "2026-08-30T00:00:01.000Z",
    }),
    message("orphan-assistant", "orphan-user", "assistant", "orphan answer", {
      timestamp: "2026-08-30T00:00:02.000Z",
    }),
  ];
  events.push(
    ...Array.from({ length: 12_554 }, (_, offset) => {
      const index = offset + 1;
      return message(
        `main-${index}`,
        index === 1 ? null : `main-${index - 1}`,
        index % 2 === 0 ? "assistant" : "user",
        `main ${index}`,
      );
    }),
    ...Array.from({ length: 1_360 }, (_, index) =>
      message(`side-${index + 1}`, "main-5376", "assistant", `side ${index + 1}`, {
        appendMode: "side",
      }),
    ),
  );
  events.push({
    type: "leaf",
    id: "active-leaf",
    parentId: "main-12554",
    targetId: "main-12554",
  });
  await replaceTranscriptEvents(scope, events);

  const startedAt = performance.now();
  const result = await listSessionBranches({ agentId, env, sessionKey });
  const elapsedMs = performance.now() - startedAt;
  assert.ok(result.status === "ok", "expected branch list result");
  expect(elapsedMs).toBeLessThan(1_000);
  expect(result.branches).toHaveLength(1_362);
  expect(result.branches.find((branch) => branch.leafEntryId === "orphan-assistant")).toEqual({
    ...makeBranch("orphan-assistant", "orphan answer", 2),
    updatedAt: "2026-08-30T00:00:02.000Z",
    active: false,
  });
}, 15_000);
