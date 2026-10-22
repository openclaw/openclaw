import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  branchMessage,
  branchSummary as summary,
  expectBranchList,
} from "./session-accessor.sqlite-branch-fixtures.test-support.js";
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
import { maintenanceLane, rotateDatabaseWorkers } from "./session-transcript-worker-resources.js";

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
    (sqlText) =>
      sqlText.includes('from "transcript_events"') && sqlText.includes('order by "seq" asc')
        ? "loads"
        : null,
  );
  return () => counts.loads;
}

function trackBranchSummaryReads(): () => number {
  let reads = 0;
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply preserves the worker receiver.
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

function expectActiveBranch(
  result: unknown,
  leafEntryId: string,
  headline: string,
  messageCount?: number,
) {
  expect(result).toMatchObject({
    status: "ok",
    branches: expect.arrayContaining([
      expect.objectContaining({
        active: true,
        leafEntryId,
        headline,
        ...(messageCount === undefined ? {} : { messageCount }),
      }),
    ]),
  });
}

describe("SQLite session branches", () => {
  it("retains a cold branch reader across concurrent viewers and transcript writes", async () => {
    const { env, scope } = await createSession();
    const sibling = await createSiblingSession({
      env,
      sessionId: "branch-reader-sibling",
      sessionKey: "agent:main:branch-reader-sibling",
      headline: "Sibling conversation",
    });
    await rotateDatabaseWorkers(maintenanceLane);
    const rotations = vi.spyOn(maintenanceLane.pool, "rotate");
    const scopes = [scope, sibling];
    const before = await Promise.all(scopes.map(listSessionBranches));
    expect(before).toEqual([
      expect.objectContaining({ status: "ok" }),
      { status: "ok", branches: [expect.objectContaining({ headline: "Sibling conversation" })] },
    ]);

    await appendTranscriptMessage(sibling, {
      eventId: "branch-reader-answer",
      parentId: "branch-reader-sibling-user",
      message: { role: "assistant", content: "Updated sibling answer" },
    });
    const after = await Promise.all(scopes.map(listSessionBranches));
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual({
      status: "ok",
      branches: [
        expect.objectContaining({
          headline: "Updated sibling answer",
          leafEntryId: "branch-reader-answer",
          messageCount: 2,
        }),
      ],
    });
    expect(rotations).not.toHaveBeenCalled();
  });

  it("coalesces concurrent viewers and skips restoration for unchanged summaries", async () => {
    const { scope } = await createSession();
    const branchReads = trackBranchSummaryReads();
    const restore = vi.spyOn(coldStorage, "restoreSessionColdTranscript");
    const results = await Promise.all(Array.from({ length: 3 }, () => listSessionBranches(scope)));
    expect(results[0]).toMatchObject({ status: "ok" });
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    const second = results[1];
    if (second?.status !== "ok" || !second.branches[0]) {
      throw new Error("expected shared branch summaries");
    }
    second.branches[0].headline = "caller mutation";
    expect(results[2]).toEqual(results[0]);
    await expect(listSessionBranches(scope)).resolves.toEqual(results[0]);
    expect(branchReads()).toBe(1);
    expect(restore).not.toHaveBeenCalled();
  });

  it("carries summaries between read snapshots and invalidates changed transcripts", async () => {
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
          (sqlText) => {
            if (
              (sqlText.includes('from "transcript_events"') && sqlText.includes("max(")) ||
              sqlText.includes('from "transcript_rewrite_watermarks"')
            ) {
              return "watermarks";
            }
            return sqlText.includes('from "transcript_events"') &&
              sqlText.includes('order by "seq" asc')
              ? "loads"
              : null;
          },
        );
        counters.push(tracked.counts);
        rowCounters.push(tracked.rowCounts);
        diagnosticCleanups.push(tracked.restore);
      }
      return connection;
    });
    const rawLoads = () => counters.reduce((total, counter) => total + counter.loads, 0);
    const first = readSessionBranchSummariesInWorker(request);
    expectActiveBranch(first, "assistant-2", "second answer", 4);
    if (first.status !== "ok" || !first.branches[0]) {
      throw new Error("expected worker branch summaries");
    }
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
    await appendTranscriptMessage(scope, {
      eventId: "assistant-3",
      parentId,
      message: { role: "assistant", content: "third answer" },
    });
    const appended = readSessionBranchSummariesInWorker(request);
    expectActiveBranch(appended, "assistant-3", "third answer", 5);
    expect(rawLoads()).toBe(2);
    expect(
      rowCounters.reduce((total, counter) => total + counter.loads, 0) - rowsBeforeAppend,
    ).toBeLessThanOrEqual(5);
    const events = await loadTranscriptEvents(scope);
    await replaceTranscriptEvents(
      scope,
      events.map((event) =>
        event && typeof event === "object" && "id" in event && event.id === "assistant-3"
          ? Object.assign({}, event, {
              message: { role: "assistant", content: "rewritten answer" },
            })
          : event,
      ),
    );
    await waitForSessionTranscriptIndexReconcilesInStateDir(env.OPENCLAW_STATE_DIR);
    expectActiveBranch(
      readSessionBranchSummariesInWorker(request),
      "assistant-3",
      "rewritten answer",
      5,
    );
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
    const branches = [summary("history-assistant", "Preserved response", 2, true)];
    expect(first).toMatchObject({ status: "ok", branches });
    await expect(
      coldStorage.runSessionColdStorageMaintenance({ config: maintenanceConfig(storePath) }),
    ).resolves.toMatchObject({ archivedTranscripts: 1 });
    expect(() => readSessionBranchSummariesInWorker(request)).toThrow(
      expect.objectContaining({ code: "TRANSCRIPT_COLD" }),
    );
    await expect(listSessionBranches(fixture.scope)).resolves.toMatchObject({
      status: "ok",
      branches,
    });
    expect(readSessionBranchSummariesInWorker(request)).toEqual(first);
  });

  it("recomputes summaries after physical database replacement with identical watermarks", async () => {
    const { env } = await createSession();
    const database = openOpenClawAgentDatabase({ agentId, env });
    const branchReads = trackBranchSummaryReads();
    const first = await listSessionBranches({ agentId, env, sessionKey });
    expect(first.status).toBe("ok");
    expect(branchReads()).toBe(1);

    // Canonical close drains readers and checkpoints WAL before copying the complete database.
    await closeOpenClawAgentDatabaseByPathAsync(database.path, agentId);
    const replacement = `${database.path}.replacement`;
    fs.copyFileSync(database.path, replacement);
    fs.renameSync(replacement, database.path);

    await expect(listSessionBranches({ agentId, env, sessionKey })).resolves.toEqual(first);
    expect(branchReads()).toBe(2);
    await expect(listSessionBranches({ agentId, env, sessionKey })).resolves.toEqual(first);
    // The retained reader keeps the replacement's admission valid for the host cache.
    expect(branchReads()).toBe(2);
    expect(isOpenClawAgentDatabaseOpen(database.path)).toBe(false);
  });

  it("refreshes appended and replaced sessions without main-thread SQL", async () => {
    const { env, scope } = await createSession();
    const replacement = await createSiblingSession({
      env,
      sessionId: "replacement-source",
      sessionKey: "agent:main:replacement-source",
      headline: "replacement conversation",
    });
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

    const before = await listSessionBranches({ agentId, env, sessionKey });
    expect(branchReads()).toBe(1);
    expect(tracked.counts.statements).toBe(0);
    expect(nativeOpen).not.toHaveBeenCalled();
    await appendTranscriptMessage(scope, {
      eventId: "assistant-3",
      message: { role: "assistant", content: "third answer" },
      now: Date.parse("2026-07-18T00:00:07.000Z"),
      parentId: "assistant-2",
    });

    await waitForSessionTranscriptIndexReconcilesInStateDir(env.OPENCLAW_STATE_DIR);
    const statementsAfterAppend = tracked.counts.statements;
    nativeOpen.mockClear();
    const after = await listSessionBranches({ agentId, env, sessionKey });
    expect(tracked.counts.statements).toBe(statementsAfterAppend);
    expect(nativeOpen).not.toHaveBeenCalled();
    expect(branchReads()).toBe(2);
    expect(after).not.toEqual(before);
    expect(after.status).toBe("ok");
    if (after.status !== "ok") {
      throw new Error("expected branch list result");
    }
    expect(after.branches.find((branch) => branch.active)).toMatchObject({
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
    expect(tracked.counts.statements).toBe(statementsAfterReplacement);
    expect(nativeOpen).not.toHaveBeenCalled();
  });

  it.each(["rewind", "switch", "fork"] as const)(
    "%s invalidates the source cache and lists the resulting branch",
    async (mode) => {
      const { env, scope } = await createSession();
      const aliasKey = `${sessionKey}:alias`;
      const targetKey = `${sessionKey}:fork`;
      const sourceEntry = loadSessionEntry(scope);
      if (!sourceEntry) {
        throw new Error("expected source session entry");
      }
      await upsertSessionEntryCore({ agentId, env, sessionKey: aliasKey }, sourceEntry);
      const branchReads = trackBranchSummaryReads();
      await listSessionBranches({ agentId, env, sessionKey });

      const source = { agentId, env, sessionKey };
      const result =
        mode === "rewind"
          ? await rewindSessionToMessage({ ...source, entryId: "user-2" })
          : mode === "switch"
            ? await switchSessionBranch({ ...source, leafEntryId: "off-path-user" })
            : await forkSessionAtMessage({ ...source, entryId: "user-2", targetKey });
      expect(result.status).toBe("created");

      const readsBeforeAliasRead = branchReads();
      await listSessionBranches({ agentId, env, sessionKey: aliasKey });
      expect(branchReads()).toBe(readsBeforeAliasRead + 1);

      const listed = await listSessionBranches({
        agentId,
        env,
        sessionKey: mode === "fork" ? targetKey : sessionKey,
      });
      expect(listed.status).toBe("ok");
      if (listed.status !== "ok") {
        throw new Error("expected branch list result");
      }
      expect(listed.branches.find((branch) => branch.active)).toMatchObject({
        leafEntryId: mode === "switch" ? "off-path-user" : "assistant-1",
      });
    },
  );

  it("keeps opaque payloads in the worker and refreshes phased Unicode headlines after a rewrite", async () => {
    const { env, scope } = await createSession();
    const opaque = "x".repeat(256 * 1024);
    const finalText = "🦞".repeat(130);
    const events = [
      { type: "session", id: scope.sessionId, version: 3 },
      branchMessage("prompt", null, "prompt"),
      {
        type: "message",
        id: "answer",
        parentId: "prompt",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "commentary",
              textSignature: JSON.stringify({ v: 1, phase: "commentary" }),
            },
            { type: "text", text: "legacy text" },
            {
              type: "output_text",
              text: finalText,
              textSignature: JSON.stringify({ v: 1, phase: "final_answer" }),
            },
          ],
          providerReplay: { opaque },
        },
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        type: "message",
        id: `tool-${index}`,
        parentId: index === 0 ? "answer" : `tool-${index - 1}`,
        message: {
          role: "toolResult",
          toolCallId: `call-${index}`,
          content: opaque,
          details: { opaque },
        },
      })),
    ];
    await replaceTranscriptEvents(scope, events);
    await waitForSessionTranscriptProjection(scope);
    const fullTranscriptLoads = trackFullTranscriptLoads(env);
    const branchReads = trackBranchSummaryReads();

    await expectBranchList(scope, [summary("tool-7", `${"🦞".repeat(119)}…`, 10, true)]);
    expect(fullTranscriptLoads()).toBe(0);
    expect(branchReads()).toBe(1);

    await replaceTranscriptEvents(
      scope,
      events.map((event) =>
        event.id === "answer"
          ? Object.assign({}, event, {
              message: { role: "assistant", content: "new final answer" },
            })
          : event,
      ),
    );
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
      expect(
        await actor.storage!.mutate(
          {
            type: "session.entry.create",
            input: {
              entry: { sessionId: scope.sessionId, updatedAt: 1, incognito: true },
              transcriptEvents: [
                branchMessage("user-2", null, "second prompt"),
                branchMessage("assistant-2", "user-2", "second answer", { role: "assistant" }),
              ],
            },
          },
          { assertCurrent() {}, authorize() {} },
        ),
      ).toMatchObject({ kind: "committed" });
    } finally {
      await actor.release();
    }
    const branchReads = trackBranchSummaryReads();
    const sqlite = vi.spyOn(sqliteRuntime, "requireNodeSqlite").mockImplementation(() => {
      throw new Error("Memory branch listing opened SQLite");
    });
    try {
      expectActiveBranch(await listSessionBranches(scope), "assistant-2", "second answer");
      await appendTranscriptMessage(scope, {
        eventId: "assistant-3",
        parentId: "assistant-2",
        now: Date.parse("2026-07-18T00:00:07.000Z"),
        message: { role: "assistant", content: "fresh memory answer" },
      });
      expectActiveBranch(await listSessionBranches(scope), "assistant-3", "fresh memory answer");
      await expect(
        listSessionBranches({
          ...scope,
          sessionKey: "agent:main:dashboard:incognito-missing",
        }),
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
    const stateDir = tempDirs.make("openclaw-large-branches-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const sessionId = "large-branches-source";
    const scope = { agentId, env, sessionId, sessionKey };
    await upsertSessionEntryCore(scope, { sessionId, updatedAt: Date.now() });
    // Match replacement's resident writer so warmup and measurement use the maintenance reader.
    // Replacement below still forces a fresh graph scan.
    openOpenClawAgentDatabase({ agentId, env });
    await expectBranchList(scope, []);
    const events: Parameters<typeof replaceTranscriptEvents>[1] = [
      {
        type: "session",
        id: sessionId,
        version: 3,
        timestamp: "2026-08-30T00:00:00.000Z",
      },
      branchMessage("orphan-user", "missing-ancestor", "orphan prompt", {
        timestamp: "2026-08-30T00:00:01.000Z",
      }),
      branchMessage("orphan-assistant", "orphan-user", "orphan answer", {
        role: "assistant",
        timestamp: "2026-08-30T00:00:02.000Z",
      }),
    ];
    for (let index = 1; index <= 12_554; index += 1) {
      events.push({
        type: "message",
        id: `main-${index}`,
        parentId: index === 1 ? null : `main-${index - 1}`,
        timestamp: new Date(Date.UTC(2026, 7, 30, 0, 0, index)).toISOString(),
        message: { role: index % 2 === 0 ? "assistant" : "user", content: `main ${index}` },
      });
    }
    for (let index = 1; index <= 1_360; index += 1) {
      events.push({
        type: "message",
        id: `side-${index}`,
        parentId: "main-5376",
        appendMode: "side",
        timestamp: new Date(Date.UTC(2026, 7, 30, 1, 0, index)).toISOString(),
        message: { role: "assistant", content: `side ${index}` },
      });
    }
    events.push({
      type: "leaf",
      id: "active-leaf",
      parentId: "main-12554",
      targetId: "main-12554",
      timestamp: "2026-08-30T02:00:02.000Z",
    });
    await replaceTranscriptEvents(scope, events);

    const startedAt = performance.now();
    const result = await listSessionBranches({ agentId, env, sessionKey });
    const elapsedMs = performance.now() - startedAt;
    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      throw new Error("expected branch list result");
    }
    expect(elapsedMs).toBeLessThan(1_000);
    expect(result.branches).toHaveLength(1_362);
    expect(result.branches.find((branch) => branch.leafEntryId === "orphan-assistant")).toEqual(
      summary("orphan-assistant", "orphan answer", 2, false, "2026-08-30T00:00:02.000Z"),
    );
  }, 15_000);
});
