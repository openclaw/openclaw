import { afterEach, expect, test, vi } from "vitest";
import { AcpRuntimeError } from "../acp/runtime/errors.js";
import { seedCanonicalAcpSessionMeta } from "../acp/runtime/session-meta-fixture.test-support.js";
import { buildAcpDatabaseSessionKey } from "../acp/runtime/session-meta-keys.js";
import { readAcpSessionEntry } from "../acp/runtime/session-meta.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import { drainSystemEventEntries, peekSystemEvents } from "../infra/system-events.js";
import {
  acknowledgeSessionStateNotices,
  recordSessionStateEventAsync,
  registerSessionStateWatch,
} from "../sessions/session-state-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { onGatewaySessionReset } from "./session-reset-notifications.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  acpManagerMocks,
  acpRuntimeMocks,
  beforeResetHookMocks,
  beforeResetHookState,
  directSessionReq,
  sessionLifecycleHookMocks,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
  threadBindingMocks,
  writeSingleLineSession,
} from "./test/server-sessions.test-helpers.js";

const {
  createSessionStoreDir,
  createConfiguredGlobalAgentSessionStore,
  resetConfiguredGlobalAgentSessionStore,
} = setupGatewaySessionsHandlerTestHarness();

afterEach(closeOpenClawStateDatabaseForTest);

const sessionKey = "agent:main:main";
const readSession = (storePath: string) => loadSessionEntry({ storePath, sessionKey });
const readAcp = () => readAcpSessionEntry({ sessionKey })?.acp;
const ownerRepairError = () =>
  new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "owner repair required", {
    detailCode: "SESSION_OWNER_MIGRATION_REQUIRED",
  });
type ResetOptions = Parameters<
  typeof import("./session-reset-service.js").performGatewaySessionReset
>[0];
async function resetSession(options: Partial<ResetOptions> = {}) {
  const { performGatewaySessionReset } = await import("./session-reset-service.js");
  return performGatewaySessionReset({
    key: "main",
    reason: "reset",
    commandSource: "gateway:sessions.reset",
    workerPlacementContext: {},
    ...options,
  });
}

function resolvedAcpMeta(): SessionAcpMeta {
  return {
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "runtime:reset",
    mode: "persistent",
    runtimeOptions: { runtimeMode: "auto", timeoutSeconds: 30 },
    cwd: "/tmp/acp-session",
    state: "idle",
    identity: {
      state: "resolved",
      acpxRecordId: sessionKey,
      acpxSessionId: "backend-session-1",
      source: "status",
      lastUpdatedAt: Date.now(),
    },
    lastActivityAt: Date.now(),
  };
}

function expectResetAcpState(acp: SessionAcpMeta | undefined) {
  expect(acp).toMatchObject({
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "runtime:reset",
    mode: "persistent",
    runtimeOptions: { runtimeMode: "auto", timeoutSeconds: 30 },
    cwd: "/tmp/acp-session",
    state: "idle",
    identity: { state: "pending", acpxRecordId: sessionKey },
  });
  expect(acp?.identity?.acpxSessionId).toBeUndefined();
}

function accelerateAcpCleanupTimeout() {
  const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
  return vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => nativeSetTimeout(callback, delay === 15_000 ? 0 : delay, ...args)) as typeof setTimeout);
}

async function seedAcpSession() {
  const { dir, storePath } = await createSessionStoreDir();
  await writeSingleLineSession(dir, "sess-main", "hello");
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-main") } });
  seedCanonicalAcpSessionMeta({ sessionKey, meta: resolvedAcpMeta() });
  const prepareFreshSession = vi.fn(async () => {});
  acpRuntimeMocks.getAcpRuntimeBackend.mockReturnValue({
    id: "acpx",
    runtime: { prepareFreshSession },
  });
  return { prepareFreshSession, storePath };
}

