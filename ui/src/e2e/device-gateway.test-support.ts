import { createHash } from "node:crypto";
import type { Page } from "playwright";
import { expect } from "vitest";
import type { OpenClawConfig } from "../../../src/config/types.js";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { approveDevicePairing } from "../../../src/infra/device-pairing-approval.js";
import { requestDevicePairing } from "../../../src/infra/device-pairing.js";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";

export async function readUiBundle(page: Page) {
  const script = await page.locator('script[type="module"][src]').first().getAttribute("src");
  expect(script).toBeTruthy();
  const assetUrl = new URL(script!, page.url());
  expect(assetUrl.origin).toBe(new URL(page.url()).origin);
  const response = await page.request.get(assetUrl.href);
  expect(response.ok()).toBe(true);
  return {
    path: assetUrl.pathname,
    sha256: createHash("sha256")
      .update(await response.body())
      .digest("hex"),
  };
}

export const deviceGatewayEnv = {
  OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
  OPENCLAW_SKIP_CANVAS_HOST: "1",
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_SKIP_CRON: "1",
  OPENCLAW_SKIP_GMAIL_WATCHER: "1",
  OPENCLAW_SKIP_PROVIDERS: "1",
  OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
  VITEST: "1",
};

export async function approvePairing(params: Parameters<typeof requestDevicePairing>[0]) {
  const request = await requestDevicePairing(params);
  await approveDevicePairing(request.request.requestId, { callerScopes: ["operator.admin"] });
}

export async function createDeviceGateway(
  label: string,
  baseUrl: string,
  auth: NonNullable<NonNullable<OpenClawConfig["gateway"]>["auth"]>,
  config: OpenClawConfig = {},
) {
  const port = await getFreePort();
  const state = await createOpenClawTestState({ label, layout: "home", env: deviceGatewayEnv });
  let server: GatewayServer | undefined;
  const close = () => server?.close({ reason: `${label} restart or cleanup` });
  return {
    port,
    state,
    async configure() {
      await state.writeConfig({
        ...config,
        gateway: {
          auth,
          controlUi: { allowedOrigins: [new URL(baseUrl).origin], enabled: false },
          port,
        },
      });
      state.applyEnv();
    },
    async start() {
      const { startGatewayServer } = await import("../../../src/gateway/server.js");
      server = await startGatewayServer(port, {
        auth,
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
    },
    close,
  };
}
