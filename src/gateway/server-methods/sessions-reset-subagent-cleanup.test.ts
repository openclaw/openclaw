import path from "node:path";
import type { WorkerOptions } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  listRegisteredAgentHarnesses,
  registerAgentHarness,
} from "../../agents/harness/registry.js";
import { restoreRegisteredAgentHarnesses } from "../../agents/harness/registry.test-support.js";
import * as completionOwner from "../../agents/subagents/registry/subagent-registry-lifecycle-completion.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "../../agents/subagents/registry/subagent-registry-publication.js";
import { loadSubagentRegistryFromSqlite } from "../../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import {
  cleanupSubagentRegistryPersistenceTest,
  settleSubagentRegistryPersistenceWork,
} from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import {
  registerSubagentRun,
  claimSubagentRunKill,
  initSubagentRegistry,
  settleFailedQueuedSubagentLaunch,
  resetSubagentRegistryForTests,
  testing,
  withSubagentKillOwner,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { waitForCollectorCompletion } from "../../agents/tools/agents-wait-tool.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import * as sessionLifecycleOwner from "../../config/sessions/session-accessor.sqlite-lifecycle.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { beginSessionEffect } from "../../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesForTest,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import type { callGateway } from "../call.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { performGatewaySessionReset } from "../session-reset-service.js";
import { sessionDeleteHandlers } from "./sessions-delete.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";

const writeFault = vi.hoisted(() => new Int32Array(new SharedArrayBuffer(4)));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  // TEMP triggers belong on the admitted writer connection, including an already warm worker.
  const preload = `
    import { DatabaseSync } from "node:sqlite";
    import { workerData } from "node:worker_threads";
    const fault = new Int32Array(workerData.resetCleanupFault);
    const installed = new WeakSet();
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function(sql) {
      const registry = sql.startsWith('insert into "subagent_runs"');
      const reset = sql.startsWith('update "session_nodes"') || sql.startsWith('insert into "session_nodes"');
      if ((registry || reset) && !installed.has(this)) {
        this.function('reset_cleanup_fault', () => Atomics.load(fault, 0));
        this.exec(registry
          ? "CREATE TEMP TRIGGER reject_revocation BEFORE UPDATE ON main.subagent_runs " +
            "WHEN reset_cleanup_fault() = 1 AND NEW.run_id = 'reset-cleanup-run' " +
            "AND json_extract(NEW.payload_json, '$.execution.suppressSessionEffects') = 1 " +
            "BEGIN SELECT RAISE(ABORT, 'revocation write rejected'); END"
          : "CREATE TEMP TRIGGER reject_reset BEFORE UPDATE ON main.session_nodes " +
            "WHEN reset_cleanup_fault() = 2 AND NEW.session_key = 'agent:main:subagent:reset-cleanup' " +
            "AND json_extract(NEW.entry_json, '$.lifecycleRevision') != json_extract(OLD.entry_json, '$.lifecycleRevision') " +
            "BEGIN SELECT RAISE(ABORT, 'reset store rejected'); END");
        installed.add(this);
      }
      return prepare.call(this, sql);
    };
  `;
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: WorkerOptions) {
        super(
          filename,
          String(filename).includes("sqlite-store.worker")
            ? {
                ...options,
                workerData: { ...options?.workerData, resetCleanupFault: writeFault.buffer },
                execArgv: [
                  ...(options?.execArgv ?? []),
                  "--import",
                  `data:text/javascript,${encodeURIComponent(preload)}`,
                ],
              }
            : options,
        );
      }
    },
  };
});

const registryGateway = vi.hoisted(() => vi.fn<typeof callGateway>());
vi.mock("../server-recovery-runtime-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server-recovery-runtime-context.js")>()),
  bindGatewayLifecycleRequest: () => registryGateway,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let stateDir: string;
