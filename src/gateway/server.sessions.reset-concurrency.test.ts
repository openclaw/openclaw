// Session reset concurrency tests protect newer same-id lifecycle owners.
import { afterEach, expect, test, vi } from "vitest";
import { listRegisteredAgentHarnesses, registerAgentHarness } from "../agents/harness/registry.js";
import { restoreRegisteredAgentHarnesses } from "../agents/harness/registry.test-support.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { callAgentToolGatewayRequest } from "../agents/tools/in-process-gateway.js";
import type { CliDeps } from "../cli/deps.types.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withLocalGatewayRequestScope } from "./local-request-context.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  expectNoSessionQueueCleanup,
  browserSessionTabMocks,
  sessionHookMocks,
  sessionLifecycleHookMocks,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
  subagentLifecycleHookMocks,
  threadBindingMocks,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

async function resetFromCaller(key: string, current: () => boolean) {
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const resources = new LegacyPluginSdkResourceHost();
  const work = new AsyncWorkScope();
  // The RPC deadline does not cancel accepted work; authority tests control that clock.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
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
  } finally {
    try {
      await work.runWhenIdle(() => resources.close());
    } finally {
      vi.useRealTimers();
      await work.drain();
    }
  }
}

test.each(["normal", "incognito", "replacement"])(
  "sessions.reset completes only its accepted %s generation after caller closure during cleanup",
  async (mode) => {
    const registeredHarnesses = listRegisteredAgentHarnesses();
    const { storePath } = await createSessionStoreDir();
    const sessionKey = `agent:main:${mode === "incognito" ? "incognito" : "dashboard"}:closing-reset`;
    const sessionId = "closing-reset";
    await writeSessionStore({
      entries: {
        [sessionKey]: sessionStoreEntry(sessionId, {
          incognito: mode === "incognito" ? true : undefined,
          lifecycleRevision: "original",
          totalTokens: 99,
        }),
      },
    });
    let current = true;
    let cleaned = false;
    registerAgentHarness({
      id: "caller-reset-cleanup",
      label: "Caller reset cleanup",
      supports: () => ({ supported: false }),
      runAttempt: async () => {
        throw new Error("not used");
      },
      reset: async () => {
        cleaned = true;
        current = false;
        if (mode === "replacement") {
          await writeSessionStore({
            entries: {
              [sessionKey]: sessionStoreEntry(sessionId, {
                lifecycleRevision: "replacement",
                totalTokens: 123,
              }),
            },
          });
        }
      },
    });
    try {
      await expect(resetFromCaller(sessionKey, () => current)).rejects.toThrow(/authority/i);
      expect(cleaned).toBe(true);
      const entry = loadSessionEntry({ sessionKey, storePath });
      if (mode === "incognito") {
        expect(entry).toBeUndefined();
      } else if (mode === "replacement") {
        expect(entry).toMatchObject({ lifecycleRevision: "replacement", totalTokens: 123 });
        expect(await loadTranscriptEvents({ sessionKey, sessionId, storePath })).toEqual([]);
      } else {
        expect(entry).toMatchObject({ sessionId, totalTokens: 0 });
        expect(entry?.lifecycleRevision).not.toBe("original");
      }
    } finally {
      restoreRegisteredAgentHarnesses(registeredHarnesses);
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
    const { storePath } = await createSessionStoreDir();
    const sessionKey = `agent:main:${incognito ? "incognito" : "dashboard"}:early-reset`;
    await writeSessionStore({
      entries: {
        [sessionKey]: sessionStoreEntry("early-reset", {
          incognito: incognito ? true : undefined,
          totalTokens: 99,
        }),
      },
    });
    const before = loadSessionEntry({ sessionKey, storePath });
    let current = true;
    sessionHookMocks.triggerInternalHook.mockImplementationOnce(async () => {
      current = false;
    });
    await expect(resetFromCaller(sessionKey, () => current)).rejects.toThrow(/authority/i);
    expect(loadSessionEntry({ sessionKey, storePath })).toEqual(before);
    expectNoSessionQueueCleanup();
  },
);

test("sessions.reset preserves a concurrent same-id lifecycle replacement", async () => {
  const registeredHarnesses = listRegisteredAgentHarnesses();
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main", { lifecycleRevision: "original-revision" }),
    },
  });
  let lifecycleCurrent = true;
  registerAgentHarness({
    id: "reset-race-observer",
    label: "Reset race observer",
    supports: () => ({ supported: false }),
    runAttempt: async () => {
      throw new Error("not used");
    },
    reset: async () => {
      lifecycleCurrent = false;
      await writeSessionStore({
        entries: {
          main: sessionStoreEntry("sess-main", {
            label: "newer owner",
            lifecycleRevision: "replacement-revision",
          }),
        },
      });
    },
  });
  const { performGatewaySessionReset } = await import("./session-reset-service.js");

  try {
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
        sessionId: "sess-main",
      },
    });
    expect(
      await loadTranscriptEvents({
        agentId: "main",
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        storePath,
      }),
    ).toEqual([]);
    expect(sessionLifecycleHookMocks.runSessionEnd).not.toHaveBeenCalled();
    expect(sessionLifecycleHookMocks.runSessionStart).not.toHaveBeenCalled();
    expect(subagentLifecycleHookMocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(threadBindingMocks.unbindThreadBindingsBySessionKey).not.toHaveBeenCalled();
  } finally {
    restoreRegisteredAgentHarnesses(registeredHarnesses);
  }
});

