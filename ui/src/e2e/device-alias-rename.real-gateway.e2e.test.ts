import { writeFile } from "node:fs/promises";
import path from "node:path";
import { validateDevicePairRenameParams } from "@openclaw/gateway-protocol";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { listDevicePairing } from "../../../src/infra/device-pairing.js";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  approvePairing,
  createDeviceGateway,
  readUiBundle,
} from "./device-gateway.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI device alias rename with a real Gateway",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const DISPLAY_NAME = "office-workstation.example.test";
const NEW_ALIAS = "🙂".repeat(33);

// Reload remembers the confirmed URL and may not ask again.
async function confirmGatewayUrl(page: Page, options: { required: boolean }) {
  const confirmation = page.locator("openclaw-gateway-url-confirmation");
  const confirmationWait = confirmation.waitFor({
    state: "visible",
    timeout: options.required ? 10_000 : 3_000,
  });
  // A live reload handshake also proves the saved Gateway needs no confirmation.
  await (
    options.required
      ? confirmationWait
      : Promise.race([confirmationWait, waitForControlUiGatewayReady(page, 3_000)])
  ).catch(() => undefined);
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
    await waitForControlUiGatewayReady(page);
  }
  await page.locator(".device-entry .settings-row__title", { hasText: NEW_ALIAS }).waitFor();
}

suite.define(() => {
  it("persists a Devices-page alias rename through the real Gateway across reload and restart", async () => {
    const gateway = await createDeviceGateway(
      "control-ui-device-alias-rename",
      suite.server.baseUrl,
      { mode: "none" },
    );
    const { state, port } = gateway;
    try {
      await gateway.configure();

      const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem } =
        await import("../../../src/infra/device-identity.js");
      const identity = loadOrCreateDeviceIdentity({
        env: state.env,
        identityKey: "device-alias-proof",
      });
      await approvePairing({
        deviceId: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        role: "operator",
        scopes: ["operator.read"],
        clientId: "control-ui-device-alias-proof",
        clientMode: "cli",
        displayName: DISPLAY_NAME,
        platform: "linux",
      });
      await gateway.start();

      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width: 1280 },
        },
        async ({ page }) => {
          await page.goto(devicesPageUrl(port));
          await confirmGatewayUrl(page, { required: true });
          const row = page.locator(".device-entry", { hasText: DISPLAY_NAME });
          await row.waitFor();

          await row.locator(".device-entry__menu-trigger").click();
          await row.locator('[role="menuitem"][data-value="editAlias"]').click();
          const dialog = page.locator("openclaw-modal-dialog").last();
          await dialog.locator('input[name="value"]').waitFor();

          const protocolAccepted = validateDevicePairRenameParams({
            deviceId: identity.deviceId,
            label: NEW_ALIAS,
          });
          expect(protocolAccepted).toBe(true);
          const input = dialog.locator('input[name="value"]');
          await input.click();
          await page.keyboard.insertText(NEW_ALIAS);
          expect(await input.inputValue()).toBe(NEW_ALIAS);
          await dialog.getByRole("button", { name: "Save" }).click();

          await waitForAlias(page);

          // Independent readback proves a durable write, not a client-side label swap.
          const paired = await readPairing(identity.deviceId);
          expect(paired).toMatchObject({ operatorLabel: NEW_ALIAS, displayName: DISPLAY_NAME });

          await waitForAlias(page, true);

          await gateway.close();
          await gateway.start();
          await waitForAlias(page, true);
          const afterRestart = await readPairing(identity.deviceId);
          expect(afterRestart?.operatorLabel).toBe(NEW_ALIAS);
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            await page.screenshot({
              animations: "disabled",
              path: path.join(suite.artifactDir, "06-real-gateway-alias-after-restart.png"),
            });
            await writeFile(
              path.join(suite.artifactDir, "06-real-gateway-alias-after-restart.json"),
              JSON.stringify({
                bundle: await readUiBundle(page),
                deviceId: identity.deviceId,
                alias: afterRestart?.operatorLabel,
              }),
            );
          }
        },
      );
    } finally {
      try {
        await gateway.close();
      } finally {
        await state.cleanup();
      }
    }
  });
});
