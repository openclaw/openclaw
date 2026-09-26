import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { ChatSendShortcut } from "../app/settings.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { captureUiProofEnabled } from "./chat-flow.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "side-chat composer" });
const viewport = { width: 1440, height: 900 };

async function openSideChat(page: Page, chatSendShortcut: ChatSendShortcut = "enter") {
  await page.addInitScript(
    ({ key, shortcut }) => {
      localStorage.setItem(key, JSON.stringify({ chatSendShortcut: shortcut }));
    },
    { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), shortcut: chatSendShortcut },
  );
  const gateway = await installMockGateway(page, {
    methodResponses: {
      "sessions.companion.ask": { answer: "The next step is ready.", ts: 1 },
      "sessions.companion.state": { exchanges: [] },
    },
  });
  await page.goto(`${suite.server.baseUrl}chat`);
  await openChatSidePanelType(page, "Side chat");
  return gateway;
}

async function dropSideChatImage(page: Page, composer: Locator, fileName = "side-chat.png") {
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 100;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#79bcde";
    context.fillRect(0, 0, 160, 100);
    context.fillStyle = "#f8d64e";
    context.beginPath();
    context.arc(115, 30, 18, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#47855d";
    context.fillRect(0, 70, 160, 30);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await composer.evaluate(
    (element, file) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(
        new File([Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0))], file.name, {
          type: "image/png",
        }),
      );
      for (const type of ["dragenter", "dragover", "drop"]) {
        element.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }),
        );
      }
    },
    { content: image, name: fileName },
  );
  const preview = page.locator(
    'openclaw-chat-session-rail .chat-attachment-thumb[aria-busy="false"] img',
  );
  await preview.waitFor();
  await preview.evaluate((element) => (element as HTMLImageElement).decode());
  await expect
    .poll(() => page.locator(".chat-session-rail__composer button[type=submit]").isEnabled())
    .toBe(true);
  return image;
}

function composerGeometry(composer: Locator) {
  return composer.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
}

