import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { validateDevicePairRenameParams } from "@openclaw/gateway-protocol";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { approveDevicePairing } from "../../../src/infra/device-pairing-approval.js";
import {
  listDevicePairing,
  requestDevicePairing,
  type PairedDevice,
} from "../../../src/infra/device-pairing.js";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI device alias rename with a real Gateway",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

async function captureUiProof(page: Page, fileName: string, observed: Record<string, unknown>) {
  if (!captureEnabled) {
    return;
  }
  await page.screenshot({
    animations: "disabled",
    path: path.join(suite.artifactDir, fileName),
  });
  const script = await page.locator('script[type="module"][src]').first().getAttribute("src");
  expect(script).toBeTruthy();
  const assetUrl = new URL(script!, page.url());
  expect(assetUrl.origin).toBe(new URL(page.url()).origin);
  const response = await page.request.get(assetUrl.href);
  expect(response.ok()).toBe(true);
  const bundle = {
    path: assetUrl.pathname,
    sha256: createHash("sha256")
      .update(await response.body())
      .digest("hex"),
  };
  await writeFile(
    path.join(suite.artifactDir, fileName.replace(/\.png$/u, ".json")),
    `${JSON.stringify({ ...observed, bundle }, null, 2)}\n`,
    "utf8",
  );
}

const DISPLAY_NAME = "office-workstation.example.test";
const NEW_ALIAS = "🙂".repeat(33);

function pairedDeviceProof(device: PairedDevice | undefined) {
  if (!device) {
    return undefined;
  }
  // Internal pairing rows include credentials; proof needs only identity and naming facts.
  const { deviceId, operatorLabel, displayName, roles } = device;
  return { deviceId, operatorLabel, displayName, roles };
}

// Reload remembers the confirmed URL and may not ask again.
async function confirmGatewayUrl(page: Page, options: { required: boolean }) {
  const confirmation = page.locator("openclaw-gateway-url-confirmation");
  await confirmation
    .waitFor({ state: "visible", timeout: options.required ? 10_000 : 3_000 })
    .catch(() => undefined);
  if (!(await confirmation.isVisible().catch(() => false))) {
    if (options.required) {
      throw new Error("gateway URL confirmation dialog did not appear");
    }
    return;
  }
  await confirmation.getByRole("button", { name: /^Switch to /u }).click();
}

function devicesPageUrl(gatewayPort: number) {
  const url = new URL("settings/devices", suite.server.baseUrl);
  url.searchParams.set("gatewayUrl", `ws://127.0.0.1:${gatewayPort}`);
  return url.toString();
}

async function readPairing(deviceId: string) {
  return (await listDevicePairing()).paired.find((device) => device.deviceId === deviceId);
}

async function waitForAlias(page: Page, reload = false) {
  if (reload) {
    await page.reload();
    await confirmGatewayUrl(page, { required: false });
  }
  await page.locator(".device-entry .settings-row__title", { hasText: NEW_ALIAS }).waitFor();
}

suite.define(() => {
  it("persists a Devices-page alias rename through the real Gateway across reload and restart", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "control-ui-device-alias-rename",
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
      },
    });
    let gateway: GatewayServer | undefined;
    try {
      await state.writeConfig({
        gateway: {
          auth: { mode: "none" },
          controlUi: {
            allowedOrigins: [new URL(suite.server.baseUrl).origin],
            enabled: false,
          },
          port,
        },
      });
      state.applyEnv();

      const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem } =
        await import("../../../src/infra/device-identity.js");
      const identityPath = path.join(state.stateDir, `device-alias-proof.sqlite`);
      const identity = loadOrCreateDeviceIdentity({ path: identityPath });
      const seeded = await requestDevicePairing({
        deviceId: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        role: "operator",
        scopes: ["operator.read"],
        clientId: "control-ui-device-alias-proof",
        clientMode: "cli",
        displayName: DISPLAY_NAME,
        platform: "linux",
      });
      await approveDevicePairing(seeded.request.requestId, {
        callerScopes: ["operator.admin"],
      });

      const { startGatewayServer } = await import("../../../src/gateway/server.js");
      const startGateway = () =>
        startGatewayServer(port, {
          auth: { mode: "none" },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
      gateway = await startGateway();

      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width: 1280 },
          ...(captureEnabled
            ? { recordVideo: { dir: suite.artifactDir, size: { width: 1280, height: 900 } } }
            : {}),
        },
        async ({ page }) => {
          await page.goto(devicesPageUrl(port));
          await confirmGatewayUrl(page, { required: true });
          const row = page.locator(".device-entry", { hasText: DISPLAY_NAME });
          await row.waitFor();
          await captureUiProof(page, "01-real-gateway-devices-inventory.png", {
            stage: "seeded paired device listed",
            displayName: DISPLAY_NAME,
          });

          await row.locator(".device-entry__menu-trigger").click();
          await row.locator('[role="menuitem"][data-value="editAlias"]').click();
          const dialog = page.locator("openclaw-modal-dialog").last();
          await dialog.locator('input[name="value"]').waitFor();
          await captureUiProof(page, "02-real-gateway-alias-dialog-open.png", {
            stage: "rename dialog opened",
          });

          const protocolAccepted = validateDevicePairRenameParams({
            deviceId: identity.deviceId,
            label: NEW_ALIAS,
          });
          expect(protocolAccepted).toBe(true);
          const input = dialog.locator('input[name="value"]');
          await input.click();
          await page.keyboard.insertText(NEW_ALIAS);
          const entered = await input.inputValue();
          await captureUiProof(page, "03-real-gateway-alias-dialog-filled.png", {
            stage: "operator entered a protocol-valid Unicode alias",
            protocolAccepted,
            requestedAlias: NEW_ALIAS,
            enteredAlias: entered,
            requestedCodeUnits: NEW_ALIAS.length,
            enteredCodeUnits: entered.length,
            maxLength: await input.getAttribute("maxlength"),
          });
          expect(entered).toBe(NEW_ALIAS);
          await dialog.getByRole("button", { name: "Save" }).click();

          await waitForAlias(page);

          // Independent readback proves a durable write, not a client-side label swap.
          const paired = await readPairing(identity.deviceId);
          expect(paired).toMatchObject({ operatorLabel: NEW_ALIAS, displayName: DISPLAY_NAME });
          await captureUiProof(page, "04-real-gateway-alias-applied.png", {
            stage: "alias applied and read back from the pairing store",
            paired: pairedDeviceProof(paired),
          });

          await waitForAlias(page, true);
          await captureUiProof(page, "05-real-gateway-alias-after-reload.png", {
            stage: "alias survives full page reload",
          });

          await gateway?.close({ reason: "device alias rename e2e restart" });
          gateway = await startGateway();
          await waitForAlias(page, true);
          const afterRestart = await readPairing(identity.deviceId);
          expect(afterRestart?.operatorLabel).toBe(NEW_ALIAS);
          await captureUiProof(page, "06-real-gateway-alias-after-restart.png", {
            stage: "alias survives Gateway restart",
            paired: pairedDeviceProof(afterRestart),
          });
        },
      );
    } finally {
      try {
        await gateway?.close({ reason: "device alias rename e2e cleanup" });
      } finally {
        await state.cleanup();
      }
    }
  });
});
