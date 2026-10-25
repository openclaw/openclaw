import { afterEach, expect, test, vi, describe } from "vitest";
import { AcpRuntimeError } from "../acp/runtime/errors.js";
import { seedCanonicalAcpSessionMeta } from "../acp/runtime/session-meta-fixture.test-support.js";
import { buildAcpDatabaseSessionKey } from "../acp/runtime/session-meta-keys.js";
import { readAcpSessionEntry } from "../acp/runtime/session-meta.js";
import { listRegisteredAgentHarnesses, registerAgentHarness } from "../agents/harness/registry.js";
import { restoreRegisteredAgentHarnesses } from "../agents/harness/registry.test-support.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { callAgentToolGatewayRequest } from "../agents/tools/in-process-gateway.js";
import type { CliDeps } from "../cli/deps.types.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { drainSystemEventEntries, peekSystemEvents } from "../infra/system-events.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { beginSessionEffect } from "../sessions/session-controller.lifecycle.js";
import {
  acknowledgeSessionStateNotices,
  recordSessionStateEventAsync,
  registerSessionStateWatch,
} from "../sessions/session-state-events.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withLocalGatewayRequestScope } from "./local-request-context.js";
import {
  expectResetAcpState,
  resolvedAcpMeta,
} from "./server.sessions.reset-cleanup.test-support.js";
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
  getGatewayConfigModule,
  expectNoSessionQueueCleanup,
  browserSessionTabMocks,
  sessionHookMocks,
  subagentLifecycleHookMocks,
} from "./test/server-sessions.test-helpers.js";

const {
  createSessionStoreDir,
  createConfiguredGlobalAgentSessionStore,
  resetConfiguredGlobalAgentSessionStore,
} = setupGatewaySessionsHandlerTestHarness();

afterEach(closeOpenClawStateDatabaseForTest);

describe("ACP reset", () => {
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

  const acpMeta = () =>
    resolvedAcpMeta({
      recordId: sessionKey,
      backendSessionId: "backend-session-1",
      runtimeOptions: { runtimeMode: "auto", timeoutSeconds: 30 },
    });

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
    seedCanonicalAcpSessionMeta({ sessionKey, meta: acpMeta() });
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
        expect(acpManagerMocks.closeSession).toHaveBeenCalledTimes(
          step === "cancelSession" ? 0 : 1,
        );
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
    const { identity: _identity, ...legacyMeta } = acpMeta();
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
            meta: { ...acpMeta(), runtimeSessionName: `${agent}-owned` },
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
});