let cfg: OpenClawConfig;
const env = captureEnv(["OPENCLAW_STATE_DIR"]);
const key = "agent:main:subagent:reset-cleanup";
const runId = "reset-cleanup-run";
const originalSessionId = "reset-cleanup-session";
const requesterSessionKey = "agent:main:main";
const launchError = "launch failed";
const readSession = () => loadSessionEntry({ sessionKey: key });
const storedRun = (id: string) => loadSubagentRegistryFromSqlite().get(id);
const sessionEntry = (
  sessionId: string,
  lifecycleRevision = sessionId,
  incognito = false,
): SessionEntry => ({
  sessionId,
  lifecycleRevision,
  updatedAt: Date.now(),
  ...(incognito ? { incognito: true as const } : {}),
});
let attempts = 0;
let harnesses: ReturnType<typeof listRegisteredAgentHarnesses>;

function replaceOriginal(revision: string) {
  replaceSessionEntrySync(
    { sessionKey: key, agentId: "main" },
    sessionEntry(originalSessionId, revision),
  );
}

function expectSuppression(id: string, suppressed: boolean) {
  expect(storedRun(id)?.execution.suppressSessionEffects === true).toBe(suppressed);
}

async function sweepAndExpectSession(expected: ReturnType<typeof readSession>, retries?: number) {
  await testing.sweepOnceForTests();
  expect(readSession()).toEqual(expected);
  if (retries !== undefined) {
    expect(attempts).toBe(retries);
  }
}

async function request(
  method: "sessions.reset" | "sessions.delete",
  params: Record<string, unknown> = { key },
) {
  const handler = expectDefined(
    (method === "sessions.reset" ? sessionMutationHandlers : sessionDeleteHandlers)[method],
    "session handler",
  );
  let result: unknown;
  await handler({
    req: { type: "req", id: method, method, params },
    params,
    client: null,
    isWebchatConnect: () => false,
    context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
    respond: (ok, payload, error) => {
      if (!ok) {
        throw new GatewayClientRequestError(error ?? { message: "request failed" });
      }
      result = payload;
    },
  });
  return result;
}

beforeEach(async () => {
  stateDir = tempDirs.make("openclaw-reset-cleanup-");
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  cfg = { agents: { entries: { main: { workspace: stateDir } } } };
  setRuntimeConfigSnapshot(cfg);
  await resetSubagentRegistryForTests({ persist: false });
  attempts = 0;
  harnesses = listRegisteredAgentHarnesses();
  registryGateway.mockReset().mockImplementation(async (options) => {
    expect(options.method).toBe("sessions.delete");
    if (++attempts === 1) {
      throw new Error("first delete transport unavailable");
    }
    return await request("sessions.delete", options.params as Record<string, unknown>);
  });
  replaceOriginal("original");
  await registerCollector(runId);
  expect(await settleFailedQueuedSubagentLaunch(runId, launchError)).toBe(true);
  await testing.sweepOnceForTests();
  expect(attempts).toBe(1);
  expect(storedRun(runId)?.collectorLaunchCleanupPending).toBe(true);
  expect(readSession()?.lifecycleRevision).toBe("original");
});

async function registerCollector(id: string, sessionKey = key, agentId = "main", collect = true) {
  await registerSubagentRun({
    runId: id,
    childSessionKey: sessionKey,
    childAgentId: agentId,
    sessionEntry: loadSessionEntry({
      ...(collect ? { storePath: cfg.session?.store } : {}),
      agentId,
      sessionKey,
    }),
    requesterSessionKey,
    requesterAgentId: "main",
    requesterDisplayKey: "main",
    task: collect ? "failed collector launch" : "announced subagent",
    cleanup: "delete",
    queued: true,
    expectsCompletionMessage: !collect,
    ...(collect
      ? {
          collect: true,
          groupId: "reset-cleanup-group",
          swarmRequesterSessionKey: requesterSessionKey,
        }
      : {}),
  });
}

