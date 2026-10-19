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

const cleanupSessionResources = vi.hoisted(() => vi.fn());
vi.mock(import("@openclaw/ai/internal/runtime"), async (importOriginal) => ({
  ...(await importOriginal()),
  cleanupSessionResources,
}));

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

async function seedParent(sessionId: string) {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({ entries: { main: { sessionId, updatedAt: Date.now() } } });
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
  const { promise: released, resolve: release } = createDeferredCore();
  const { promise: started, resolve: begin } = createDeferredCore();
  const { promise: interrupted, resolve: interrupt } = createDeferredCore();
  let running = false;
  const work = withSessionTurn(
    { sessionKey: target.sessionKey, sessionId, target },
    async (_operation, signal) => {
      signal.addEventListener("abort", () => interrupt(), { once: true });
      running = true;
      begin();
      await released;
    },
  );
  return { started, interrupted, release, target, work, isRunning: () => running };
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

test.for([false, true])("sessions.reset settlement (replacement=%s)", async (replace) => {
  const sessionId = `sess-provider-${replace ? "replacement" : "cleanup"}`;
  if (replace) {
    cleanupSessionResources.mockClear();
  }
  const active = await holdControllerTurn(sessionId);
  await active.started;
  const retirement = createDeferredCore();
  const retirementStarted = createDeferredCore();
  if (replace) {
    bundleMcpRuntimeMocks.retireSessionMcpRuntime.mockImplementation(async () => {
      retirementStarted.resolve();
      await retirement.promise;
      return true;
    });
  }
  let resetSettled = false;
  const reset = directSessionReq("sessions.reset", { key: "main", reason: "new" }).finally(() => {
    resetSettled = true;
  });
  await active.interrupted;
  await Promise.resolve();
  expect(resetSettled).toBe(false);
  expect(cleanupSessionResources).not.toHaveBeenCalled();
  active.release();
  await active.work;

  let replacement: Awaited<ReturnType<typeof holdControllerTurn>> | undefined;
  if (replace) {
    await retirementStarted.promise;
    replacement = await holdControllerTurn(sessionId, active.target);
    await Promise.resolve();
    expect(replacement.isRunning()).toBe(false);
    expect(cleanupSessionResources).not.toHaveBeenCalled();
    retirement.resolve();
  }
  expect((await reset).ok).toBe(true);
  expect(cleanupSessionResources).toHaveBeenCalledWith(sessionId);
  if (replacement) {
    expect(cleanupSessionResources).toHaveBeenCalledOnce();
    await replacement.started;
    replacement.release();
    await replacement.work;
  } else {
    const count = cleanupSessionResources.mock.calls.length;
    await Promise.resolve();
    expect(cleanupSessionResources).toHaveBeenCalledTimes(count);
  }
});
