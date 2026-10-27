import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { seedCanonicalAcpSessionMeta } from "../acp/runtime/session-meta-fixture.test-support.js";
import { readAcpSessionEntry } from "../acp/runtime/session-meta.js";
import { listRegisteredAgentHarnesses, registerAgentHarness } from "../agents/harness/registry.js";
import { restoreRegisteredAgentHarnesses } from "../agents/harness/registry.test-support.js";
import * as preparedModelRuntime from "../agents/prepared-model-runtime.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { RESET_PARENT_GRANT_FIXTURE } from "../config/sessions/session-lineage.test-support.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { peekSystemEvents } from "../infra/system-events.js";
import { enqueueSystemEvent } from "../plugin-sdk/system-event-runtime.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import {
  beginSessionEffect,
  captureSessionTarget,
  isSessionMutationActive,
  runSessionMutation,
} from "../sessions/session-controller.lifecycle.js";
import {
  submitSessionControllerTask,
  releaseSessionControllerClaim,
} from "../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { runExclusiveSessionLifecycle } from "../sessions/session-lifecycle-admission.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createRequestGate } from "./server-methods.request-gate.test-support.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import {
  expectResetAcpState,
  resolvedAcpMeta,
} from "./server.sessions.reset-cleanup.test-support.js";
import { loadTranscriptRows } from "./server.sessions.store-rpc.test-helpers.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsHandlerTestHarness,
  subagentLifecycleHookMocks,
  subagentLifecycleHookState,
  threadBindingMocks,
  acpRuntimeMocks,
  acpManagerMocks,
  browserSessionTabMocks,
  bundleMcpRuntimeMocks,
  writeSingleLineSession,
  sessionStoreEntry,
  expectActiveRunCleanup,
  directSessionReq,
  getGatewayConfigModule,
  getSessionsHandlers,
  sessionHookMocks,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, seedActiveMainSession } = setupGatewaySessionsHandlerTestHarness();
const { disposeSessionMcpRuntime: disposeMcp } = bundleMcpRuntimeMocks;
function mainTarget(storePath: string) {
  return captureSessionTarget({
    storeScope: storePath,
    sessionKey: "agent:main:main",
    aliases: ["main", "sess-main"],
    incarnation: "sess-main",
    agentId: "main",
  });
}

async function resetService(
  overrides: Partial<
    Parameters<typeof import("./session-reset-service.js").performGatewaySessionReset>[0]
  > = {},
) {
  const { performGatewaySessionReset } = await import("./session-reset-service.js");
  return performGatewaySessionReset({
    key: "main",
    reason: "new",
    commandSource: "gateway:agent",
    workerPlacementContext: {},
    ...overrides,
  });
}

afterEach(async () => {
  await disposeSessionReadContexts();
  closeOpenClawStateDatabaseForTest();
});

async function seedMainSession(entries: Record<string, InternalSessionEntry> = {}) {
  const seeded = await createSessionStoreDir();
  await writeSingleLineSession(seeded.dir, "sess-main", "hello");
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-main"), ...entries } });
  return seeded;
}

async function seedWaitingActiveMainSession() {
  const seeded = await seedActiveMainSession();
  const target = mainTarget(seeded.storePath);
  const started = createDeferred();
  const activeRun = withSessionTurn(
    { sessionKey: target.sessionKey, sessionId: "sess-main", target },
    async (_operation, signal) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve());
      });
    },
  );
  await started.promise;
  return { ...seeded, activeRun };
}

async function resetMainSession() {
  return await directSessionReq<{
    ok: true;
    key: string;
    entry: { lifecycleRevision?: string; sessionId: string };
  }>("sessions.reset", { key: "main" });
}

type ArchivedMainResetCase = {
  key: string;
  mainKey?: string;
  reason?: InternalSessionEntry["archiveReason"];
  tombstone?: boolean;
  allowed: boolean;
  locked?: boolean;
  staleIdentity?: boolean;
};

