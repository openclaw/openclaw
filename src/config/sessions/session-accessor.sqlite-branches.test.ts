import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as sqliteRuntime from "../../infra/node-sqlite.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  appendTranscriptMessage,
  forkSessionAtMessage,
  listSessionBranches,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
  replaceTranscriptEvents,
  rewindSessionToMessage,
  switchSessionBranch,
  updateSessionEntry,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { readSessionBranchSummariesInWorker } from "./session-accessor.sqlite-branches.js";
import { replaceSessionEntryInDatabase } from "./session-accessor.sqlite-entry-mutation.js";
import {
  agentId,
  sessionKey,
  sourceExpectedState,
  useSessionMessageCutFixtures,
} from "./session-accessor.sqlite-message-cut.test-support.js";
import * as transcriptWatermark from "./session-accessor.sqlite-transcript-watermark-read.js";
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
  const { counts } = trackSqliteStatementExecutions(database.db, ["loads"], (sqlText) =>
    sqlText.includes('from "transcript_events"') && sqlText.includes('order by "seq" asc')
      ? "loads"
      : null,
  );
  return () => counts.loads;
}

function trackBranchSummaryReads(): () => number {
  const diagnostics = channel("openclaw.worker.task");
  let reads = 0;
  const record = (value: unknown) => {
    if (
      typeof value === "object" &&
      value !== null &&
      "worker" in value &&
      typeof value.worker === "string" &&
      value.worker.startsWith("session-transcript.worker")
    ) {
      reads++;
    }
  };
  diagnostics.subscribe(record);
  diagnosticCleanups.push(() => diagnostics.unsubscribe(record));
  return () => reads;
}

function observeNextBranchWorker(options: { holdResponse?: boolean } = {}) {
  const dispatched = createDeferredCore<Worker>();
  const response = createDeferredCore<unknown>();
  let releaseResponse = () => {};
  const postMessage: unknown = Object.getOwnPropertyDescriptor(
    Worker.prototype,
    "postMessage",
  )?.value;
  if (typeof postMessage !== "function") {
    throw new Error("expected Worker.postMessage to be an own method");
  }
  const spy = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    ...args: Parameters<Worker["postMessage"]>
  ) {
    const [message] = args;
    if (
      message &&
      typeof message === "object" &&
      "input" in message &&
      message.input &&
      typeof message.input === "object" &&
      "kind" in message.input &&
      message.input.kind === "branch-summaries" &&
      "taskId" in message
    ) {
      spy.mockRestore();
      if (options.holdResponse) {
        const emit = this.emit.bind(this);
        const emitSpy = vi.spyOn(this, "emit").mockImplementation((event, ...values: unknown[]) => {
          const value = values[0];
          if (
            event === "message" &&
            value &&
            typeof value === "object" &&
            "taskId" in value &&
            value.taskId === message.taskId
          ) {
            releaseResponse = () => {
              releaseResponse = () => {};
              emitSpy.mockRestore();
              emit(event, ...values);
            };
            response.resolve(value);
            return true;
          }
          return emit(event, ...values);
        });
      }
      Reflect.apply(postMessage, this, args);
      dispatched.resolve(this);
      return;
    }
    Reflect.apply(postMessage, this, args);
  });
  return {
    dispatched: dispatched.promise,
    response: response.promise,
    releaseResponse: () => releaseResponse(),
  };
}

