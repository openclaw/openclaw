import { createHash } from "node:crypto";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import {
  createControlUiMockSameOriginGatewayScript,
  installMockGateway,
  type MockGatewayWindow,
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

async function failFiveImages(page: Page, imageOnly = false) {
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
  // Extend the typed fixture at its owning hook. Rewind must remove the inactive
  // source from canonical history, not merely return copies to the composer.
  await page.addInitScript(() => {
    const mock = (window as MockGatewayWindow).openclawControlUiE2eGateway!;
    mock.setRequestHandler("sessions.rewind", ({ respond }) => {
      const sent = mock.findRequests("chat.send").at(0);
      if (!sent) {
        throw new Error("Rewind fixture requires an admitted user turn");
      }
      const original = sent.params as SendParams;
      mock.setHistoryMessages([]);
      respond({
        editorText: original.message,
        editorAttachments: (original.attachments ?? []).map((a) => ({
          mimeType: a.mimeType,
          data: a.content,
          fileName: a.fileName,
        })),
      });
    });
  });
  await page.goto(suite.server.baseUrl + "/chat");
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
  if (!imageOnly) {
    await composer.fill(prompt);
  }
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const first = await gateway.waitForRequest("chat.send");
  const params = first.params as SendParams;
  expect(params.attachments).toHaveLength(5);
  await expectBrowser(composer).toHaveValue("");
  const row = await gateway.getSessionRow(sessionKey);
  const now = Date.now();
  const entryId = "persisted-failed-five-image-input";
  await gateway.setHistoryMessages([
    {
      role: "user",
      content: [
        ...(imageOnly ? [] : [{ type: "text", text: prompt }]),
        ...images.map((data, i) => ({
          type: "image",
          url: "data:image/png;base64," + data,
          alt: "Courtyard option " + (i + 1),
        })),
      ],
      timestamp: now,
      __openclaw: { id: entryId, seq: 1, runId: params.idempotencyKey },
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
  return { gateway, composer, input, images, params, entryId, row };
}

suite.define(() => {
  for (const imageOnly of [false, true]) {
    it(
      imageOnly
        ? "recovers an image-only failed input"
        : "edits five failed images without overwriting an existing draft",
      async () => {
        await suite.withPage(
          { viewport: { width: 1440, height: 1040 }, locale: "en-US", serviceWorkers: "block" },
          async ({ page }) => {
            let sawOptionalEditLoad = false;
            if (!imageOnly) {
              await page.route(
                (url) =>
                  url.pathname.includes("chat-failed-message-edit-button-") &&
                  url.pathname.endsWith(".js"),
                async (route) => {
                  try {
                    await expectBrowser(page.locator(".chat-run-failure__toggle")).toBeVisible();
                    await expectBrowser(
                      page.getByRole("button", { name: "Try again", exact: true }),
                    ).toBeVisible();
                    sawOptionalEditLoad = true;
                  } finally {
                    await route.continue();
                  }
                },
              );
            }
            const { gateway, composer, input, images, params, entryId, row } = await failFiveImages(
              page,
              imageOnly,
            );
            const edit = page.getByRole("button", { name: "Edit message", exact: true });
            await expectBrowser(edit).toBeEnabled();
            if (!imageOnly) {
              expect(sawOptionalEditLoad).toBe(true);
            }
            if (!imageOnly) {
              await composer.fill("Keep my independent draft.");
              await input.setInputFiles({
                name: "draft-garden.png",
                mimeType: "image/png",
                buffer: Buffer.from(expectDefined(images[0], "draft image fixture"), "base64"),
              });
              await expectBrowser(page.locator(".chat-attachment-thumb")).toHaveCount(1);
              await expectBrowser(edit).toBeDisabled();
              await edit.hover({ force: true });
              await expectBrowser(
                page.locator(".tooltip-content").filter({
                  hasText: "Send or clear your current draft before editing this message.",
                }),
              ).toBeVisible();
              await expectBrowser(composer).toHaveValue("Keep my independent draft.");
              expect(await gateway.getRequests("sessions.rewind")).toHaveLength(0);
              await composer.fill("");
              await expectBrowser(edit).toBeDisabled();
              await page.locator(".chat-attachment-remove").click();
              await expectBrowser(edit).toBeEnabled();
            }
            await edit.click();
            const dialog = page.getByRole("dialog", { name: "Rewind to before this message?" });
            await expectBrowser(dialog).toBeVisible();
            expect(await gateway.getRequests("sessions.rewind")).toHaveLength(0);
            await dialog.locator(".chat-confirm-popover__yes").click();
            const rewind = await gateway.waitForRequest("sessions.rewind");
            expect(rewind.params).toMatchObject({ sessionKey, entryId });
            await expectBrowser(composer).toHaveValue(imageOnly ? "" : prompt);
            await expectBrowser(page.locator(".chat-attachment-thumb")).toHaveCount(5);
            await expectBrowser(page.locator(".chat-message-image")).toHaveCount(0);
            if (!imageOnly) {
              await page.screenshot({
                path: path.join(suite.artifactDir, "after-restored-five-image-composer.png"),
                animations: "disabled",
              });
            }
            await page.locator(".chat-attachment-remove").nth(2).click();
            await expectBrowser(page.locator(".chat-attachment-thumb")).toHaveCount(4);
            await page.getByRole("button", { name: "Send message", exact: true }).click();
            const resend = await gateway.waitForRequest("chat.send", { after: 1 });
            const resent = resend.params as SendParams;
            expect(resent.message).toBe(imageOnly ? "" : prompt);
            const payloads = (attachments: NonNullable<SendParams["attachments"]>) =>
              attachments.map(({ mimeType, content }) => ({
                mimeType,
                sha256: createHash("sha256").update(content).digest("hex"),
              }));
            expect(payloads(expectDefined(resent.attachments, "resend attachments"))).toEqual(
              payloads(
                expectDefined(params.attachments, "original attachments").filter((_, i) => i !== 2),
              ),
            );
            expect(
              await page.evaluate(() =>
                (window as MockGatewayWindow)
                  .openclawControlUiE2eGateway!.requests.filter(
                    (r) => r.method === "chat.send" || r.method === "sessions.rewind",
                  )
                  .map((r) => r.method),
              ),
            ).toEqual(["chat.send", "sessions.rewind", "chat.send"]);
            await gateway.setSessionsListResponse({
              sessions: [
                { ...row, key: sessionKey, status: "idle", hasActiveRun: false, activeRunIds: [] },
              ],
            });
            await gateway.emitGatewayEvent("chat", {
              sessionKey,
              runId: resent.idempotencyKey,
              state: "final",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Four courtyard options received." }],
              },
            });
            // Reconnect reloads the canonical active transcript; a completed run
            // need not issue a redundant history read while its receipt is held.
            const subscriptionsBefore = (await gateway.getRequests("sessions.messages.subscribe"))
              .length;
            await gateway.setOnline(false);
            await gateway.setOnline(true);
            await gateway.waitForRequest("sessions.messages.subscribe", {
              after: subscriptionsBefore,
            });
            await expectBrowser(page.locator(".chat-message-image")).toHaveCount(4);
            await expectBrowser(page.locator(".chat-attachment-thumb")).toHaveCount(0);
            await expectBrowser(edit).toHaveCount(0);
            await expectBrowser(page.locator(".chat-run-failure")).toHaveCount(0);
            if (!imageOnly) {
              await page.screenshot({
                path: path.join(suite.artifactDir, "after-retained-four-image-resend.png"),
                animations: "disabled",
              });
              console.log("FAILED_IMAGE_RECOVERY_ARTIFACTS=" + suite.artifactDir);
            }
          },
        );
      },
      90_000,
    );
  }
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
