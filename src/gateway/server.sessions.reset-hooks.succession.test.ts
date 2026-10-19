// Session creation disposition and deferred runtime cleanup.
import { expect, test, vi } from "vitest";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  beforeResetHookMocks,
  beforeResetHookState,
  bundleMcpRuntimeMocks,
  directSessionReq,
  seedSessionTranscript,
  sessionLifecycleHookMocks,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const providerRuntimeMocks = vi.hoisted(() => ({ cleanupSessionResources: vi.fn() }));

vi.mock("@openclaw/ai/internal/runtime", async () => {
  const actual = await vi.importActual<typeof import("@openclaw/ai/internal/runtime")>(
    "@openclaw/ai/internal/runtime",
  );
  return { ...actual, cleanupSessionResources: providerRuntimeMocks.cleanupSessionResources };
});

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

type HookEvent = {
  sessionKey?: string;
  nextSessionKey?: string;
};

function firstHookEvent(mock: { mock: { calls: unknown[][] } }): HookEvent {
  const call = mock.mock.calls.at(0);
  if (!call) {
    throw new Error("Expected hook call");
  }
  return call[0] as HookEvent;
}

async function seedParent(sessionId: string) {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: { main: { sessionId, updatedAt: Date.now() } },
  });
  await seedSessionTranscript({
    agentId: "main",
    sessionId,
    sessionKey: "agent:main:main",
    storePath,
    messages: [{ role: "user", content: "before child creation", id: "m1" }],
  });
  return { storePath };
}

async function startHeldControllerTurn(params: { sessionId: string; storePath: string }) {
  const release = createDeferredCore();
  const started = createDeferredCore();
  const interrupted = createDeferredCore();
  const target = captureSessionTarget({
    storeScope: params.storePath,
    sessionKey: "agent:main:main",
    aliases: ["main", params.sessionId],
    incarnation: params.sessionId,
    agentId: "main",
  });
  const work = withSessionTurn(
    { sessionKey: target.sessionKey, sessionId: params.sessionId, target },
    async (_operation, signal) => {
      signal.addEventListener("abort", () => interrupted.resolve(), { once: true });
      started.resolve();
      await release.promise;
    },
  );
  await started.promise;
  return { interrupted: interrupted.promise, release: release.resolve, target, work };
}

test("sessions.create keeps the parent active for an explicit parallel child", async () => {
  await seedParent("sess-parallel");
  beforeResetHookState.hasBeforeResetHook = true;

  const result = await directSessionReq<{ key: string }>("sessions.create", {
    parentSessionKey: "main",
    emitCommandHooks: true,
    succeedsParent: false,
  });

  expect(result.ok).toBe(true);
  expect(result.payload?.key).toMatch(/^agent:main:dashboard:/);
  expect(beforeResetHookMocks.runBeforeReset).toHaveBeenCalledTimes(1);
  expect(sessionLifecycleHookMocks.runSessionEnd).not.toHaveBeenCalled();
  expect(firstHookEvent(sessionLifecycleHookMocks.runSessionStart).sessionKey).toBe(
    result.payload?.key,
  );
});

test("sessions.create rejects an explicit successor fork", async () => {
  await seedParent("sess-fork");

  const result = await directSessionReq("sessions.create", {
    key: "forked-child",
    parentSessionKey: "main",
    emitCommandHooks: true,
    fork: true,
    succeedsParent: true,
  });

  expect(result.ok).toBe(false);
  expect(result.error).toMatchObject({ code: "INVALID_REQUEST" });
  expect(result.error?.message).toMatch(/fork/i);
  expect(sessionLifecycleHookMocks.runSessionEnd).not.toHaveBeenCalled();
});

test("sessions.create requires a parent for either explicit disposition", async () => {
  await createSessionStoreDir();

  const result = await directSessionReq("sessions.create", {
    key: "parallel-child",
    emitCommandHooks: true,
    succeedsParent: false,
  });

  expect(result.ok).toBe(false);
  expect(result.error).toMatchObject({ code: "INVALID_REQUEST" });
  expect(result.error?.message).toMatch(/parentSessionKey/i);
});

test("sessions.create requires command hooks for either explicit disposition", async () => {
  await seedParent("sess-no-hooks");

  const result = await directSessionReq("sessions.create", {
    key: "parallel-child",
    parentSessionKey: "main",
    succeedsParent: false,
  });

  expect(result.ok).toBe(false);
  expect(result.error).toMatchObject({ code: "INVALID_REQUEST" });
  expect(result.error?.message).toMatch(/emitCommandHooks/i);
});

test("sessions.reset waits for captured turn settlement before same-id cleanup", async () => {
  const sessionId = "sess-provider-cleanup";
  const { storePath } = await seedParent(sessionId);
  const active = await startHeldControllerTurn({ sessionId, storePath });
  let resetSettled = false;
  const resetPromise = directSessionReq("sessions.reset", { key: "main", reason: "new" }).finally(
    () => {
      resetSettled = true;
    },
  );
  await active.interrupted;
  await Promise.resolve();

  expect(resetSettled).toBe(false);
  expect(providerRuntimeMocks.cleanupSessionResources).not.toHaveBeenCalled();

  active.release();
  await active.work;
  const reset = await resetPromise;
  expect(reset.ok).toBe(true);
  expect(providerRuntimeMocks.cleanupSessionResources).toHaveBeenCalledWith(sessionId);
  const cleanupCount = providerRuntimeMocks.cleanupSessionResources.mock.calls.length;
  await Promise.resolve();
  expect(providerRuntimeMocks.cleanupSessionResources).toHaveBeenCalledTimes(cleanupCount);
});

test("sessions.reset blocks same-id replacement until retirement completes", async () => {
  const sessionId = "sess-provider-ended-replacement";
  const { storePath } = await seedParent(sessionId);
  providerRuntimeMocks.cleanupSessionResources.mockClear();
  const active = await startHeldControllerTurn({ sessionId, storePath });
  const retirement = createDeferredCore();
  const retirementStarted = createDeferredCore();
  bundleMcpRuntimeMocks.retireSessionMcpRuntime.mockImplementation(async () => {
    retirementStarted.resolve();
    await retirement.promise;
    return true;
  });

  const reset = directSessionReq("sessions.reset", { key: "main", reason: "new" });
  await active.interrupted;
  active.release();
  await active.work;
  await retirementStarted.promise;

  const replacementStarted = createDeferredCore();
  const releaseReplacement = createDeferredCore();
  const replacement = withSessionTurn(
    { sessionKey: active.target.sessionKey, sessionId, target: active.target },
    async () => {
      replacementStarted.resolve();
      await releaseReplacement.promise;
    },
  );
  let replacementIsRunning = false;
  void replacementStarted.promise.then(() => {
    replacementIsRunning = true;
  });
  await Promise.resolve();
  expect(replacementIsRunning).toBe(false);
  expect(providerRuntimeMocks.cleanupSessionResources).not.toHaveBeenCalled();

  retirement.resolve();
  expect((await reset).ok).toBe(true);
  expect(providerRuntimeMocks.cleanupSessionResources).toHaveBeenCalledOnce();
  await replacementStarted.promise;
  releaseReplacement.resolve();
  await replacement;
});
