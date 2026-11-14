import { createDeferred } from "../../test/helpers/promise.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";

export function createStartupGate(afterRelease: () => void = () => {}) {
  const entered = createDeferred();
  const released = createDeferred();
  return {
    entered: entered.promise,
    release: released.resolve,
    run: async () => {
      entered.resolve();
      await released.promise;
      afterRelease();
    },
  };
}

export function createGatewayStartupTestState(
  label: string,
  env: Record<string, string | undefined> = {},
) {
  return createOpenClawTestState({
    label,
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
      OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
      VITEST: "1",
      ...env,
    },
  });
}

export function gatewayStartupTestOptions(token: string) {
  return {
    auth: { mode: "token" as const, token },
    bind: "loopback" as const,
    controlUiEnabled: false,
    sidecarStartup: "defer" as const,
  };
}

export function gatewayStartupTestConfig(port: number, token: string) {
  return { port, auth: { mode: "token" as const, token }, controlUi: { enabled: false } };
}
