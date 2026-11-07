import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.ts";
import { createOpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { buildProductionControlUiE2e } from "../test-helpers/control-ui-e2e.ts";
import { connectChatGateway } from "./chat-real-gateway.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const artifacts = createControlUiE2eArtifactDir("browser-pair-code-real-gateway");
const uiRoot = path.join(artifacts, "control-ui");
const suite = createControlUiE2eSuite({
  name: "browser code pairing against a real Gateway",
  startServer: async () => {
    await buildProductionControlUiE2e(uiRoot, "browser-pair-code-proof");
    return { baseUrl: "http://127.0.0.1", close: async () => {} };
  },
  setupTimeoutMs: 180_000,
});

async function capture(page: Page, name: string) {
  const surface = page.locator(".login-gate__body");
  const frame = await takeControlUiScreenshotFrame(page, surface, [surface], {
    elements: [surface],
    animations: "disabled",
  });
  await writeFile(path.join(artifacts, name + ".png"), frame.png);
}

async function openPairing(page: Page, url: string) {
  await page.goto(url);
  await page.getByRole("button", { name: "Pair with a code instead", exact: true }).click();
}

async function requestCode(page: Page) {
  await page.getByRole("button", { name: "Get a code", exact: true }).click();
  const identity = page.locator(".login-gate__browser-pair-code");
  await expect.poll(() => identity.textContent()).toContain("Browser ID");
  const code = (await page.locator(".login-gate__command").textContent())?.match(
    /openclaw pair ([A-Z0-9-]+)/,
  )?.[1];
  expect(code).toBeTruthy();
  if (!code) {
    throw new Error("Pairing card did not render its approval command");
  }
  return code;
}

// This composition is deliberately a real HTTP + WebSocket boundary: a mock Gateway
// cannot prove withdrawal of the server request or consumption of the browser token.
suite.define(() => {
  it("withdraws codes, retains offline requests, and connects after administrator approval", async ({
    signal,
  }) => {
    const instance = await createOpenClawTestInstance({
      name: "browser-pair-code",
      entrypoint: [
        "--import",
        "./scripts/tsx.mjs",
        "ui/src/e2e/browser-pair-code-gateway.test-support.ts",
      ],
      config: { gateway: { controlUi: { enabled: true, root: uiRoot } }, cron: { enabled: false } },
    });
    try {
      ensureGatewayOwnerProfile("Synthetic administrator", { env: instance.env });
      await instance.startGateway();
      const admin = await connectChatGateway(instance, signal);
      try {
        await suite.withPage(
          { viewport: { width: 1280, height: 900 } },
          async ({ page, context }) => {
            const url = instance.url.replace("ws:", "http:");
            await openPairing(page, url);
            await capture(page, "after-desktop-intro");
            const withdrawnCode = await requestCode(page);
            const withdrawnRequest = await admin.request<{ requestId: string }>(
              "device.pair.code",
              { code: withdrawnCode },
            );
            await capture(page, "after-desktop-waiting");
            await page.setViewportSize({ width: 390, height: 844 });
            await capture(page, "after-mobile-waiting");
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            ).toBe(true);
            await context.setOffline(true);
            await expect
              .poll(() => page.locator(".login-gate__body").textContent(), { timeout: 20_000 })
              .toContain("Connection interrupted. Retrying with the same code");
            expect(await page.locator(".login-gate__browser-pair-code").textContent()).toContain(
              withdrawnCode,
            );
            await capture(page, "after-mobile-reconnecting");
            await page.getByRole("button", { name: "Cancel", exact: true }).click();
            await expect
              .poll(() => page.locator(".login-gate__body").textContent())
              .toContain("Could not confirm cancellation");
            expect(await page.locator(".login-gate__browser-pair-code").textContent()).toContain(
              withdrawnCode,
            );
            await capture(page, "after-mobile-cancel-offline");
            await context.setOffline(false);
            await page.getByRole("button", { name: "Retry cancellation", exact: true }).click();
            await expect
              .poll(() => page.locator(".login-gate__body").textContent())
              .toContain("Pairing request withdrawn.");
            await capture(page, "after-mobile-cancelled");
            await expect(
              admin.request("device.pair.code", {
                code: withdrawnCode,
                requestId: withdrawnRequest.requestId,
                decision: "approve",
              }),
            ).rejects.toThrow("No browser is waiting for this code");
            const connectedCode = await requestCode(page);
            const connectedRequest = await admin.request<{ requestId: string }>(
              "device.pair.code",
              { code: connectedCode },
            );
            await admin.request("device.pair.code", {
              code: connectedCode,
              requestId: connectedRequest.requestId,
              decision: "approve",
            });
            await waitForControlUiGatewayReady(page);
            await expect.poll(() => page.locator("openclaw-login-gate:visible").count()).toBe(0);
            await page.reload();
            await waitForControlUiGatewayReady(page);
          },
        );
        await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
          await openPairing(page, instance.url.replace("ws:", "http:"));
          const code = await requestCode(page);
          // Hold only the polling transport: the real owner approves before the real
          // signed Cancel reaches it, making the approval-wins outcome deterministic.
          await page.route("**/browser-pair/collect", (route) => route.abort());
          const request = await admin.request<{ requestId: string }>("device.pair.code", {
            code,
          });
          await admin.request("device.pair.code", {
            code,
            requestId: request.requestId,
            decision: "approve",
          });
          await page.getByRole("button", { name: "Cancel", exact: true }).click();
          await expect
            .poll(() => page.locator(".login-gate__body").textContent())
            .toContain("This browser was already approved. Cancel did not revoke its access.");
          await capture(page, "after-desktop-approval-wins-cancel");
          await page.unroute("**/browser-pair/collect");
          await page.getByRole("button", { name: "Continue", exact: true }).click();
          await waitForControlUiGatewayReady(page);
        });
      } finally {
        await admin.stopAndWait();
      }
    } finally {
      await instance.cleanup();
    }
  }, 180_000);
});