describe("concurrency", () => {
  async function seedSession(key: string, id: string, fields: Partial<SessionEntry> = {}) {
    const { storePath } = await createSessionStoreDir();
    const scope = { agentId: "main", sessionKey: key, storePath };
    const write = (nextId: string, overrides: Partial<SessionEntry>) =>
      writeSessionStore({ entries: { [key]: sessionStoreEntry(nextId, overrides) } });
    if (fields.incognito) {
      await replaceSessionEntry(scope, sessionStoreEntry(id, fields));
    } else {
      await write(id, fields);
    }
    return { scope, read: () => loadSessionEntry(scope), write };
  }

  function resetHarness(id: string, reset: () => Promise<void>) {
    const previous = listRegisteredAgentHarnesses();
    registerAgentHarness({
      id,
      label: id,
      reset,
      supports: () => ({ supported: false }),
      runAttempt: async () => {
        throw new Error("not used");
      },
    });
    return { [Symbol.dispose]: () => restoreRegisteredAgentHarnesses(previous) };
  }

  async function resetFromCaller(key: string, current: () => boolean) {
    const { getRuntimeConfig } = await getGatewayConfigModule();
    const resources = new LegacyPluginSdkResourceHost();
    const work = new AsyncWorkScope();
    // The RPC deadline does not cancel accepted work; authority tests control that clock.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await using _ = {
      [Symbol.asyncDispose]: async () => {
        try {
          await work.runWhenIdle(() => resources.close());
        } finally {
          vi.useRealTimers();
          await work.drain();
        }
      },
    };
    return await work.run(() =>
      resources.run(() =>
        withLocalGatewayRequestScope({ deps: {} as CliDeps, getRuntimeConfig }, () =>
          withGatewayToolCallerIdentity(
            {
              agentId: "main",
              sessionKey: "agent:main:reset-requester",
              operationalRunInstance: { instanceId: "reset-instance", runId: "reset-run" },
              receiptAuthority: current,
            },
            () => callAgentToolGatewayRequest({ method: "sessions.reset", params: { key } }),
          ),
        ),
      ),
    );
  }

  test.each(["normal", "incognito", "replacement"])(
    "sessions.reset completes only its accepted %s generation after caller closure during cleanup",
    async (mode) => {
      const sessionKey = `agent:main:dashboard:${mode === "incognito" ? "incognito-" : ""}closing-reset`;
      const sessionId = "closing-reset";
      const { scope, read, write } = await seedSession(sessionKey, sessionId, {
        incognito: mode === "incognito" ? true : undefined,
        lifecycleRevision: "original",
        totalTokens: 99,
      });
      let current = true;
      let cleaned = false;
      using _ = resetHarness("caller-reset-cleanup", async () => {
        cleaned = true;
        current = false;
        if (mode === "replacement") {
          await write(sessionId, { lifecycleRevision: "replacement", totalTokens: 123 });
        }
      });
      await expect(resetFromCaller(sessionKey, () => current)).rejects.toThrow(/authority/i);
      expect(cleaned).toBe(true);
      const entry = read();
      if (mode === "incognito") {
        expect(entry).toBeUndefined();
      } else if (mode === "replacement") {
        expect(entry).toMatchObject({ lifecycleRevision: "replacement", totalTokens: 123 });
        expect(await loadTranscriptEvents({ ...scope, sessionId })).toEqual([]);
      } else {
        expect(entry).toMatchObject({ sessionId, totalTokens: 0 });
        expect(entry?.lifecycleRevision).not.toBe("original");
      }
    },
  );

  test("sessions.reset never creates a missing session after caller closure during cleanup", async () => {
    const { storePath } = await createSessionStoreDir();
    const sessionKey = "agent:main:dashboard:missing-reset";
    let current = true;
    browserSessionTabMocks.closeTrackedBrowserTabsForSessions.mockImplementationOnce(async () => {
      current = false;
      return 0;
    });
    await expect(resetFromCaller(sessionKey, () => current)).rejects.toThrow(/authority/i);
    expect(current).toBe(false);
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
  });

  test.each([false, true])(
    "sessions.reset rejects caller closure before cleanup (incognito: %s)",
    async (incognito) => {
      const sessionKey = `agent:main:dashboard:${incognito ? "incognito-" : ""}early-reset`;
      const { read } = await seedSession(sessionKey, "early-reset", {
        incognito: incognito ? true : undefined,
        totalTokens: 99,
      });
      const before = read();
      let current = true;
      sessionHookMocks.triggerInternalHook.mockImplementationOnce(async () => {
        current = false;
      });
      await expect(resetFromCaller(sessionKey, () => current)).rejects.toThrow(/authority/i);
      expect(read()).toEqual(before);
      expectNoSessionQueueCleanup();
    },
  );

  test.each(["sess-main", "sess-replacement"])(
    "sessions.reset preserves a concurrent lifecycle replacement (%s)",
    async (replacementSessionId) => {
      const { scope, write } = await seedSession("main", "sess-main", {
        lifecycleRevision: "original-revision",
      });
      let lifecycleCurrent = true;
      using _ = resetHarness("reset-race-observer", async () => {
        lifecycleCurrent = false;
        await write(replacementSessionId, {
          label: "newer owner",
          lifecycleRevision: "replacement-revision",
        });
      });
      const { performGatewaySessionReset } = await import("./session-reset-service.js");
      const reset = await performGatewaySessionReset({
        key: "main",
        reason: "new",
        commandSource: "gateway:agent",
        workerPlacementContext: {},
        assertCurrent: () => {
          if (!lifecycleCurrent) {
            throw new Error("stale lifecycle");
          }
        },
      });
      expect(reset).toMatchObject({
        ok: true,
        entry: {
          label: "newer owner",
          lifecycleRevision: "replacement-revision",
          sessionId: replacementSessionId,
        },
      });
      expect(await loadTranscriptEvents({ ...scope, sessionId: "sess-main" })).toEqual([]);
      for (const hook of [
        sessionLifecycleHookMocks.runSessionEnd,
        sessionLifecycleHookMocks.runSessionStart,
        subagentLifecycleHookMocks.runSubagentEnded,
        threadBindingMocks.unbindThreadBindingsBySessionKey,
      ]) {
        expect(hook).not.toHaveBeenCalled();
      }
    },
  );

  test.each(["admission", "interrupt", "drain"] as const)(
    "sessions.reset rejects a session changed at the %s boundary without disturbing its replacement",
    async (point) => {
      const sessionKey = `agent:main:subagent:guarded-reset-${point}`;
      const observedSessionId = "sess-observed";
      const replacementSessionId = point === "admission" ? observedSessionId : "sess-replacement";
      const { scope, read } = await seedSession(sessionKey, observedSessionId);
      let interrupted = false;
      let replaced = false;
      const admission =
        point === "drain"
          ? undefined
          : await beginSessionEffect({
              scope: scope.storePath,
              identities: [sessionKey, replacementSessionId],
              assertAllowed: () => {},
              onInterrupt: () => {
                interrupted = true;
              },
            });
      const replace = () => {
        if (!replaced) {
          replaced = true;
          replaceSessionEntrySync(scope, sessionStoreEntry(replacementSessionId));
        }
        return { ok: true as const, value: {} };
      };
      using _ = { [Symbol.dispose]: () => admission?.release() };
      const { performGatewaySessionReset } = await import("./session-reset-service.js");
      const reset =
        point === "admission"
          ? await directSessionReq("sessions.reset", {
              key: sessionKey,
              expectedSessionId: "sess-stale",
            })
          : await performGatewaySessionReset({
              key: sessionKey,
              reason: "reset",
              commandSource: "gateway:sessions.reset",
              workerPlacementContext: {},
              expectedSessionId: observedSessionId,
              assertCurrent: point === "interrupt" ? replace : undefined,
              prepareLifecycle: point === "drain" ? async () => replace() : undefined,
            });
      expect(reset).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST", details: { reason: "session-changed" } },
      });
      if (point === "interrupt") {
        expect(replaced).toBe(true);
      }
      if (admission) {
        expect(interrupted).toBe(false);
      }
      expect(read()?.sessionId).toBe(replacementSessionId);
    },
  );
});