afterEach(async () => {
  Atomics.store(writeFault, 0, 0);
  // Preserve failures from the accepted prefix before imports can retire their entries.
  try {
    await settleSubagentRegistryPersistenceWork();
  } finally {
    vi.restoreAllMocks();
    restoreRegisteredAgentHarnesses(harnesses);
  }
  await cleanupSubagentRegistryPersistenceTest({
    stateDir,
    resetRegistry: () => resetSubagentRegistryForTests({ persist: false }),
    closeDatabases: () => {
      memorySessionActorOwners.closeDatabase({
        agentId: "worker",
        path: resolveIncognitoOpenClawAgentSqlitePath({
          agentId: "worker",
          env: { OPENCLAW_STATE_DIR: stateDir },
        }),
      });
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
    },
  });
  registryGateway.mockReset();
  clearRuntimeConfigSnapshot();
  env.restore();
});

test.each([false, true])("collector cleanup retry after reset: %s", async (reset) => {
  if (reset) {
    await reopen();
    await request("sessions.reset");
    expect(readSession()?.lifecycleRevision).not.toBe("original");
  }
  const beforeRetry = readSession();
  if (reset) {
    await reopen();
  }
  await sweepAndExpectSession(reset ? beforeRetry : undefined, reset ? 1 : 2);
  await expectResultRetained();
});

async function reopen() {
  await resetSubagentRegistryForTests({ persist: false });
  await cleanupSessionStateForTest({ stateDir });
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await initSubagentRegistry();
}

async function expectResultRetained() {
  expect(storedRun(runId)?.collectorLaunchCleanupPending).toBe(false);
  await expect(
    waitForCollectorCompletion({
      runId,
      currentSessionKeys: new Set([requesterSessionKey]),
      currentAgentId: "main",
      config: cfg,
    }),
  ).resolves.toMatchObject({ runId, status: "failed", result: launchError, error: launchError });
}

test.each([
  [1, "revocation write rejected", false, 2],
  [2, "reset store rejected", true, 1],
] as const)("reset write failure: %s (%s)", async (fault, error, revoked, retries) => {
  Atomics.store(writeFault, 0, fault);
  const before = readSession();
  await expect(request("sessions.reset")).rejects.toThrow(error);
  if (!revoked) {
    expect(readSession()).toEqual(before);
    expect(subagentRuns.get(runId)?.execution.suppressSessionEffects).not.toBe(true);
  }
  Atomics.store(writeFault, 0, 0);
  expectSuppression(runId, revoked);
  await reopen();
  await sweepAndExpectSession(revoked ? before : undefined, retries);
  await expectResultRetained();
});

test("postcommit failure cannot restore cleanup authority after a successful reset", async () => {
  await expect(
    performGatewaySessionReset({
      key,
      reason: "reset",
      commandSource: "test",
      workerPlacementContext: {},
      onCommitted: () => {
        throw new Error("reset response lost");
      },
    }),
  ).rejects.toThrow("reset response lost");
  const successor = readSession();
  expect(successor?.lifecycleRevision).not.toBe("original");
  await reopen();
  await sweepAndExpectSession(successor, 1);
  await expectResultRetained();
});

function installResetHarness(reset: () => Promise<void>) {
  registerAgentHarness({
    id: "reset-cleanup-race",
    label: "Reset cleanup race",
    supports: () => ({ supported: false }),
    runAttempt: async () => {
      throw new Error("not used");
    },
    reset,
  });
}

async function startCollector(id: string) {
  await registerCollector(id);
  await emitSubagentStart(id);
}

function emitLifecycle(id: string, data: Parameters<typeof emitAgentEvent>[0]["data"]) {
  emitAgentEvent({ runId: id, stream: "lifecycle", data });
}

async function emitSubagentStart(id: string) {
  emitLifecycle(id, { phase: "start", startedAt: Date.now() });
  await waitForRegistryPublication(() => subagentRuns.get(id)?.execution.status === "running");
  expect(subagentRuns.get(id)?.execution.status).toBe("running");
}