describe("SQLite session branches", () => {
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

  it("rejects cached summaries when the lifecycle changes during cache validation", async () => {
    const { env, scope } = await createSession();
    await expect(listSessionBranches(scope)).resolves.toMatchObject({ status: "ok" });
    const readWatermark = transcriptWatermark.readSessionTranscriptHotWatermark;
    vi.spyOn(transcriptWatermark, "readSessionTranscriptHotWatermark").mockImplementationOnce(
      (database, sessionId) => {
        const watermark = readWatermark(database, sessionId);
        // Model a peer commit between selecting the session and delivering its cached summaries.
        runOpenClawAgentWriteTransaction(
          (writer) =>
            replaceSessionEntryInDatabase(writer, scope.sessionKey, {
              sessionId: scope.sessionId,
              updatedAt: 1,
              lifecycleRevision: "replacement-lifecycle",
            }),
          { agentId, env },
        );
        return watermark;
      },
    );
    await expect(listSessionBranches(scope)).resolves.toEqual({ status: "failed" });
  });

  it("reuses worker snapshot summaries across fresh readers and invalidates changed transcripts", async () => {
    const { env, scope } = await createSession();
    const database = openOpenClawAgentDatabase({ agentId, env });
    const databaseIdentity = readOpenClawAgentDatabaseIdentity(database).identity;
    if (typeof databaseIdentity !== "string") {
      throw new Error("expected a persisted branch fixture");
    }
    const request = {
      database: { agentId, path: database.path },
      databaseIdentity,
      sessionKey,
      ...sourceExpectedState,
    };
    await closeOpenClawAgentDatabaseByPathAsync(database.path, agentId);
    const counters: Array<{ loads: number; watermarks: number }> = [];
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
        diagnosticCleanups.push(tracked.restore);
      }
      return connection;
    });
    const rawLoads = () => counters.reduce((total, counter) => total + counter.loads, 0);
    const first = readSessionBranchSummariesInWorker(request);
    expect(first).toMatchObject({
      status: "ok",
      branches: expect.arrayContaining([
        expect.objectContaining({
          active: true,
          leafEntryId: "assistant-2",
          headline: "second answer",
          messageCount: 4,
        }),
      ]),
    });
    const watermarkReads = () => counters.reduce((total, counter) => total + counter.watermarks, 0);
    const beforeRepeatedReads = watermarkReads();
    for (let index = 0; index < 7; index++) {
      expect(readSessionBranchSummariesInWorker(request)).toEqual(first);
    }
    expect(rawLoads()).toBe(1);
    expect(watermarkReads() - beforeRepeatedReads).toBeGreaterThan(0);
    expect(watermarkReads() - beforeRepeatedReads).toBeLessThanOrEqual(7);
    if (first.status !== "ok" || !first.branches[0]) {
      throw new Error("expected worker branch summaries");
    }
    const original = structuredClone(first);
    first.branches[0].headline = "caller mutation";
    expect(readSessionBranchSummariesInWorker(request)).toEqual(original);
    expect(rawLoads()).toBe(1);

    await appendTranscriptMessage(scope, {
      eventId: "assistant-3",
      parentId: "assistant-2",
      message: { role: "assistant", content: "third answer" },
    });
    const appended = readSessionBranchSummariesInWorker(request);
    expect(appended).toMatchObject({
      status: "ok",
      branches: expect.arrayContaining([
        expect.objectContaining({
          active: true,
          leafEntryId: "assistant-3",
          headline: "third answer",
          messageCount: 5,
        }),
      ]),
    });
    expect(rawLoads()).toBe(2);
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
    expect(readSessionBranchSummariesInWorker(request)).toMatchObject({
      status: "ok",
      branches: expect.arrayContaining([
        expect.objectContaining({
          active: true,
          leafEntryId: "assistant-3",
          headline: "rewritten answer",
          messageCount: 5,
        }),
      ]),
    });
    expect(rawLoads()).toBe(3);
    expect(
      readSessionBranchSummariesInWorker({ ...request, lifecycleRevision: "stale-lifecycle" }),
    ).toEqual({ status: "failed" });
    expect(
      readSessionBranchSummariesInWorker({ ...request, databaseIdentity: "replaced-file" }),
    ).toEqual({ status: "failed" });
    expect(rawLoads()).toBe(3);
  });

  it("refuses cached worker summaries in cold storage and reuses them after restoration", async () => {
    const storePath = path.join(tempDirs.make("openclaw-branch-cold-"), "agent.sqlite");
    const fixture = await createSessionColdStorageFixture(storePath);
    await replaceSessionEntry(fixture.scope, { sessionId: historicalId, updatedAt: 1 });
    const database = openOpenClawAgentDatabase(fixture.options);
    const databaseIdentity = readOpenClawAgentDatabaseIdentity(database).identity;
    if (typeof databaseIdentity !== "string") {
      throw new Error("expected a persisted cold branch fixture");
    }
    const request = {
      database: { agentId, path: storePath },
      databaseIdentity,
      sessionKey: fixture.scope.sessionKey,
      sessionId: historicalId,
      lifecycleRevision: loadSessionEntry(fixture.scope)?.lifecycleRevision,
    };
    const first = readSessionBranchSummariesInWorker(request);
    expect(first).toMatchObject({
      status: "ok",
      branches: [
        {
          active: true,
          leafEntryId: "history-assistant",
          headline: "Preserved response",
          messageCount: 2,
        },
      ],
    });
    await expect(
      coldStorage.runSessionColdStorageMaintenance({ config: maintenanceConfig(storePath) }),
    ).resolves.toMatchObject({ archivedTranscripts: 1 });
    expect(() => readSessionBranchSummariesInWorker(request)).toThrow(
      expect.objectContaining({ code: "TRANSCRIPT_COLD" }),
    );
    await expect(listSessionBranches(fixture.scope)).resolves.toMatchObject({
      status: "ok",
      branches: [
        {
          active: true,
          leafEntryId: "history-assistant",
          headline: "Preserved response",
          messageCount: 2,
        },
      ],
    });
    expect(readSessionBranchSummariesInWorker(request)).toEqual(first);
  });

  it("revokes an in-flight branch read and joins worker exit before closing its database", async () => {
    const { env, scope } = await createSession();
    const database = openOpenClawAgentDatabase({ agentId, env });
    const observed = observeNextBranchWorker();
    const settlement: string[] = [];
    const reading = Promise.all(Array.from({ length: 3 }, () => listSessionBranches(scope))).then(
      (result) => {
        settlement.push("read");
        return result;
      },
    );
    const worker = await observed.dispatched;
    worker.once("exit", () => settlement.push("exit"));

    const closing = closeOpenClawAgentDatabaseByPathAsync(database.path, agentId).then((result) => {
      settlement.push("close");
      return result;
    });
    const duringClose = listSessionBranches(scope);
    try {
      await expect(reading).resolves.toEqual(
        Array.from({ length: 3 }, () => ({ status: "failed" })),
      );
      await expect(duringClose).resolves.toEqual({ status: "failed" });
      await expect(closing).resolves.toBe(true);
      expect(settlement[0]).toBe("exit");
      expect(settlement).toEqual(expect.arrayContaining(["read", "close"]));
      expect(database.db.isOpen).toBe(false);
    } finally {
      await Promise.allSettled([reading, duringClose, closing]);
    }

    await expect(listSessionBranches(scope)).resolves.toMatchObject({
      status: "ok",
      branches: expect.arrayContaining([
        expect.objectContaining({
          active: true,
          leafEntryId: "assistant-2",
          headline: "second answer",
        }),
      ]),
    });
  });

  it("refuses a completed branch snapshot when its session lifecycle changes before delivery", async () => {
    const { scope } = await createSession();
    const observed = observeNextBranchWorker({ holdResponse: true });
    const reading = Promise.all(Array.from({ length: 3 }, () => listSessionBranches(scope)));
    try {
      await expect(observed.response).resolves.toMatchObject({
        status: "ok",
        value: {
          ok: true,
          value: {
            status: "ok",
            branches: expect.arrayContaining([
              expect.objectContaining({
                active: true,
                leafEntryId: "assistant-2",
                headline: "second answer",
                messageCount: 4,
              }),
            ]),
          },
        },
      });
      // Only the session lifecycle changes; transcript rows and their watermark remain identical.
      await updateSessionEntry(scope, () => ({ lifecycleRevision: "replacement-lifecycle" }));
      const next = listSessionBranches(scope);
      observed.releaseResponse();
      await expect(reading).resolves.toEqual(
        Array.from({ length: 3 }, () => ({ status: "failed" })),
      );
      await expect(next).resolves.toMatchObject({
        status: "ok",
        branches: expect.arrayContaining([
          expect.objectContaining({
            active: true,
            leafEntryId: "assistant-2",
            headline: "second answer",
            messageCount: 4,
          }),
        ]),
      });
    } finally {
      observed.releaseResponse();
      await reading;
    }
  });

  it.each([false, true])(
    "reuses branch summaries with unchanged watermarks, writable handle closed=%s",
    async (closeWritable) => {
      const { env } = await createSession();
      const database = openOpenClawAgentDatabase({ agentId, env });
      if (closeWritable) {
        await closeOpenClawAgentDatabaseByPathAsync(database.path, agentId);
      }
      const branchReads = trackBranchSummaryReads();

      const first = await listSessionBranches({ agentId, env, sessionKey });
      expect(first).toMatchObject({
        status: "ok",
        branches: expect.arrayContaining([
          expect.objectContaining({
            active: true,
            leafEntryId: "assistant-2",
            headline: "second answer",
            messageCount: 4,
          }),
        ]),
      });
      expect(branchReads()).toBe(1);

      const second = await listSessionBranches({ agentId, env, sessionKey });
      expect(second).toEqual(first);
      expect(branchReads()).toBe(1);
      if (second.status !== "ok" || !second.branches[0]) {
        throw new Error("expected cached branch list result");
      }
      second.branches[0].headline = "caller mutation";

      await expect(listSessionBranches({ agentId, env, sessionKey })).resolves.toEqual(first);
      expect(branchReads()).toBe(1);
      if (closeWritable) {
        expect(isOpenClawAgentDatabaseOpen(database.path)).toBe(false);
      }
    },
  );

  it("reuses unchanged summaries across fifty active sessions without repeating worker reads", async () => {
    const { env } = await createSession();
    const scopes = [];
    for (let index = 0; index < 50; index++) {
      scopes.push(
        await createSiblingSession({
          env,
          sessionId: `viewer-${index}`,
          sessionKey: `agent:main:viewer-${index}`,
          headline: `Conversation ${index}`,
        }),
      );
    }
    const branchReads = trackBranchSummaryReads();
    for (let round = 0; round < 2; round++) {
      for (const scope of scopes) {
        await expect(listSessionBranches(scope)).resolves.toEqual({
          status: "ok",
          branches: [
            {
              active: true,
              leafEntryId: `${scope.sessionId}-user`,
              headline: scope.headline,
              messageCount: 1,
              updatedAt: "2026-07-18T01:00:01.000Z",
            },
          ],
        });
      }
      expect(branchReads()).toBe(scopes.length);
    }
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
    expect(branchReads()).toBe(2);
    expect(isOpenClawAgentDatabaseOpen(database.path)).toBe(false);
  });

  it("recomputes branch summaries after an append advances the watermark", async () => {
    const { env, scope } = await createSession();
    const branchReads = trackBranchSummaryReads();

    const before = await listSessionBranches({ agentId, env, sessionKey });
    expect(branchReads()).toBe(1);
    await appendTranscriptMessage(scope, {
      eventId: "assistant-3",
      message: { role: "assistant", content: "third answer" },
      now: Date.parse("2026-07-18T00:00:07.000Z"),
      parentId: "assistant-2",
    });

    const after = await listSessionBranches({ agentId, env, sessionKey });
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

      const result =
        mode === "rewind"
          ? await rewindSessionToMessage({
              agentId,
              env,
              entryId: "user-2",
              sessionKey,
            })
          : mode === "switch"
            ? await switchSessionBranch({
                agentId,
                env,
                leafEntryId: "off-path-user",
                sessionKey,
              })
            : await forkSessionAtMessage({
                agentId,
                env,
                entryId: "user-2",
                sessionKey,
                targetKey,
              });
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

  it("keeps branch summaries isolated between sessions in the same store", async () => {
    const { env } = await createSession();
    const sibling = await createSiblingSession({
      env,
      headline: "sibling prompt",
      sessionId: "message-cut-sibling",
      sessionKey: `${sessionKey}:sibling`,
    });
    const branchReads = trackBranchSummaryReads();

    const source = await listSessionBranches({ agentId, env, sessionKey });
    const other = await listSessionBranches(sibling);
    expect(branchReads()).toBe(2);
    expect(source.status).toBe("ok");
    if (source.status !== "ok") {
      throw new Error("expected source branch list result");
    }
    expect(source.branches.find((branch) => branch.active)).toMatchObject({
      leafEntryId: "assistant-2",
      headline: "second answer",
    });
    expect(other).toEqual({
      status: "ok",
      branches: [
        {
          active: true,
          headline: "sibling prompt",
          leafEntryId: "message-cut-sibling-user",
          messageCount: 1,
          updatedAt: "2026-07-18T01:00:01.000Z",
        },
      ],
    });
    await expect(listSessionBranches({ agentId, env, sessionKey })).resolves.toEqual(source);
    expect(branchReads()).toBe(2);
  });

  it("lists every DAG tip with active state, headline, count, and timestamp", async () => {
    const { env } = await createSession({ activeLeafTarget: "assistant-1" });

    await expect(listSessionBranches({ agentId, env, sessionKey })).resolves.toEqual({
      status: "ok",
      branches: [
        {
          leafEntryId: "assistant-1",
          headline: "first answer",
          messageCount: 2,
          updatedAt: "2026-07-18T00:00:02.000Z",
          active: true,
        },
        {
          leafEntryId: "off-path-user",
          headline: "inactive prompt",
          messageCount: 2,
          updatedAt: "2026-07-18T00:00:05.000Z",
          active: false,
        },
        {
          leafEntryId: "assistant-2",
          headline: "second answer",
          messageCount: 4,
          updatedAt: "2026-07-18T00:00:04.000Z",
          active: false,
        },
      ],
    });
  });

  it("keeps opaque payloads in the worker and refreshes phased Unicode headlines after a rewrite", async () => {
    const { env, scope } = await createSession();
    const opaque = "x".repeat(256 * 1024);
    const finalText = "🦞".repeat(130);
    const events = [
      { type: "session", id: scope.sessionId, version: 3 },
      {
        type: "message",
        id: "prompt",
        parentId: null,
        message: { role: "user", content: "prompt" },
      },
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

    await expect(listSessionBranches(scope)).resolves.toEqual({
      status: "ok",
      branches: [
        { active: true, headline: `${"🦞".repeat(119)}…`, leafEntryId: "tool-7", messageCount: 10 },
      ],
    });
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

  it("lists process-only incognito branches without opening a worker", async () => {
    const { scope } = await createSession({ incognito: true });
    const branchReads = trackBranchSummaryReads();
    await expect(listSessionBranches(scope)).resolves.toMatchObject({
      status: "ok",
      branches: expect.arrayContaining([
        expect.objectContaining({
          active: true,
          leafEntryId: "assistant-2",
          headline: "second answer",
        }),
      ]),
    });
    expect(branchReads()).toBe(0);
  });

  it("summarizes a large shared branch graph without repeated path walks", async () => {
    const stateDir = tempDirs.make("openclaw-large-branches-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const sessionId = "large-branches-source";
    const scope = { agentId, env, sessionId, sessionKey };
    await upsertSessionEntryCore(scope, { sessionId, updatedAt: Date.now() });
    const events: Parameters<typeof replaceTranscriptEvents>[1] = [
      {
        type: "session",
        id: sessionId,
        version: 3,
        timestamp: "2026-08-30T00:00:00.000Z",
      },
      {
        type: "message",
        id: "orphan-user",
        parentId: "missing-ancestor",
        timestamp: "2026-08-30T00:00:01.000Z",
        message: { role: "user", content: "orphan prompt" },
      },
      {
        type: "message",
        id: "orphan-assistant",
        parentId: "orphan-user",
        timestamp: "2026-08-30T00:00:02.000Z",
        message: { role: "assistant", content: "orphan answer" },
      },
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
    expect(result.branches.find((branch) => branch.leafEntryId === "orphan-assistant")).toEqual({
      leafEntryId: "orphan-assistant",
      headline: "orphan answer",
      messageCount: 2,
      updatedAt: "2026-08-30T00:00:02.000Z",
      active: false,
    });
  }, 15_000);
});
