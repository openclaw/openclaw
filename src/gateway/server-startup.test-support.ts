import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayServerOptions } from "./server-public.js";

export async function createStartupTestState(
  label: string,
  env: Record<string, string | undefined> = {
    OPENCLAW_GATEWAY_PASSWORD: undefined,
    OPENCLAW_GATEWAY_TOKEN: undefined,
  },
) {
  const state = await createOpenClawTestState({
    label,
    layout: "home",
    env: {
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      VITEST: "1",
      ...env,
    },
  });
  return Object.assign(state, { [Symbol.asyncDispose]: state.cleanup });
}

export function gatewayStartupOptions(token: string): GatewayServerOptions {
  return {
    auth: { mode: "token", token },
    bind: "loopback",
    controlUiEnabled: false,
    sidecarStartup: "defer",
  };
}