async function waitForRegistryPublication(isPublished: () => boolean) {
  const published = createDeferredCore();
  const check = () => {
    if (isPublished()) {
      published.resolve();
    }
  };
  const unsubscribe = subscribeSubagentRunChanges("persistence", check);
  try {
    check();
    await published.promise;
  } finally {
    unsubscribe();
  }
}

test("same-turn reset keeps its active continuation unsuppressed", async () => {
  const activeId = "active-continuation";
  const interrupt = vi.fn();
  let admission: Awaited<ReturnType<typeof beginSessionEffect>> | undefined;
  try {
    await startCollector(activeId);
    await settleSubagentRegistryPersistenceWork();
    admission = await beginSessionEffect({
      scope: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      identities: [key, originalSessionId],
      assertAllowed: () => {},
      onInterrupt: interrupt,
    });
    await admission.run(() => request("sessions.reset"));
    expect(admission.isActive()).toBe(true);
    expect(interrupt).not.toHaveBeenCalled();
    expect(subagentRuns.get(activeId)?.execution).toMatchObject({ status: "running" });
    expectSuppression(activeId, false);
    expectSuppression(runId, true);
    await settleSubagentRegistryPersistenceWork();
  } finally {
    admission?.release();
    await settleSubagentRegistryPersistenceWork();
  }
});

test.each(["new", "replacement"])("reset preserves %s active owner", async (mode) => {
  const original = expectDefined(subagentRuns.get(runId), "registered collector");
  const activeId = mode === "replacement" ? runId : "new-active-owner";
  installResetHarness(() => startCollector(activeId));
  await request("sessions.reset");
  expect(subagentRuns.get(activeId)?.execution.status).toBe("running");
  expectSuppression(activeId, false);
  if (mode === "replacement") {
    expect(subagentRuns.get(runId)).not.toBe(original);
    expect(original.execution.suppressSessionEffects).not.toBe(true);
  }
});

test("a changed session generation skips revocation together with reset", async () => {
  installResetHarness(async () => {
    replaceOriginal("replacement");
  });
  await request("sessions.reset");
  expect(readSession()?.lifecycleRevision).toBe("replacement");
  expectSuppression(runId, false);
});

test("revocation rechecks terminal owners after awaited entry planning", async () => {
  const id = "late-terminal-owner";
  await registerCollector(id);
  let settled = false;
  let settlement: Promise<{ value: boolean } | { error: unknown }> | undefined;
  const unsubscribe = subscribeSubagentRunChanges("persistence", () => {
    if (!settled && subagentRuns.get(runId)?.execution.suppressSessionEffects) {
      settled = true;
      queueMicrotask(() => {
        settlement = settleFailedQueuedSubagentLaunch(id, "late launch failed").then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      });
    }
  });
  const reset = sessionLifecycleOwner.resetSessionEntryLifecycle;
  vi.spyOn(sessionLifecycleOwner, "resetSessionEntryLifecycle").mockImplementation((params) =>
    reset({
      ...params,
      buildNextEntry: async (current) => {
        const next = await params.buildNextEntry(current);
        await settlement;
        return next;
      },
    }),
  );
  try {
    await request("sessions.reset");
    expect(settled).toBe(true);
    expect(await settlement).toEqual({ value: true });
    expectSuppression(id, true);
  } finally {
    unsubscribe();
    await settlement;
  }
});

