import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createCloseMock,
  createRuntimeWithExitSignal,
  createSignaledStart,
  waitForStart,
  withIsolatedSignals,
} from "./run-loop.test-support.js";

const fixture = vi.hoisted(() => ({
  releaseLock: vi.fn(async () => {}),
  error: vi.fn(),
}));
vi.mock("../../infra/gateway-lock.js", () => ({
  acquireGatewayLock: async () => ({ release: fixture.releaseLock }),
}));
vi.mock("../../infra/systemd-stop-timeout.js", () => ({
  readSystemdStopTimeout: async () => null,
}));
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: fixture.error,
  }),
}));
vi.mock("../../logging/logger.js", () => ({ flushLogger: async () => {} }));

// Prepare transforms and compiled subprocesses before case deadlines; cases reset evaluation.
await import("../../infra/runtime-process-entrypoints.js");
await import("./run-loop.js");

let activeCase: Promise<void> | undefined;
afterEach(async () => {
  // A timed-out body retains its mocks until its owned loop and cleanup settle.
  await activeCase?.catch(() => {});
  activeCase = undefined;
  vi.doUnmock("./lifecycle.runtime.js");
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

type LifecycleRuntime = typeof import("./lifecycle.runtime.js");

describe("gateway lifecycle hub import boundaries", () => {
  it("re-exports primed symbols from their defining modules instead of facades", () => {
    const hub = readFileSync(new URL("./lifecycle.runtime.ts", import.meta.url), "utf8");
    expect(hub).toContain('from "../../gateway/server-reload-generation.js"');
    expect(hub).not.toContain('from "../../gateway/server-reload-hot.js"');
    expect(hub).not.toContain('from "../../gateway/server-reload-managed.js"');
    expect(hub).not.toContain("main-session-restart-recovery");
  });

  it.for(["SIGTERM", "SIGUSR2"] as const)(
    "finishes priming before installing signals and handles %s after dist chunk rotation",
    (signal, { signal: abortSignal }) => {
      const work = (async () => {
        vi.resetModules();
        const importing = createDeferredCore();
        const finishImport = createDeferredCore();
        const fixtureStopped = new Error("fixture stopped");
        const startupSettled = createDeferredCore();
        void startupSettled.promise.catch(() => {});
        const releaseFixture = () => {
          finishImport.resolve();
          startupSettled.reject(fixtureStopped);
        };
        abortSignal.addEventListener("abort", releaseFixture, { once: true });
        if (abortSignal.aborted) {
          releaseFixture();
        }
        try {
          let primed = false;
          const hub = {
            detectGatewayRespawnSupervisorIdentity: () => ({
              kind: "systemd" as const,
              name: "test",
            }),
            resolveGatewayRestartDecision: () => ({ mode: "supervised", supervisor: "systemd" }),
            registerGatewayRuntimeRecovery: () => () => {},
            requestGatewayRestartWithSignalAdmission:
              vi.fn<LifecycleRuntime["requestGatewayRestartWithSignalAdmission"]>(),
            captureForegroundUpdateHandoffStop: () => undefined,
            waitForSystemServiceUpdateHandoffs: () => undefined,
            isGatewayRestartExternallyAllowed: () => false,
            scheduleGatewayRestart: vi.fn<LifecycleRuntime["scheduleGatewayRestart"]>(),
            prepareGatewayRestartIntentConsumption: vi.fn(() => async () => null),
            consumeGatewayRestartAuthorization: () => true,
            consumeGatewayRestartIntent: () => null,
            peekGatewayRestartReason: () => undefined,
            markGatewayRestartHandled: vi.fn(),
            abortPendingChannelReloads: vi.fn(),
            markGatewayDraining: vi.fn(),
            abortActiveCronTaskRuns: vi.fn(() => 0),
            stopActiveManagedProviderLocalServices: vi.fn(async () => {}),
            restartGatewayProcessWithFreshPid: vi.fn(() => ({ mode: "supervised" as const })),
            writeGatewayRestartHandoff: vi.fn(async () => null),
          } satisfies Partial<LifecycleRuntime>;
          vi.doMock("./lifecycle.runtime.js", async () => {
            importing.resolve();
            await finishImport.promise;
            primed = true;
            return hub;
          });
          const { runGatewayLoop } = await import("./run-loop.test-support.js");
          abortSignal.throwIfAborted();
          await withIsolatedSignals(async ({ captureSignal }) => {
            const originalOn = process.on.bind(process);
            const installed: string[] = [];
            vi.spyOn(process, "on").mockImplementation((event, listener) => {
              if (event === "SIGTERM" || event === "SIGINT" || event === "SIGUSR2") {
                expect(primed, `lifecycle import must finish before installing ${event}`).toBe(
                  true,
                );
                installed.push(event);
              }
              return originalOn(event, listener);
            });
            const close = createCloseMock();
            const { start, started } = createSignaledStart(close, startupSettled.promise);
            const { runtime, exited } = createRuntimeWithExitSignal();
            const completeBoot = vi.fn();
            const loop = runGatewayLoop({ start, runtime, completeBoot });
            void loop.catch(() => {});
            try {
              await Promise.race([importing.promise, loop]);
              abortSignal.throwIfAborted();
              expect(installed).toEqual([]);
              expect(start).not.toHaveBeenCalled();
              finishImport.resolve();
              await Promise.race([waitForStart(started), loop]);
              abortSignal.throwIfAborted();
              expect(installed).toEqual(["SIGTERM", "SIGINT", "SIGUSR2"]);

              const missingChunk = vi.fn(() => {
                throw Object.assign(new Error("rotated lifecycle chunk"), {
                  code: "ERR_MODULE_NOT_FOUND",
                });
              });
              vi.doMock("./lifecycle.runtime.js", missingChunk);
              // Prove new imports fail while the already-running owner retains its hub.
              await expect(import("./lifecycle.runtime.js")).rejects.toThrow();
              expect(missingChunk).toHaveBeenCalledOnce();
              missingChunk.mockClear();
              captureSignal(signal)();
              await vi.waitFor(() => expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(0));
              await expect(exited).resolves.toBe(0);
              expect(missingChunk).not.toHaveBeenCalled();
              expect(hub.prepareGatewayRestartIntentConsumption).toHaveBeenCalledOnce();
              expect(close).toHaveBeenCalledOnce();
              expect(hub.stopActiveManagedProviderLocalServices).toHaveBeenCalledOnce();
              expect(fixture.releaseLock).toHaveBeenCalledOnce();
              expect(fixture.error).not.toHaveBeenCalled();
              expect(completeBoot).toHaveBeenCalledWith(
                expect.objectContaining({
                  outcome: signal === "SIGUSR2" ? "planned_restart" : "clean_stop",
                }),
              );
              if (signal === "SIGUSR2") {
                expect(hub.restartGatewayProcessWithFreshPid).toHaveBeenCalledOnce();
                expect(hub.writeGatewayRestartHandoff).toHaveBeenCalledOnce();
              }
            } finally {
              releaseFixture();
              if (start.mock.calls.length && !runtime.exit.mock.calls.length) {
                captureSignal("SIGINT")();
                await exited;
              }
              await loop.catch(() => {});
            }
          });
        } finally {
          releaseFixture();
          abortSignal.removeEventListener("abort", releaseFixture);
        }
      })();
      activeCase = work;
      return work;
    },
  );
});