suite.define(() => {
  it("keeps a dropped image in Side chat and sends its bytes only to the companion", async () => {
    await suite.withPage({ viewport }, async ({ page }) => {
      const gateway = await openSideChat(page);
      const composer = page.getByRole("textbox", { name: "Ask in side chat", exact: true });
      await composer.fill("What does this image show?");
      const image = await dropSideChatImage(page, composer);
      const preview = page.locator(
        'openclaw-chat-session-rail .chat-attachment-thumb[aria-busy="false"] img',
      );
      await preview.waitFor();
      await preview.evaluate((element) => (element as HTMLImageElement).decode());
      await expect
        .poll(() => page.locator(".chat-session-rail__composer button[type=submit]").isEnabled())
        .toBe(true);
      if (captureUiProofEnabled) {
        const dir = createControlUiE2eArtifactDir("side-chat-image-drop");
        await page.screenshot({ path: path.join(dir, "dropped.png"), animations: "disabled" });
      }
      expect(
        await page.locator("openclaw-chat-session-rail .chat-attachment-thumb img").count(),
      ).toBe(1);
      expect(await page.locator(".agent-chat__composer-shell .chat-attachment-thumb").count()).toBe(
        0,
      );
      await composer.press("Enter");
      const request = await gateway.waitForRequest("sessions.companion.ask");
      expect(request.params).toMatchObject({
        question: "What does this image show?",
        attachments: [{ mimeType: "image/png", fileName: "side-chat.png", content: image }],
      });
      expect(await gateway.getRequests("chat.send")).toEqual([]);
      await page.locator(".chat-session-rail__answer").waitFor();
      expect(
        await page.locator(".chat-session-rail__composer .chat-attachment-thumb").count(),
      ).toBe(0);
    });
  });

  it("explains an unsupported image and retries its bytes after model recovery", async () => {
    await suite.withPage({ viewport }, async ({ page }) => {
      const gateway = await openSideChat(page);
      const side = page.locator("openclaw-chat-session-rail");
      const composer = page.getByRole("textbox", { name: "Ask in side chat", exact: true });
      const proofDir = captureUiProofEnabled
        ? createControlUiE2eArtifactDir("side-chat-image-model-retry")
        : null;
      await composer.fill("Describe this image");
      const image = await dropSideChatImage(page, composer, "retry-image.png");
      await gateway.deferNext("sessions.companion.ask");
      await composer.press("Enter");
      const original = await gateway.waitForRequest("sessions.companion.ask");
      expect(original.params).toMatchObject({
        question: "Describe this image",
        attachments: [{ mimeType: "image/png", fileName: "retry-image.png", content: image }],
      });
      await gateway.rejectDeferred("sessions.companion.ask", {
        code: "UNAVAILABLE",
        message: "The selected model does not support image input.",
        retryable: false,
        details: { reason: "image-input-unsupported" },
      });
      await side
        .getByText(
          "This Side chat model cannot read images. Choose an image-capable utility model, then retry.",
          { exact: true },
        )
        .waitFor();
      expect(
        await side
          .getByText("No utility model is configured for this session.", { exact: true })
          .count(),
      ).toBe(0);
      const retry = side.getByRole("button", { name: "Retry", exact: true });
      expect(await retry.isEnabled()).toBe(true);
      expect(await gateway.getRequests("sessions.companion.ask")).toHaveLength(1);
      await composer.fill("Keep my next question");
      if (proofDir) {
        await page.screenshot({
          path: path.join(proofDir, "unsupported-image.png"),
          animations: "disabled",
        });
      }
      // The mock now represents the image-capable model selected by the operator.
      await gateway.deferNext("sessions.companion.ask");
      await retry.click();
      await expect
        .poll(async () => (await gateway.getRequests("sessions.companion.ask")).length)
        .toBe(2);
      expect((await gateway.getRequests("sessions.companion.ask"))[1]?.params).toEqual(
        original.params,
      );
      await gateway.resolveDeferred("sessions.companion.ask", {
        answer: "The image shows a sunny landscape.",
        ts: 2,
      });
      await side.getByText("The image shows a sunny landscape.", { exact: true }).waitFor();
      expect(await retry.count()).toBe(0);
      expect(await composer.inputValue()).toBe("Keep my next question");
      expect(await gateway.getRequests("chat.send")).toEqual([]);
      expect(await gateway.getRequests("sessions.companion.reset")).toEqual([]);
      if (proofDir) {
        await page.screenshot({
          path: path.join(proofDir, "recovered-image.png"),
          animations: "disabled",
        });
      }
    });
  });

  it("wraps and grows a question, keeps Shift+Enter, then sends and shrinks", async () => {
    await suite.withPage({ viewport }, async ({ page }) => {
      const gateway = await openSideChat(page);
      const composer = page.getByRole("textbox", { name: "Ask in side chat", exact: true });
      const proofDir = captureUiProofEnabled
        ? createControlUiE2eArtifactDir("chat-session-companion-composer")
        : null;
      const empty = await composerGeometry(composer);
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, "empty.png") });
      }

      const question = "Explain the next step and the remaining checks for this session. "
        .repeat(4)
        .trim();
      await composer.fill(question);
      const filled = await composerGeometry(composer);
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, "wrapped.png") });
      }
      expect(filled.scrollWidth).toBeLessThanOrEqual(filled.clientWidth);
      expect(filled.height).toBeGreaterThan(empty.height);

      const requestsBefore = await gateway.getRequests("sessions.companion.ask");
      await composer.press("End");
      await composer.press("Shift+Enter");
      await page.keyboard.type("Include the final verification.");
      const multiline = `${question}\nInclude the final verification.`;
      expect(await composer.inputValue()).toBe(multiline);
      expect(await gateway.getRequests("sessions.companion.ask")).toHaveLength(
        requestsBefore.length,
      );

      await composer.press("Enter");
      const request = await gateway.waitForRequest("sessions.companion.ask");
      expect(request.params).toMatchObject({ question: multiline });
      await expect.poll(() => composer.inputValue()).toBe("");
      await expect.poll(async () => (await composerGeometry(composer)).height).toBe(empty.height);
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, "cleared.png") });
      }
    });
  });

  it.each(["Control", "Meta"])(
    "uses %s+Enter to send when the configured shortcut requires a modifier",
    async (modifier) => {
      await suite.withPage({ viewport }, async ({ page }) => {
        const gateway = await openSideChat(page, "modifier-enter");
        const composer = page.getByRole("textbox", { name: "Ask in side chat", exact: true });
        await composer.fill("Explain the next step.");
        await composer.press("Enter");
        await page.keyboard.type("Include the checks.");
        const question = "Explain the next step.\nInclude the checks.";
        expect(await composer.inputValue()).toBe(question);
        expect(await gateway.getRequests("sessions.companion.ask")).toHaveLength(0);
        await composer.press(`${modifier}+Enter`);
        const request = await gateway.waitForRequest("sessions.companion.ask");
        expect(request.params).toMatchObject({ question });
        await expect.poll(() => composer.inputValue()).toBe("");
      });
    },
  );
});
