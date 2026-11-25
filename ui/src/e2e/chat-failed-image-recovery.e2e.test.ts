import type { Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import {
  createControlUiMockSameOriginGatewayScript,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Failed image recovery" });
const sessionKey = "agent:main:main";
const prompt =
  "Compare these five garden design options and recommend the best small courtyard layout.";
const failure =
  "Image processing failed for this request. Reduce the number of images and try again.";
type SendParams = {
  message: string;
  attachments?: Array<{ content: string; mimeType: string; fileName?: string }>;
  idempotencyKey: string;
};

async function failFiveImages(page: Page) {
  const images = await page.evaluate(() =>
    ["#ece5d8", "#e1e8da", "#e8dfd3", "#e5e4db", "#e7e1d6"].map((background, i) => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 420;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, 640, 420);
      ctx.fillStyle = "#f8f4ed";
      ctx.fillRect(45, 35, 550, 350);
      ctx.fillStyle = "#c3ae91";
      ctx.fillRect(230 + i * 8, 65, 125, 280);
      ctx.fillStyle = "#71855b";
      for (let k = 0; k < 7; k++) {
        ctx.beginPath();
        ctx.arc(95 + (k % 2) * 390, 80 + Math.floor(k / 2) * 85, 25 + i * 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = "#43503a";
      ctx.font = "22px sans-serif";
      ctx.fillText("Courtyard option " + (i + 1), 190, 398);
      return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
    }),
  );

  await page.addInitScript({ content: createControlUiMockSameOriginGatewayScript() });
  const gateway = await installMockGateway(page);
  await page.goto(new URL("chat", suite.server.baseUrl).href);
  const composer = page.locator(".agent-chat__composer-combobox textarea").first();
  const input = page.locator(".agent-chat__file-input").first();
  await expectBrowser(composer).toBeVisible();
  await input.setInputFiles(
    images.map((data, i) => ({
      name: "courtyard-option-" + (i + 1) + ".png",
      mimeType: "image/png",
      buffer: Buffer.from(data, "base64"),
    })),
  );
  await expectBrowser(page.locator(".chat-attachment-thumb")).toHaveCount(5);
  await composer.fill(prompt);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const first = await gateway.waitForRequest("chat.send");
  const params = first.params as SendParams;
  expect(params.attachments).toHaveLength(5);
  await expectBrowser(composer).toHaveValue("");
  const row = await gateway.getSessionRow(sessionKey);
  const now = Date.now();
  await gateway.setHistoryMessages([
    {
      role: "user",
      content: [
        { type: "text", text: prompt },
        ...images.map((data, i) => ({
          type: "image",
          url: "data:image/png;base64," + data,
          alt: "Courtyard option " + (i + 1),
        })),
      ],
      timestamp: now,
      __openclaw: { id: "persisted-failed-five-image-input", seq: 1, runId: params.idempotencyKey },
    },
    {
      role: "custom",
      customType: "run-failed-before-reply",
      content: failure,
      timestamp: now + 1,
      display: true,
      excludeFromContext: true,
      details: { runId: params.idempotencyKey, error: failure },
      openclawRunError: { runId: params.idempotencyKey, summary: failure },
      __openclaw: { id: "failed-five-image-run", seq: 2, runId: params.idempotencyKey },
    },
  ]);
  await gateway.setSessionsListResponse({
    sessions: [
      {
        ...row,
        key: sessionKey,
        status: "failed",
        hasActiveRun: false,
        activeRunIds: [],
        lastRunId: params.idempotencyKey,
        lastRunError: failure,
      },
    ],
  });
  await gateway.emitGatewayEvent("chat", {
    sessionKey,
    runId: params.idempotencyKey,
    state: "error",
    errorMessage: failure,
  });
  await gateway.emitGatewayEvent("sessions.changed", {
    sessionKey,
    runId: params.idempotencyKey,
    phase: "error",
    ts: now + 1,
    row: { ...row, key: sessionKey, status: "failed", hasActiveRun: false, activeRunIds: [] },
  });
  await expectBrowser(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
  await expectBrowser(page.locator(".chat-message-image")).toHaveCount(5);
  await expectBrowser(page.locator(".chat-attachment-thumb")).toHaveCount(0);
  return { gateway, composer, params };
}

suite.define(() => {
  it("rewinds a failed image message into a composer with an existing draft", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 1040 }, locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        const { gateway, composer, params } = await failFiveImages(page);
        const failureRow = page.locator(".chat-run-failure");
        await composer.fill("An unsent draft.");
        await gateway.deferNext("sessions.rewind");
        await page.locator(".chat-bubble").filter({ hasText: prompt }).click({ button: "right" });
        await page.getByRole("menuitem", { name: "Rewind to here", exact: true }).click();
        await page
          .locator(".chat-confirm-popover")
          .getByRole("button", { name: "Rewind", exact: true })
          .click();
        const rewind = await gateway.waitForRequest("sessions.rewind");
        expect(rewind.params).toMatchObject({
          sessionKey,
          entryId: "persisted-failed-five-image-input",
        });
        await gateway.setHistoryMessages([]);
        await gateway.resolveDeferred("sessions.rewind", {
          editorText: prompt,
          editorAttachments: params.attachments?.map(({ mimeType, content, fileName }) => ({
            mimeType,
            data: content,
            fileName,
          })),
        });
        await expectBrowser(composer).toHaveValue(prompt);
        await expectBrowser(page.locator(".chat-attachment-thumb")).toHaveCount(5);
        await expectBrowser(failureRow).toHaveCount(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      },
    );
  }, 90_000);

  it("keeps Try again as an attachment-free continuation", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 1040 }, locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        const { gateway, composer } = await failFiveImages(page);
        await page.getByRole("button", { name: "Try again", exact: true }).click();
        const retried = (await gateway.waitForRequest("chat.send", { after: 1 }))
          .params as SendParams;
        expect(retried.message).toContain("Continue");
        expect(retried.attachments ?? []).toHaveLength(0);
        expect(await gateway.getRequests("sessions.rewind")).toHaveLength(0);
        await expectBrowser(composer).toHaveValue("");
        await expectBrowser(page.locator(".chat-attachment-thumb")).toHaveCount(0);
        await expectBrowser(page.locator(".chat-message-image")).toHaveCount(5);
      },
    );
  }, 90_000);
});