test.each<[string, ArchivedMainResetCase]>([
  ["default Main", { key: "agent:main:main", allowed: true }],
  ["configured Main", { key: "agent:main:inbox", mainKey: "inbox", allowed: true }],
  ["manually archived Main", { key: "agent:main:main", reason: "manual", allowed: false }],
  ["archived peer", { key: "agent:main:dashboard:peer", allowed: false }],
  ["archive without tombstone", { key: "agent:main:main", tombstone: false, allowed: false }],
  ["model-locked recovered Main", { key: "agent:main:main", locked: true, allowed: false }],
  ["stale expected Main identity", { key: "agent:main:main", staleIdentity: true, allowed: false }],
])(
  "sessions.reset preserves history when restoring %s",
  async (
    _,
    { key, mainKey, reason = "restart-recovery", tombstone = true, allowed, locked, staleIdentity },
  ) => {
    const { dir, storePath } = await createSessionStoreDir();
    testState.sessionConfig = mainKey ? { mainKey } : undefined;
    const sessionId = "synthetic-archived-main";
    await writeSingleLineSession(dir, sessionId, "synthetic retained transcript");
    await writeSessionStore({
      entries: {
        [key]: {
          ...sessionStoreEntry(sessionId),
          archivedAt: 100,
          archiveReason: reason,
          ...(locked ? { modelSelectionLocked: true } : {}),
          ...(tombstone
            ? {
                mainRestartRecovery: {
                  cycleId: "synthetic-recovery",
                  revision: 1,
                  chargedAttempts: 3,
                  tombstone: {
                    reason: "synthetic exhausted restart recovery",
                    recoveredSessionKey: "agent:main:dashboard:old-successor",
                    recoveredSessionId: "synthetic-successor",
                  },
                },
              }
            : {}),
        },
      },
    });
    const before = await loadTranscriptRows({ storePath, sessionKey: key, sessionId });
    const result = await directSessionReq("sessions.reset", {
      key,
      expectedSessionId: staleIdentity ? "stale-session" : sessionId,
    });
    expect(result.ok).toBe(allowed);
    const entry = loadSessionEntry({ storePath, sessionKey: key });
    expect(entry?.sessionId).toBe(sessionId);
    const after = await loadTranscriptRows({ storePath, sessionKey: key, sessionId });
    expect(after.slice(0, before.length)).toEqual(before);
    if (allowed) {
      expect(entry?.archivedAt).toBeUndefined();
      expect(entry?.archiveReason).toBeUndefined();
      expect(entry?.mainRestartRecovery).toBeUndefined();
      expect(after.slice(before.length)).toContainEqual(
        expect.objectContaining({ type: "reset", reason: "reset" }),
      );
    } else {
      expect(entry).toMatchObject({ archivedAt: 100, archiveReason: reason });
      expect(after).toEqual(before);
    }
  },
);

function installAcpRuntimeBackendWithFreshSession() {
  const prepareFreshSession = vi.fn(async () => {});
  acpRuntimeMocks.getAcpRuntimeBackend.mockReturnValue({
    id: "acpx",
    runtime: { prepareFreshSession },
  });
  return prepareFreshSession;
}

function seedAcp(
  sessionKey: string,
  overrides: Partial<Parameters<typeof resolvedAcpMeta>[0]> = {},
) {
  seedCanonicalAcpSessionMeta({
    sessionKey,
    meta: resolvedAcpMeta({
      recordId: sessionKey,
      backendSessionId: `backend-${sessionKey}`,
      ...overrides,
    }),
  });
}

function expectThreadUnbound() {
  expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledExactlyOnceWith({
    targetSessionKey: "agent:main:main",
    reason: "session-reset",
  });
}

function expectArchiveRejected(
  storePath: string,
  sessionKey: string,
  sessionId: string,
  result: unknown,
) {
  expect(result).toMatchObject({
    ok: false,
    error: { message: `Session ${sessionKey} changed before patch. Retry.` },
  });
  const entry = loadSessionEntry({ storePath, sessionKey });
  expect(entry?.archivedAt).toBeUndefined();
  expect(entry?.sessionId).toBe(sessionId);
}

const closedAcpKeys = () =>
  (acpManagerMocks.closeSession.mock.calls as unknown as Array<[{ sessionKey?: string }]>).map(
    ([request]) => request?.sessionKey,
  );

