import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  captureUiProofEnabled,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollLocatorText,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const MODELS_LOADING = "Models are still loading; retry in a moment.";

async function captureRetryProof(page: Page, fileName: string, content: string) {
  if (!captureUiProofEnabled) {
    return;
  }
  const dir = path.join(suite.artifactDir, "sessions-create-retry");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, fileName),
    await takeControlUiViewportScreenshot(page, page.locator(".shell"), [page.locator(content)]),
  );
}

suite.define(() => {
  it("offers Retry for a retryable create failure and keeps the draft", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
      async ({ page }) => {
        const sessionKey = "agent:main:models-ready";
        const gateway = await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}new`);
        const message = page.locator(".new-session-page__message");
        await message.fill("Review the deployment plan");
        await gateway.deferNext("sessions.create");
        await page.getByRole("button", { name: "Start session" }).click();
        await gateway.waitForRequest("sessions.create");
        await pollLocatorText(
          page.locator('.new-session-page__starting .chat-working-indicator[role="status"]'),
        ).toContain("Starting…");
        await captureRetryProof(page, "01-create-pending.png", ".new-session-page__starting");
        await gateway.resolveDeferred("sessions.create", {
          __mockError: { code: "UNAVAILABLE", message: MODELS_LOADING, retryable: true },
        });

        const alert = page.locator(".new-session-page__alert");
        await pollLocatorText(alert.locator(".new-session-page__alert-message")).toBe(
          MODELS_LOADING,
        );
        const retry = alert.getByRole("button", { name: "Retry" });
        await retry.waitFor({ state: "visible" });
        expect(await message.inputValue()).toBe("Review the deployment plan");
        await captureRetryProof(page, "02-models-loading-retry.png", ".new-session-page__alert");

        await gateway.setMethodResponse("sessions.create", { key: sessionKey });
        await retry.click();

        await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey));
        const creates = await gateway.getRequests("sessions.create");
        expect(creates.map((request) => (request.params as { message?: string }).message)).toEqual([
          "Review the deployment plan",
          "Review the deployment plan",
        ]);
      },
    );
  });
});