test.each([false, true])("custom-store worker reset (incognito: %s)", async (incognito) => {
  await testing.sweepOnceForTests();
  expect(storedRun(runId)?.collectorLaunchCleanupPending).toBe(false);
  const agentId = "worker";
  cfg = {
    agents: { entries: { main: { workspace: stateDir }, worker: { workspace: stateDir } } },
    session: { store: path.join(stateDir, "custom-sessions.json") },
  };
  setRuntimeConfigSnapshot(cfg);
  const childSessionKey = incognito
    ? `agent:${agentId}:dashboard:incognito-scoped-cleanup`
    : `agent:${agentId}:subagent:scoped-cleanup`;
  const scope = {
    agentId,
    sessionKey: childSessionKey,
    storePath: expectDefined(cfg.session?.store, "custom store"),
  };
  const id = "scoped-collector";
  const siblingKey = "agent:main:subagent:scoped-cleanup";
  await replaceSessionEntry(scope, sessionEntry("scoped-original", "scoped-original", incognito));
  replaceSessionEntrySync(
    { ...scope, agentId: "main", sessionKey: siblingKey },
    sessionEntry("sibling"),
  );
  await registerCollector(id, childSessionKey, agentId);
  expect(await settleFailedQueuedSubagentLaunch(id, "scoped launch failed")).toBe(true);
  attempts = 0;
  await testing.sweepOnceForTests();
  expect(attempts).toBe(1);
  await request("sessions.reset", { key: childSessionKey, agentId });
  expectSuppression(id, true);
  if (incognito) {
    expect(loadSessionEntry(scope)).toBeUndefined();
    await replaceSessionEntry(scope, sessionEntry("private-successor", "private-successor", true));
  }
  const successor = loadSessionEntry(scope);
  expect(successor?.lifecycleRevision).not.toBe("scoped-original");
  await testing.sweepOnceForTests();
  expect(loadSessionEntry(scope)).toEqual(successor);
  expect(attempts).toBe(1);
  expect(loadSessionEntry({ ...scope, agentId: "main", sessionKey: siblingKey })?.sessionId).toBe(
    "sibling",
  );
});

test("reset cannot publish while a terminal completion owns an awaited capture", async () => {
  const completion = vi.spyOn(completionOwner, "completeSubagentRunAttempt");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const announce = await import("../../agents/subagents/announce/subagent-announce.js");
  const capture = announce.captureSubagentCompletionReply;
  const callGateway = expectDefined(registryGateway.getMockImplementation(), "cleanup transport");
  const deletionStarted = createDeferredCore<{ completion: Promise<unknown> }>();
  registryGateway.mockImplementation((options) => {
    const deletionPromise = callGateway(options);
    if (options.method === "sessions.delete") {
      deletionStarted.resolve({ completion: deletionPromise });
    }
    return deletionPromise;
  });
  vi.spyOn(announce, "captureSubagentCompletionReply").mockImplementation(async (...args) => {
    entered.resolve();
    await release.promise;
    return await capture(...args);
  });
  const id = "completing-owner";
  await startCollector(id);
  // Leave producer metadata absent to hold the completion lock during transcript capture.
  emitLifecycle(id, { phase: "end", endedAt: Date.now() });
  await entered.promise;
  const original = readSession();
  try {
    await expect(request("sessions.reset")).rejects.toThrow(/completion.*settling/i);
    expect(readSession()).toEqual(original);
    expectSuppression(id, false);
  } finally {
    release.resolve();
    await expectDefined(completion.mock.results[0]?.value, "completion attempt");
    const deletion = await deletionStarted.promise;
    await deletion.completion;
    await settleSubagentRegistryPersistenceWork();
  }
});