test("sessions.reset preempts the controller run and clears queues", async () => {
  const { activeRun, storePath } = await seedWaitingActiveMainSession();
  const parentGrant = RESET_PARENT_GRANT_FIXTURE;
  const preferences = {
    responseUsage: "tokens",
    pinnedAt: 123,
    label: "Operator session",
    category: "Operator group",
    icon: "🦞",
    boardFace: "dashboard",
    boardPresentation: "expanded",
    visibility: "draft",
  } satisfies Partial<InternalSessionEntry>;
  await upsertSessionEntryCore(
    { storePath, sessionKey: "agent:main:main" },
    { ...parentGrant, ...preferences },
  );
  for (const sessionKey of ["main", "agent:main:main", "sess-main"]) {
    enqueueSystemEvent(`stale event via ${sessionKey}`, { sessionKey });
  }
  const reset = await resetMainSession();
  await activeRun;
  expect(reset).toMatchObject({
    ok: true,
    payload: {
      key: "agent:main:main",
      entry: { sessionId: "sess-main", lifecycleRevision: expect.any(String), ...preferences },
    },
  });
  expect(reset.payload?.entry).not.toHaveProperty("sessionDiffBaselineCapture");
  expect(
    loadSessionEntry({ agentId: "main", sessionKey: "agent:main:main", storePath }),
  ).toMatchObject({
    sessionId: "sess-main",
    ...parentGrant,
    ...preferences,
    sessionDiffBaselineCapture: {
      version: 1,
      captureId: expect.any(String),
      status: "pending",
    },
  });
  expectActiveRunCleanup("agent:main:main", ["main", "agent:main:main", "sess-main"], "main");
  expect(peekSystemEvents("agent:main:main")).toStrictEqual([]);
  expect(peekSystemEvents("agent:main:sess-main")).toStrictEqual([]);
  expect(disposeMcp).toHaveBeenCalledWith("sess-main");
  expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).toHaveBeenCalledWith(
    expect.objectContaining({ sessionKeys: ["agent:main:main", "agent:main:sess-main"] }),
  );
  expect(subagentLifecycleHookMocks.runSubagentEnded).toHaveBeenCalledExactlyOnceWith(
    {
      targetSessionKey: "agent:main:main",
      targetKind: "acp",
      reason: "session-reset",
      sendFarewell: true,
      outcome: "reset",
    },
    {
      childSessionKey: "agent:main:main",
    },
  );
  expectThreadUnbound();
});

test("sessions.reset preserves its unavailable result when controller preemption times out", async () => {
  const { storePath } = await seedActiveMainSession();
  const target = mainTarget(storePath);
  const claim = await submitSessionControllerTask(target.sessionKey, {
    target,
    start: (mailboxClaim) => {
      createReplyOperation({
        sessionKey: target.sessionKey,
        sessionId: "sess-main",
        target,
        resetTriggered: false,
        mailboxClaim,
      });
    },
  });
  const operation = claim.operation!;
  const preemptAttempted = createDeferred();
  vi.spyOn(operation, "abort").mockImplementation(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    preemptAttempted.resolve();
    return false;
  });
  const reset = resetMainSession();
  void reset.catch(() => {});
  try {
    await preemptAttempted.promise;
    expect(isSessionMutationActive(storePath, target.aliases)).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    vi.useRealTimers();

    expect(await reset).toEqual({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "Session main is still active; try again in a moment.",
      },
    });
    expect(loadSessionEntry({ sessionKey: target.sessionKey, storePath })?.sessionId).toBe(
      "sess-main",
    );
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntime).not.toHaveBeenCalled();
    expect(browserSessionTabMocks.closeTrackedBrowserTabsForSessions).not.toHaveBeenCalled();
  } finally {
    operation.complete();
    releaseSessionControllerClaim(claim);
    await claim.settlement.promise;
    await reset.catch(() => undefined);
    vi.useRealTimers();
  }
});