test.each(["source-and-acp", "acp", "committed-callback"])(
  "settles reset actions after %s failure",
  async (failure) => {
    const { prepareFreshSession, storePath } = await seedAcpSession();
    const childKey = "agent:main:subagent:watched";
    const previous = readSession(storePath);
    const sourceFails = failure === "source-and-acp";
    const postCommitFails = failure === "acp" || failure === "source-and-acp";
    const committedCallbackFails = failure === "committed-callback";
    const sourceFailure = new Error("project source cleanup failed");
    const committedCallbackFailure = new Error("committed callback failed");
    const postCommitFailure = ownerRepairError();
    const events: string[] = [];
    const step = (name: string, error?: Error) => {
      events.push(name);
      if (error) {
        throw error;
      }
    };
    const notified = vi.fn();
    const unsubscribeReset = onGatewaySessionReset(notified);
    const rollback = vi.fn(async () => {});
    const recordChildActivity = () =>
      recordSessionStateEventAsync({
        sessionKey: childKey,
        agentId: "main",
        kind: "human_direct_message",
        actorType: "human",
        summary: "human message via test",
      });
    const watch = { watcherSessionKey: sessionKey, targetSessionKey: childKey };
    expect(await registerSessionStateWatch(watch)).toBe(true);
    await recordChildActivity();
    const drained = drainSystemEventEntries(sessionKey);
    expect(drained).toHaveLength(1);
    await acknowledgeSessionStateNotices(sessionKey, [
      { targetSessionKey: childKey, watcherStorePath: drained[0]?.sessionStorePath ?? null },
    ]);
    prepareFreshSession.mockImplementation(async () => {
      step("runtime-preparation", postCommitFails ? postCommitFailure : undefined);
    });
    beforeResetHookState.hasBeforeResetHook = true;
    if (!postCommitFails) {
      beforeResetHookMocks.runBeforeReset.mockImplementationOnce(async () => {
        step("before-reset");
      });
    }
    const reset = resetSession({
      onCommitted: () =>
        step("committed", committedCallbackFails ? committedCallbackFailure : undefined),
      prepareLifecycle: async () => ({
        ok: true,
        value: {
          rollback,
          withCommit: async (run) => {
            const result = await run(() => {});
            step("source-closed", sourceFails ? sourceFailure : undefined);
            return result;
          },
        },
      }),
    });
    try {
      if (sourceFails) {
        await expect(reset).rejects.toMatchObject({
          errors: [sourceFailure, postCommitFailure],
          cause: postCommitFailure,
        });
      } else {
        await expect(reset).rejects.toBe(
          committedCallbackFails ? committedCallbackFailure : postCommitFailure,
        );
      }
    } finally {
      unsubscribeReset();
    }

    expect(notified).toHaveBeenCalledExactlyOnceWith(sessionKey, "main");
    await recordChildActivity();
    expect(peekSystemEvents(sessionKey)).toEqual([]);
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledExactlyOnceWith({
      targetSessionKey: sessionKey,
      reason: "session-reset",
    });
    expect(sessionLifecycleHookMocks.runSessionEnd).toHaveBeenCalledTimes(1);
    expect(sessionLifecycleHookMocks.runSessionStart).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      "committed",
      ...(committedCallbackFails ? [] : ["source-closed"]),
      "runtime-preparation",
      ...(postCommitFails ? [] : ["before-reset"]),
    ]);
    expect(beforeResetHookMocks.runBeforeReset).toHaveBeenCalledTimes(postCommitFails ? 0 : 1);
    expect(rollback).not.toHaveBeenCalled();
    const current = readSession(storePath);
    expect(current?.lifecycleRevision).toEqual(expect.any(String));
    expect(current?.lifecycleRevision).not.toBe(previous?.lifecycleRevision);
    expectResetAcpState(readAcp());
  },
);

