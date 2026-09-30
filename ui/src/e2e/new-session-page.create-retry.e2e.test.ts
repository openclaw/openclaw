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
const MODEL_CATALOG_LOADING_ERROR = {
  __mockError: {
    code: "UNAVAILABLE",
    message: MODELS_LOADING,
    retryable: true,
    details: { code: "MODEL_CATALOG_LOADING" },
  },
};
const thinkingLevels = ["low", "medium", "high"].map((id) => ({ id, label: id }));

async function captureRetryProof(page: Page, fileName: string, content: string) {
  if (!captureUiProofEnabled) {
    return;
  }
  const dir = path.join(suite.artifactDir, "sessions-create-retry");
  await mkdir(dir, { recursive: true });
  // Composer controls transition after typing; the proof shows their settled state.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
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

  it("informs about a failed catalog and starts with the default model after its wait gives up", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
      async ({ page }) => {
        const sessionKey = "agent:main:default-model";
        const gateway = await installMockGateway(page, {
          agentModel: "openai/gpt-5.6-sol",
          models: ["sol", "luna"].map((id) => ({
            id: `gpt-5.6-${id}`,
            name: `GPT-5.6 ${id}`,
            provider: "openai",
            reasoning: true,
            thinkingLevels,
            thinkingDefault: "medium",
          })),
        });
        await page.goto(`${suite.server.baseUrl}new`);
        await gateway.waitForRequest("models.list");
        await page.locator('.new-session-page__composer [data-chat-model-select="true"]').click();
        await page.locator('[data-chat-model-option="openai/gpt-5.6-luna"]').click();
        const effort = page.locator('[data-chat-thinking-select="true"]');
        await effort.click();
        const slider = page.locator('[data-chat-thinking-slider="true"]');
        const highIndex = await slider.evaluate((element) =>
          element.getAttribute("data-chat-thinking-values")!.split(",").indexOf("high"),
        );
        await slider.fill(String(highIndex));
        await expect.poll(() => effort.getAttribute("data-chat-thinking-value")).toBe("high");
        await page.keyboard.press("Escape");
        await gateway.setMethodResponse("models.list", {
          __mockError: {
            code: "UNAVAILABLE",
            message: "Model catalog is not ready. Retry after Gateway startup or refresh finishes.",
          },
        });
        await gateway.emitGatewayEvent("chat.metadata.changed", {});
        await expect.poll(async () => (await gateway.getRequests("models.list")).length).toBe(2);

        const message = page.locator(".new-session-page__message");
        await message.fill("Review the deployment plan");
        await pollLocatorText(
          page.locator(".new-session-page__blocked-submit .agent-chat__composer-status-text"),
        ).toBe(
          "Models aren't ready yet. Starting with your model or thinking choice may wait for them.",
        );
        const start = page.getByRole("button", { name: "Start session" });
        await expect.poll(() => start.isEnabled()).toBe(true);
        await captureRetryProof(page, "03-model-catalog-notice.png", ".new-session-page__composer");

        const alert = page.locator(".new-session-page__alert");
        const failCatalogWait = async () => {
          await gateway.deferNext("sessions.create");
          await start.click();
          await gateway.waitForRequest("sessions.create");
          await pollLocatorText(
            page.locator('.new-session-page__starting .chat-working-indicator[role="status"]'),
          ).toContain("Starting…");
          await gateway.resolveDeferred("sessions.create", MODEL_CATALOG_LOADING_ERROR);
          await pollLocatorText(alert.locator(".new-session-page__alert-message")).toBe(
            MODELS_LOADING,
          );
        };
        await failCatalogWait();
        expect(await alert.getByRole("button").allInnerTexts()).toEqual([
          "Retry",
          "Start with default model",
          "Cancel",
        ]);
        await captureRetryProof(page, "04-model-catalog-actions.png", ".new-session-page__alert");

        await alert.getByRole("button", { name: "Cancel" }).click();
        await alert.waitFor({ state: "detached" });
        expect(await message.inputValue()).toBe("Review the deployment plan");

        await failCatalogWait();
        await gateway.setMethodResponse("sessions.create", { key: sessionKey });
        await alert.getByRole("button", { name: "Start with default model" }).click();

        await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey));
        const creates = await gateway.getRequests("sessions.create");
        expect(
          creates.map(({ params }) => {
            const { message: text, model, thinkingLevel } = params as Record<string, unknown>;
            return { message: text, model, thinkingLevel };
          }),
        ).toEqual([
          {
            message: "Review the deployment plan",
            model: "openai/gpt-5.6-luna",
            thinkingLevel: "high",
          },
          {
            message: "Review the deployment plan",
            model: "openai/gpt-5.6-luna",
            thinkingLevel: "high",
          },
          { message: "Review the deployment plan", model: undefined, thinkingLevel: undefined },
        ]);
      },
    );
  });
});