test("sessions.reset clears retained native conversations from every execution owner", async () => {
  const registeredHarnesses = listRegisteredAgentHarnesses();
  const current = new Map([["sess-main", "gateway conversation"]]);
  const firstModel = new Map([
    ["sess-main", "first model context"],
    ["sibling", "keep me"],
  ]);
  const secondModel = new Map([["sess-main", "second model context"]]);
  const harness = (history: Map<string, string>) => ({
    id: "reset-observer",
    label: "Reset observer",
    supports: () => ({ supported: false }),
    runAttempt: async () => {
      throw new Error("not used");
    },
    reset: async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        history.delete(sessionId);
      }
    },
  });
  registerAgentHarness(harness(current));
  const registries = [firstModel, secondModel].map((history) => {
    const registry = createEmptyPluginRegistry();
    registry.agentHarnesses.push({
      pluginId: "native-fixture",
      source: "test",
      harness: harness(history),
    });
    return registry;
  });
  let retained = false;
  const acquire = vi
    .spyOn(preparedModelRuntime, "acquireAgentRuntimeCleanupRegistries")
    .mockImplementation(async () => {
      retained = true;
      return {
        registries,
        async [Symbol.asyncDispose]() {
          retained = false;
        },
      };
    });
  try {
    const { activeRun } = await seedWaitingActiveMainSession();
    const response = await resetMainSession();
    await activeRun;
    expect(response.ok).toBe(true);
    for (const history of [current, firstModel, secondModel]) {
      expect(history.has("sess-main")).toBe(false);
    }
    expect(firstModel.get("sibling")).toBe("keep me");
    expect(retained).toBe(false);
  } finally {
    acquire.mockRestore();
    restoreRegisteredAgentHarnesses(registeredHarnesses);
  }
});

test("sessions.reset rejects an active lifecycle mutation without interrupting admitted work", async () => {
  const { storePath } = await seedMainSession();
  let interrupted = false;
  const admissionLease = await beginSessionEffect({
    scope: storePath,
    identities: ["agent:main:main", "sess-main"],
    assertAllowed: () => {},
    onInterrupt: () => {
      interrupted = true;
    },
  });
  const mutation = createRequestGate();
  const blocker = runSessionMutation({
    scope: storePath,
    identities: ["agent:main:main", "sess-main"],
    run: () => mutation.pause(),
  });
  try {
    await mutation.entered;
    const assertCurrent = vi.fn(() => {
      throw new Error("stale lifecycle");
    });
    const reset = await resetService({
      reason: "reset",
      assertCurrent,
    });
    expect(reset).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: expect.stringContaining("lifecycle mutation in progress"),
      },
    });
    expect(assertCurrent).not.toHaveBeenCalled();
    expect(interrupted).toBe(false);
  } finally {
    mutation.release();
    admissionLease.release();
    await blocker;
  }
});

test("sessions.reset finishes after lifecycle rotation during destructive cleanup", async () => {
  await seedMainSession();
  const prepareFreshSession = installAcpRuntimeBackendWithFreshSession();
  seedAcp("agent:main:main", {
    runtimeOptions: { runtimeMode: "auto", timeoutSeconds: 30 },
  });
  let lifecycleCurrent = true;
  acpManagerMocks.closeSession.mockImplementationOnce(async () => {
    lifecycleCurrent = false;
  });
  const reset = await resetService({
    assertCurrent: () => {
      if (!lifecycleCurrent) {
        throw new Error("stale lifecycle");
      }
    },
  });

  expect(reset.ok).toBe(true);
  expectResetAcpState(readAcpSessionEntry({ sessionKey: "agent:main:main" })?.acp);
  expect(prepareFreshSession).not.toHaveBeenCalled();
});

test("sessions.reset rejects a concurrent archive during lifecycle rotation", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:subagent:archive-race";
  await writeSingleLineSession(dir, "sess-archive-race", "hello");
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry("sess-archive-race", { lifecycleRevision: "before-reset" }),
    },
  });
  const hook = createRequestGate();
  sessionHookMocks.triggerInternalHook.mockImplementationOnce(() => hook.pause());
  const resetPromise = resetService({
    key: sessionKey,
    commandSource: "gateway:sessions.reset",
  });
  await hook.entered;
  const archivePromise = directSessionReq("sessions.patch", {
    key: sessionKey,
    archived: true,
    expectedSessionId: "sess-archive-race",
    expectedLifecycleRevision: "before-reset",
  });
  hook.release();

  const [reset, archived] = await Promise.all([resetPromise, archivePromise]);
  expect(reset.ok).toBe(true);
  expectArchiveRejected(storePath, sessionKey, "sess-archive-race", archived);
});

