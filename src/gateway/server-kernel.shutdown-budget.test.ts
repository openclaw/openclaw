import { expect, it } from "vitest";
import { createGatewayHostLifecycle } from "../cli/gateway-cli/host-lifecycle.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { CLI_DEFAULT_OPERATOR_SCOPES } from "./method-scopes.js";
import { dispatchGatewayRequestInProcess } from "./server-in-process-dispatch.js";
import { createGatewayKernel } from "./server-kernel.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

it("reports the current host budget through the registered kernel status handler", async () => {
  const port = await getFreePort();
  const state = await createOpenClawTestState({
    label: "gateway-kernel-shutdown-budget",
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
  let timeoutMs = 25_000;
  const host = createGatewayHostLifecycle({
    isCurrent: () => true,
    isServing: () => true,
    acceptStop: () => {},
    processOwner: { ownsProcessLifecycle: false, supervisor: "systemd" },
    getShutdownBudget: () => ({ timeoutMs, reserveMs: 10_000, nativeStopBudget: true }),
  });
  let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
  try {
    const token = "gateway-kernel-shutdown-budget-token";
    await state.writeConfig({
      gateway: { auth: { mode: "token", token }, controlUi: { enabled: false }, port },
    });
    state.applyEnv();
    kernel = await createGatewayKernel(port, {
      auth: { mode: "token", token },
      bind: "loopback",
      controlUiEnabled: false,
      sidecarStartup: "defer",
      hostLifecycle: host.capability,
    });
    kernel.kernel.unlockStartupMethods();
    kernel.kernel.markSidecarsReady();
    kernel.kernel.setDispatchReady(true);
    const client = createSyntheticPluginRuntimeClient({ scopes: [...CLI_DEFAULT_OPERATOR_SCOPES] });
    for (timeoutMs of [25_000, 325_000]) {
      const response = await dispatchGatewayRequestInProcess(
        "status",
        { includeChannelSummary: false },
        { client, context: kernel.gatewayRequestContext },
      );
      expect(response).toMatchObject({
        pid: process.pid,
        shutdownBudget: {
          timeoutMs,
          reserveMs: 10_000,
          nativeStopBudget: true,
          writeCustody: [],
        },
      });
    }
  } finally {
    try {
      await kernel?.closeOnStartupFailure();
    } finally {
      await host.retire();
      await state.cleanup();
    }
  }
});
