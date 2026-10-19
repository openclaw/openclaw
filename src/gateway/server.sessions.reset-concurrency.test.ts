import { afterEach, expect, test, vi } from "vitest";
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
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { beginSessionEffect } from "../sessions/session-controller.lifecycle.js";
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

afterEach(closeOpenClawStateDatabaseForTest);

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