test("sessions.patch rejects an archive queued behind a rotated session", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:subagent:queued-archive-race";
  const initialSessionId = "sess-queued-archive-race";
  const replacementSessionId = "sess-after-queued-reset";
  await writeSessionStore({
    entries: { [sessionKey]: sessionStoreEntry(initialSessionId) },
  });
  // Resolve the lazy handler/config imports before queue ordering begins.
  await Promise.all([getSessionsHandlers(), getGatewayConfigModule()]);
  const gate = createRequestGate();
  const blocker = runExclusiveSessionLifecycle({
    scope: storePath,
    identities: [sessionKey, initialSessionId],
    run: () => gate.pause(),
  });
  await gate.entered;
  const queuedReset = runSessionMutation({
    scope: storePath,
    identities: [sessionKey, initialSessionId],
    run: async () => {
      await writeSessionStore({
        entries: {
          [sessionKey]: sessionStoreEntry(replacementSessionId),
        },
      });
    },
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  const archivePromise = directSessionReq("sessions.patch", {
    key: sessionKey,
    archived: true,
    expectedSessionId: initialSessionId,
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  gate.release();

  const archived = (await Promise.all([blocker, queuedReset, archivePromise]))[2];
  expectArchiveRejected(storePath, sessionKey, replacementSessionId, archived);
});

test("sessions.reset closes a spawned ACP child that lives in a different agent store", async () => {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("OPENCLAW_STATE_DIR is required for gateway session tests");
  }
  testState.sessionConfig = {
    store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
  };
  testState.agentsConfig = {
    ownership: "explicit",
    entries: { main: {}, codex: {} },
  };
  testState.agentConfig = { systemAgent: { agentId: "main" } };
  for (const [agentId, sessionKey, sessionId, mode] of [
    ["main", "agent:main:main", "sess-main", "persistent"],
    ["codex", "agent:codex:acp:cross-store-child", "sess-codex-child", "oneshot"],
  ] as const) {
    await writeSessionStore({
      agentId,
      storePath: path.join(stateDir, "agents", agentId, "sessions", "sessions.json"),
      entries: {
        [sessionKey]: sessionStoreEntry(
          sessionId,
          agentId === "main" ? {} : { spawnedBy: "agent:main:main" },
        ),
      },
    });
    seedCanonicalAcpSessionMeta({
      sessionKey,
      meta: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: `runtime:${agentId}`,
        mode,
        state: "idle",
        lastActivityAt: Date.now(),
      },
    });
  }

  expect((await resetMainSession()).ok).toBe(true);

  expect(closedAcpKeys()).toContain("agent:codex:acp:cross-store-child");
});

test("sessions.reset closes child ACP runtimes concurrently so stuck children do not serialize cleanup", async ({
  signal,
}) => {
  installAcpRuntimeBackendWithFreshSession();
  await seedMainSession({
    // Both lineage fields identify direct children.
    "acp-child-1": sessionStoreEntry("sess-c1", { spawnedBy: "agent:main:main" }),
    "acp-child-2": sessionStoreEntry("sess-c2", { spawnedBy: "agent:main:main" }),
    "acp-child-3": sessionStoreEntry("sess-c3", { parentSessionKey: "agent:main:main" }),
    "not-acp-child": sessionStoreEntry("sess-not-acp", { spawnedBy: "agent:main:main" }),
    "unrelated-acp-child": sessionStoreEntry("sess-unrelated", { spawnedBy: "agent:main:other" }),
    "acp-grandchild": sessionStoreEntry("sess-grandchild", {
      parentSessionKey: "agent:main:acp-child-1",
    }),
  });
  for (const sessionKey of [
    "agent:main:main",
    "agent:main:acp-child-1",
    "agent:main:acp-child-2",
    "agent:main:acp-child-3",
    "agent:main:unrelated-acp-child",
    "agent:main:acp-grandchild",
  ]) {
    seedAcp(sessionKey, { runtimeSessionName: `runtime:${sessionKey}`, mode: "oneshot" });
  }

  // All children must enter cancellation before any is released.
  const childrenEntered = createDeferred();
  const releaseChildren: Array<() => void> = [];
  acpManagerMocks.cancelSession.mockImplementation(async (...args: unknown[]) => {
    const req = args[0] as { sessionKey?: string } | undefined;
    if (req?.sessionKey === "agent:main:main") {
      return;
    }
    await new Promise<void>((resolve) => {
      releaseChildren.push(resolve);
      if (releaseChildren.length === 3) {
        childrenEntered.resolve();
      }
    });
  });

  const resetPromise = resetMainSession();
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        childrenEntered.promise,
        resetPromise,
        "Reset settled before all child cancellations entered",
      ),
      signal,
    );
    const childCancels = (
      acpManagerMocks.cancelSession.mock.calls as unknown as Array<[{ sessionKey?: string }]>
    ).filter((call) => call[0]?.sessionKey?.startsWith("agent:main:acp-child"));
    expect(childCancels.length).toBe(3);

    for (const release of releaseChildren) {
      release();
    }
    const reset = await resetPromise;
    expect(reset.ok).toBe(true);
    // Direct-child cleanup (#68916) must neither orphan children nor cascade to peers/grandchildren.
    expect(closedAcpKeys()).toEqual(
      expect.arrayContaining([
        "agent:main:main",
        "agent:main:acp-child-1",
        "agent:main:acp-child-2",
        "agent:main:acp-child-3",
      ]),
    );
    for (const child of ["not-acp-child", "unrelated-acp-child", "acp-grandchild"]) {
      expect(closedAcpKeys()).not.toContain(`agent:main:${child}`);
    }
  } finally {
    acpManagerMocks.cancelSession.mockImplementation(async () => {});
    for (const release of releaseChildren) {
      release();
    }
    await resetPromise.catch(() => {});
  }
});

