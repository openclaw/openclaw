import { expect, it } from "vitest";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

it("starts with provider settings without model rows when a channel is auto-enabled", async () => {
  const token = "provider-overlay-startup-token";
  const state = await createOpenClawTestState({
    label: "provider-overlay-startup",
    env: {
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
    },
  });
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
  try {
    state.applyEnv();
    gateway = await startGatewayWithClient({
      configPath: state.configPath,
      token,
      cfg: {
        agents: { entries: { main: { default: true } } },
        models: { providers: { openai: { apiKey: "synthetic-provider-key" }, codex: {} } },
        channels: { telegram: { botToken: "123456:synthetic-test-token" } },
        gateway: { auth: { mode: "token", token } },
      },
    });
    await gateway.server.startupSettled;
    await expect(gateway.client.request("health", {})).resolves.toMatchObject({ ok: true });
  } finally {
    if (gateway) {
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close({ reason: "provider overlay startup test complete" });
    }
    await state.cleanup();
  }
}, 90_000);