test("sessions.reset rejects a stale expected session without interrupting current work", async () => {
  const sessionKey = "agent:main:subagent:guarded-reset";
  const currentSessionId = "sess-current";
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: { [sessionKey]: sessionStoreEntry(currentSessionId) },
  });
  let interrupted = false;
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [sessionKey, currentSessionId],
    assertAllowed: () => {},
    onInterrupt: () => {
      interrupted = true;
    },
  });

  try {
    const reset = await directSessionReq("sessions.reset", {
      key: sessionKey,
      expectedSessionId: "sess-stale",
    });

    expect(reset).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        details: { reason: "session-changed" },
      },
    });
    expect(interrupted).toBe(false);
    expect(loadSessionEntry({ sessionKey, storePath })?.sessionId).toBe(currentSessionId);
  } finally {
    admission.release();
  }
});

test("sessions.reset rechecks the expected session before interrupting replacement work", async () => {
  const sessionKey = "agent:main:subagent:guarded-reset-race";
  const observedSessionId = "sess-observed";
  const replacementSessionId = "sess-replacement";
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: { [sessionKey]: sessionStoreEntry(observedSessionId) },
  });
  let replacementInterrupted = false;
  const replacementAdmission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [sessionKey, replacementSessionId],
    assertAllowed: () => {},
    onInterrupt: () => {
      replacementInterrupted = true;
    },
  });
  const { performGatewaySessionReset } = await import("./session-reset-service.js");
  let replaced = false;

  try {
    const reset = await performGatewaySessionReset({
      key: sessionKey,
      reason: "reset",
      commandSource: "gateway:sessions.reset",
      workerPlacementContext: {},
      expectedSessionId: observedSessionId,
      assertCurrent: () => {
        if (!replaced) {
          replaced = true;
          replaceSessionEntrySync(
            { sessionKey, storePath },
            sessionStoreEntry(replacementSessionId),
          );
        }
      },
    });

    expect(reset).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", details: { reason: "session-changed" } },
    });
    expect(replaced).toBe(true);
    expect(replacementInterrupted).toBe(false);
    expect(loadSessionEntry({ sessionKey, storePath })?.sessionId).toBe(replacementSessionId);
  } finally {
    replacementAdmission.release();
  }
});

test("sessions.reset classifies a post-drain replacement as session-changed", async () => {
  const sessionKey = "agent:main:subagent:guarded-reset-post-drain-race";
  const observedSessionId = "sess-observed";
  const replacementSessionId = "sess-replacement";
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: { [sessionKey]: sessionStoreEntry(observedSessionId) },
  });
  const { performGatewaySessionReset } = await import("./session-reset-service.js");

  const reset = await performGatewaySessionReset({
    key: sessionKey,
    reason: "reset",
    commandSource: "gateway:sessions.reset",
    workerPlacementContext: {},
    expectedSessionId: observedSessionId,
    prepareLifecycle: async () => {
      replaceSessionEntrySync({ sessionKey, storePath }, sessionStoreEntry(replacementSessionId));
      return { ok: true, value: {} };
    },
  });

  expect(reset).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", details: { reason: "session-changed" } },
  });
  expect(loadSessionEntry({ sessionKey, storePath })?.sessionId).toBe(replacementSessionId);
});