test("sessions.reset directly unbinds thread bindings when hooks are unavailable", async () => {
  await seedMainSession();
  subagentLifecycleHookState.hasSubagentEndedHook = false;

  expect((await resetMainSession()).ok).toBe(true);
  expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
  expectThreadUnbound();
});

test.each(["already retired", "caller retired"] as const)(
  "ACP reset preserves its row and resume state when %s before metadata commit",
  async (reason) => {
    const entryWorker =
      await import("../config/sessions/session-accessor.sqlite-replacement-worker.js");
    const { closeAcpRuntimeForSession } = await import("./session-reset-acp.js");
    const { storePath } = await seedActiveMainSession();
    const sessionKey = "agent:main:main";
    seedAcp(sessionKey, {
      backendSessionId: "original-backend",
      runtimeSessionName: "original-runtime",
    });
    installAcpRuntimeBackendWithFreshSession();
    const scope = { agentId: "main", sessionKey, storePath };
    const readState = () => ({
      entry: loadSessionEntry(scope),
      meta: readAcpSessionEntry({ sessionKey })?.acp,
    });
    const before = structuredClone(readState());
    const mutation = createRequestGate();
    const originalWrite = entryWorker.withSessionEntryWorker;
    using intercepted = vi
      .spyOn(entryWorker, "withSessionEntryWorker")
      .mockImplementation(async (...args) => {
        await mutation.pause();
        return await originalWrite(...args);
      });
    let current = reason !== "already retired";
    const resetting = closeAcpRuntimeForSession({
      cfg: { session: { store: storePath } },
      agentId: "main",
      sessionKey,
      reason: "session-reset",
      assertCurrent: () => assert(current, "reset caller retired"),
    });
    const outcome = expect(resetting).rejects.toThrow("reset caller retired");
    try {
      if (reason === "already retired") {
        await outcome;
        expect(intercepted).not.toHaveBeenCalled();
      } else {
        await Promise.race([
          mutation.entered,
          outcome.then(() => {
            throw new Error("ACP reset settled before the metadata mutation boundary");
          }),
        ]);
        current = false;
        mutation.release();
        await outcome;
      }
      expect(readState()).toEqual(before);
    } finally {
      mutation.release();
      await outcome;
    }
  },
);
