import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import type { GatewayServer } from "./server-public.js";

describe("Gateway post-ready startup work", () => {
  it.each(["settles", "closes"] as const)(
    "holds post-ready maintenance until deferred startup %s",
    async (outcome) => {
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
      const resumed = vi.fn<(closing: boolean) => void>();
      const startMaintenance = vi.fn(async () => null);
      let server: GatewayServer | undefined;
      let realStartup: Promise<void> | undefined;
      let postReadyWork: Promise<void> | undefined;
      let closeOutcome: Promise<void> | undefined;
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
        await delay(600);
        expect(startMaintenance).not.toHaveBeenCalled();
        expect(resumed).not.toHaveBeenCalled();

        if (outcome === "closes") {
          vi.useFakeTimers({
            toFake: ["setTimeout", "clearTimeout"],
            shouldClearNativeTimers: true,
          });
          closeOutcome = server.close();
          await postReadyWork;
          expect(resumed).toHaveBeenCalledExactlyOnceWith(true);
          startup.resolve();
          await closeOutcome;
          expect(startMaintenance).not.toHaveBeenCalled();
          expect(vi.getTimerCount()).toBe(0);
        } else {
          startup.resolve();
          await server.startupSettled;
          await delay(600);
          await postReadyWork;
          expect(resumed).toHaveBeenCalledExactlyOnceWith(false);
          expect(startMaintenance).toHaveBeenCalledOnce();
        }
      } finally {
        startup.resolve();
        try {
          await closeOutcome;
          await server?.close();
          await postReadyWork;
          await state.cleanup();
        } finally {
          vi.useRealTimers();
          startupFactory.mockRestore();
          earlyFactory.mockRestore();
          vi.restoreAllMocks();
        }
      }
    },
  );
});
