import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getDeterministicFreePortBlock } from "../test-utils/ports.js";
import * as coreRuntime from "./server-core-runtime.js";
import { createGatewayKernel } from "./server-kernel.js";
import * as lifecycleRuntime from "./server-lifecycle.js";

describe("Gateway startup scheduling", () => {
  it.each([false, true])(
    "services queued tasks after preparing shutdown (cancel: %s)",
    async (cancel) => {
      const port = await getDeterministicFreePortBlock({ offsets: [0] });
      const token = "gateway-startup-fairness-token-1234567890";
      const state = await createOpenClawTestState({
        label: "gateway-startup-fairness",
        layout: "home",
        scenario: "gateway-loopback",
        gateway: { port, token },
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
      const events: string[] = [];
      const prepareLifecycle = lifecycleRuntime.prepareGatewayLifecycle;
      const startCore = coreRuntime.startGatewayCoreRuntime;
      let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
      let pendingTask: Promise<void> | undefined;
      vi.spyOn(lifecycleRuntime, "prepareGatewayLifecycle").mockImplementation(async (params) => {
        const prepared = await prepareLifecycle(params);
        events.push("shutdown prepared");
        // Queue in the kernel's timer phase; message-port ordering relative to timers varies.
        pendingTask = delay(0).then(async () => {
          events.push("queued task");
          if (cancel) {
            await prepared.beginClosePrelude();
          }
        });
        void pendingTask.catch(() => {});
        return prepared;
      });
      const start = vi
        .spyOn(coreRuntime, "startGatewayCoreRuntime")
        .mockImplementation(async (params) => {
          events.push("core startup");
          return await startCore(params);
        });
      await runQaGatewayFixture(
        async () => {
          const startup = createGatewayKernel(port, {
            auth: { mode: "token", token },
            bind: "loopback",
            controlUiEnabled: false,
            sidecarStartup: "defer",
          }).then((created) => {
            kernel = created;
            return created;
          });
          if (cancel) {
            await expect(startup).rejects.toThrow();
            expect(start).not.toHaveBeenCalled();
            expect(events).toEqual(["shutdown prepared", "queued task"]);
            expect(getActiveGatewayRootWorkCount()).toBe(0);
            expect(getActiveSecretsRuntimeConfigSnapshot()).toBeNull();
          } else {
            kernel = await startup;
            expect(events).toEqual(["shutdown prepared", "queued task", "core startup"]);
            expect(kernel.startupState.dispatchReady).toBe(false);
            expect(kernel.lifecycle.closePreludeStarted).toBe(false);
          }
        },
        async () => {
          await pendingTask;
        },
        async () => {
          await kernel?.closeOnStartupFailure();
        },
        async () => {
          vi.restoreAllMocks();
          await state.cleanup();
        },
      );
    },
  );
});
