import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { GatewaySchedulerClock } from "../infra/gateway-scheduler.js";
import { createGatewaySchedulerClock } from "../test-utils/gateway-scheduler-clock.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import type { GatewayServer } from "./server-public.js";

const schedulerClock = vi.hoisted(() => ({
  current: undefined as GatewaySchedulerClock | undefined,
}));

vi.mock("../infra/gateway-scheduler.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/gateway-scheduler.js")>();
  return {
    ...actual,
    GatewayScheduler: class extends actual.GatewayScheduler {
      constructor(options: ConstructorParameters<typeof actual.GatewayScheduler>[0] = {}) {
        super({ ...options, clock: schedulerClock.current ?? options.clock });
      }
    },
  };
});

describe("Gateway post-ready startup work", () => {
  it.each(["settles", "closes", "repair-closes"] as const)(
    "holds post-ready maintenance until deferred startup %s",
    async (outcome) => {
      const clock = createGatewaySchedulerClock();
      schedulerClock.current = clock.clock;
      const port = await getFreePort();
      const state = await createOpenClawTestState({
        label: `gateway-post-ready-${outcome}`,
        layout: "home",
        env: {
          OPENCLAW_GATEWAY_PASSWORD: undefined,
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
          VITEST: "1",
        },
      });
      state.envVars.OPENCLAW_TEST_MINIMAL_GATEWAY = undefined;
      const startup = createDeferred();
      const repairStarted = createDeferred();
      const repairRelease = createDeferred();
      const resumed = vi.fn<(closing: boolean) => void>();
      const startMaintenance = vi.fn(async () => null);
      let server: GatewayServer | undefined;
      let realStartup: Promise<void> | undefined;
      let postReadyWork: Promise<void> | undefined;
      let closeOutcome: Promise<void> | undefined;
      let beforeReadyWake: void | Promise<void> = undefined;
      let repairWake: void | Promise<void> = undefined;
      const plugins = await import("./server-startup-plugins.js");
      vi.spyOn(plugins, "runGatewayPostReadyStartupMaintenance").mockImplementation(async () => {
        repairStarted.resolve();
        await repairRelease.promise;
        throw new Error("synthetic optional repair failure");
      });
      const earlyModule = await import("./server-startup-early.js");
      const startEarlyRuntime = earlyModule.startGatewayEarlyRuntime;
      const earlyFactory = vi
        .spyOn(earlyModule, "startGatewayEarlyRuntime")
        .mockImplementation(async (...args) => ({
          ...(await startEarlyRuntime(...args)),
          startMaintenance,
        }));
      const startupModule = await import("./server-startup-finish.js");
      const finishStartup = startupModule.finishGatewayStartup;
      const startupFactory = vi
        .spyOn(startupModule, "finishGatewayStartup")
        .mockImplementation(async (params) => {
          const result = await finishStartup(params);
          realStartup = result.startupSettled;
          const owner = params.kernelRuntime;
          postReadyWork = owner.connectionWork.track(() =>
            params.waitForPostReadyWork().then(() => {
              resumed(owner.lifecycle.closePreludeStarted);
            }),
          );
          const startupSettled = owner.connectionWork.track(async () => {
            await result.startupSettled;
            await startup.promise;
          });
          return { ...result, startupSettled };
        });
      try {
        const token = "gateway-post-ready-maintenance-token";
        await state.writeConfig({
          gateway: { auth: { mode: "token", token }, controlUi: { enabled: false }, port },
          plugins: { enabled: false },
          discovery: { mdns: { mode: "off" } },
        });
        state.applyEnv();
        const { startGatewayServerCore } = await import("./server-start.js");
        server = await startGatewayServerCore(port, {
          auth: { mode: "token", token },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        await realStartup;
        // Let both production grace periods elapse while published startup is pending.
        beforeReadyWake = clock.advanceBy(600);
        expect(startMaintenance).not.toHaveBeenCalled();
        expect(resumed).not.toHaveBeenCalled();

        if (outcome === "closes") {
          closeOutcome = server.close();
          await postReadyWork;
          expect(resumed).toHaveBeenCalledExactlyOnceWith(true);
          startup.resolve();
          await server.startupSettled;
          expect(clock.armedAtMs).toBeNull();
          await closeOutcome;
          await beforeReadyWake;
          expect(startMaintenance).not.toHaveBeenCalled();
        } else {
          startup.resolve();
          await server.startupSettled;
          await clock.advanceBy(499);
          expect(resumed).not.toHaveBeenCalled();
          repairWake = clock.advanceBy(1);
          await postReadyWork;
          await repairStarted.promise;
          expect(resumed).toHaveBeenCalledExactlyOnceWith(false);
          expect(startMaintenance).not.toHaveBeenCalled();
          const readiness = await fetch(`http://127.0.0.1:${port}/readyz`);
          expect(readiness.status).toBe(200);
          if (outcome === "repair-closes") {
            let closed = false;
            closeOutcome = server.close().then(() => {
              closed = true;
            });
            await Promise.resolve();
            expect(closed).toBe(false);
          }
          repairRelease.resolve();
          await repairWake;
          await beforeReadyWake;
          await closeOutcome;
          if (outcome === "settles") {
            // Failed optional repair must not suppress the periodic maintenance owner.
            expect(startMaintenance).toHaveBeenCalledOnce();
          }
        }
      } finally {
        startup.resolve();
        repairRelease.resolve();
        try {
          await closeOutcome;
          await server?.close();
          await postReadyWork;
          await beforeReadyWake;
          await repairWake;
          await state.cleanup();
        } finally {
          schedulerClock.current = undefined;
          startupFactory.mockRestore();
          earlyFactory.mockRestore();
          vi.restoreAllMocks();
        }
      }
    },
  );
});
