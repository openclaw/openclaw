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

async function holdControllerTurn(
  sessionId: string,
  existing?: ReturnType<typeof captureSessionTarget>,
) {
  const target =
    existing ??
    captureSessionTarget({
      storeScope: (await seedParent(sessionId)).storePath,
      sessionKey: "agent:main:main",
      aliases: ["main", sessionId],
      incarnation: sessionId,
      agentId: "main",
    });
  const release = createDeferredCore();
  const started = createDeferredCore();
  const interrupted = createDeferredCore();
  let running = false;
  const work = withSessionTurn(
    { sessionKey: target.sessionKey, sessionId, target },
    async (_operation, signal) => {
      signal.addEventListener("abort", () => interrupted.resolve(), { once: true });
      running = true;
      started.resolve();
      await release.promise;
    },
  );
  return {
    started: started.promise,
    interrupted: interrupted.promise,
    release: release.resolve,
    target,
    work,
    isRunning: () => running,
  };
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
  expect(sessionLifecycleHookMocks.runSessionStart.mock.calls[0]?.[0]).toMatchObject({
    sessionKey: result.payload?.key,
  });
});

test.each([
  [
    /fork/i,
    true,
    { parentSessionKey: "main", emitCommandHooks: true, fork: true, succeedsParent: true },
  ],
  [/parentSessionKey/i, false, { emitCommandHooks: true, succeedsParent: false }],
  [/emitCommandHooks/i, true, { parentSessionKey: "main", succeedsParent: false }],
] as const)("sessions.create rejects invalid disposition: %s", async (message, parent, params) => {
  if (parent) {
    await seedParent("sess-invalid-disposition");
  } else {
    await createSessionStoreDir();
  }
  const result = await directSessionReq("sessions.create", { key: "child", ...params });
  expect(result).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: expect.stringMatching(message) },
  });
  expect(sessionLifecycleHookMocks.runSessionEnd).not.toHaveBeenCalled();
});

test("sessions.reset waits for captured turn settlement before same-id cleanup", async () => {
  const sessionId = "sess-provider-cleanup";
  const active = await holdControllerTurn(sessionId);
  await active.started;
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
  providerRuntimeMocks.cleanupSessionResources.mockClear();
  const active = await holdControllerTurn(sessionId);
  await active.started;
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

  const replacement = await holdControllerTurn(sessionId, active.target);
  await Promise.resolve();
  expect(replacement.isRunning()).toBe(false);
  expect(providerRuntimeMocks.cleanupSessionResources).not.toHaveBeenCalled();

  retirement.resolve();
  expect((await reset).ok).toBe(true);
  expect(providerRuntimeMocks.cleanupSessionResources).toHaveBeenCalledOnce();
  await replacement.started;
  replacement.release();
  await replacement.work;
});