test.each([false, true])("settled kill retains cleanup revocation (reset: %s)", async (reset) => {
  const id = "kill-claim-owner";
  await registerCollector(id);
  let successor: ReturnType<typeof loadSessionEntry>;
  let lateEndedAt = 0;
  // The kill owner holds its claim across both completions; the kill confirms when it settles.
  await withSubagentKillOwner(id, async () => {
    const claim = expectDefined(
      await claimSubagentRunKill({
        runId: id,
        expected: expectDefined(subagentRuns.get(id), "registered collector"),
        sessionId: originalSessionId,
        sessionLifecycleRevision: "original",
      }),
      "retained cancellation claim",
    );
    // Keep the original session available so the no-reset case proves live cleanup authority.
    registryGateway.mockRejectedValue(new Error("cleanup transport unavailable"));
    const complete = completionOwner.completeSubagentRunAttempt;
    const emitKilledCompletion = async (endedAt: number) => {
      const observed = createDeferredCore<{ completion: Promise<void> }>();
      vi.spyOn(completionOwner, "completeSubagentRunAttempt").mockImplementationOnce((...args) => {
        const completion = complete(...args);
        observed.resolve({ completion });
        return completion;
      });
      emitLifecycle(id, { phase: "end", aborted: true, stopReason: "aborted", endedAt });
      // Row publication precedes terminal effects and the retained session's release.
      await (
        await observed.promise
      ).completion;
    };
    await emitKilledCompletion(Date.now());
    await settleSubagentRegistryPersistenceWork();
    expect(subagentRuns.get(id)?.killReconciliation?.killedAt).toBe(claim.requestedAt);
    expect(subagentRuns.get(id)?.killIntent).toBeUndefined();
    expect(subagentRuns.get(id)?.execution.suppressSessionEffects).not.toBe(true);
    expect(readSession()?.lifecycleRevision).toBe("original");
    if (reset) {
      await request("sessions.reset");
    }
    successor = readSession();
    lateEndedAt = Date.now();
    await emitKilledCompletion(lateEndedAt);
    await settleSubagentRegistryPersistenceWork();
    const stored = expectDefined(storedRun(id), "settled cancellation");
    expect(stored.killReconciliation).toMatchObject({ killedAt: claim.requestedAt });
    expect(stored.execution.suppressSessionEffects === true).toBe(reset);
  });
  await sweepAndExpectSession(
    reset ? successor : { ...expectDefined(successor, "retained session"), endedAt: lateEndedAt },
  );
});

test("reset persists suppression after a rejected cleanup write", async () => {
  await request("sessions.delete");
  const database = openOpenClawStateDatabase();
  database.db.exec(`CREATE TRIGGER reject_best_effort BEFORE UPDATE ON subagent_runs
    WHEN json_extract(NEW.payload_json, '$.execution.suppressSessionEffects') = 1
    BEGIN SELECT RAISE(ABORT, 'best effort write rejected'); END`);
  await expect(testing.sweepOnceForTests()).rejects.toThrow("best effort write rejected");
  expect(subagentRuns.get(runId)?.execution.suppressSessionEffects).not.toBe(true);
  expect(subagentRuns.get(runId)?.collectorLaunchCleanupPending).toBe(true);
  expectSuppression(runId, false);
  database.db.exec("DROP TRIGGER reject_best_effort");
  await request("sessions.reset");
  const successor = readSession();
  expect(successor).toBeDefined();
  await reopen();
  await sweepAndExpectSession(successor);
});

test.each([false, true])("reset handles yielded runs (collector: %s)", async (collect) => {
  const id = collect ? "yielded-collector" : "yielded-continuation";
  await registerCollector(id, key, "main", collect);
  await emitSubagentStart(id);
  emitLifecycle(id, { phase: "end", yielded: true, endedAt: Date.now() });
  // Collectors settle at their own terminal; announcing subagents retain a continuation.
  if (collect) {
    // Detached deletion outlives the terminal event; join its durable mark and bookkeeping tails.
    await waitForRegistryPublication(
      () => typeof subagentRuns.get(id)?.cleanupCompletedAt === "number",
    );
    await settleSubagentRegistryPersistenceWork();
    const settled = expectDefined(subagentRuns.get(id), "settled collector");
    expect(settled.pauseReason).toBeUndefined();
    expect(settled.execution.status).toBe("terminal");
    expect(settled.collectorCompletion).toBeDefined();
  } else {
    await waitForRegistryPublication(() => subagentRuns.get(id)?.pauseReason === "sessions_yield");
    expect(subagentRuns.get(id)?.pauseReason).toBe("sessions_yield");
  }
  await request("sessions.reset");
  if (!collect) {
    expect(storedRun(id)).toMatchObject({ pauseReason: "sessions_yield" });
  }
  expectSuppression(id, collect);
});