test.each(["cancelSession", "closeSession"] as const)(
  "discards ACP ownership after %s timeout",
  async (step) => {
    const { prepareFreshSession, storePath } = await seedAcpSession();
    const stalled = createDeferredCore();
    const cleanup = acpManagerMocks[step];
    cleanup.mockImplementation(async () => await stalled.promise);
    const timeoutSpy = accelerateAcpCleanupTimeout();

    try {
      const reset = await directSessionReq<{ ok: true }>("sessions.reset", { key: "main" });
      expect(reset.ok).toBe(true);
      expect(acpManagerMocks.cancelSession).toHaveBeenCalledTimes(1);
      expect(acpManagerMocks.closeSession).toHaveBeenCalledTimes(step === "cancelSession" ? 0 : 1);
      expect(acpManagerMocks.forceDiscardSessionRuntime).toHaveBeenCalledWith({
        cfg: expect.any(Object),
        sessionKey,
        reason: "session-reset",
        agentId: "main",
        isCurrent: expect.any(Function),
        assertCurrent: undefined,
      });
      expect(prepareFreshSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey, agentId: "main" }),
      );
      expect(readSession(storePath)).not.toHaveProperty("acp");
      expectResetAcpState(readAcp());
    } finally {
      stalled.resolve();
      timeoutSpy.mockRestore();
      cleanup.mockImplementation(async () => {});
    }
  },
);

test.each([true, false])("binds legacy ACP to canonical row (existing=%s)", async (existing) => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: existing ? { main: sessionStoreEntry("legacy-main") } : {},
  });
  const { identity: _identity, ...legacyMeta } = resolvedAcpMeta();
  seedCanonicalAcpSessionMeta({ sessionKey, meta: legacyMeta });
  const reset = await directSessionReq("sessions.reset", { key: "main" });
  expect(reset.ok).toBe(true);
  const entry = readSession(storePath);
  expect(entry?.lifecycleRevision).toEqual(expect.any(String));
  const meta = readAcpSessionEntry({ sessionKey, agentId: "main" })?.acp;
  expect(meta).toMatchObject({ backend: "acpx", agent: "codex", identity: { state: "pending" } });
  expect(loadSessionEntry({ storePath, sessionKey: "main" })?.sessionId).toBe(entry?.sessionId);
});

test.each(["global", "agent:work:main"])(
  "%s reset preserves other agent's ACP owner",
  async (key) => {
    const stores = await createConfiguredGlobalAgentSessionStore({ writePrimeStore: true });
    try {
      const cfg = stores.getRuntimeConfig();
      for (const agent of ["main", "work"]) {
        seedCanonicalAcpSessionMeta({
          sessionKey: buildAcpDatabaseSessionKey("global", agent),
          meta: { ...resolvedAcpMeta(), runtimeSessionName: `${agent}-owned` },
        });
      }
      const readOwner = (agentId: string) =>
        readAcpSessionEntry({ cfg, sessionKey: "global", agentId })?.acp;
      const before = readOwner("main");
      const reset = await directSessionReq("sessions.reset", { key, agentId: "work" });
      expect(reset.ok).toBe(true);
      expect(readOwner("main")).toEqual(before);
      expect(readOwner("work")).toMatchObject({
        runtimeSessionName: "work-owned",
        identity: { state: "pending" },
      });
      expect(acpManagerMocks.cancelSession).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "work" }),
      );
    } finally {
      await resetConfiguredGlobalAgentSessionStore(stores);
    }
  },
);

test.each(["owner-repair", "discard-error"] as const)(
  "does not commit after %s cleanup failure",
  async (failure) => {
    const { storePath } = await seedAcpSession();
    const before = readSession(storePath);
    const error =
      failure === "owner-repair" ? ownerRepairError() : new Error("force discard failed");
    const timeoutSpy = accelerateAcpCleanupTimeout();
    const stalled = createDeferredCore();
    try {
      if (failure === "owner-repair") {
        acpManagerMocks.cancelSession.mockRejectedValueOnce(error);
      } else {
        acpManagerMocks.cancelSession.mockImplementationOnce(() => stalled.promise);
        acpManagerMocks.forceDiscardSessionRuntime.mockRejectedValueOnce(error);
      }
      const pending = resetSession();
      if (failure === "discard-error") {
        await expect(pending).rejects.toThrow("force discard failed");
      } else {
        expect((await pending).ok).toBe(false);
      }
      expect(readSession(storePath)).toEqual(before);
    } finally {
      stalled.resolve();
      timeoutSpy.mockRestore();
    }
  },
);
