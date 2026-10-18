import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { ChatSendShortcut } from "../app/settings.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { captureUiProofEnabled } from "./chat-flow.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "side-chat composer" });
type SideChatRun = (gateway: MockGatewayControls, composer: Locator, page: Page) => Promise<void>;
const ask = "sessions.companion.ask";
async function withSideChat(run: SideChatRun, chatSendShortcut: ChatSendShortcut = "enter") {
  await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
    await page.addInitScript(
      ({ key, shortcut }) => {
        localStorage.setItem(key, JSON.stringify({ chatSendShortcut: shortcut }));
      },
      { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), shortcut: chatSendShortcut },
    );
    const gateway = await installMockGateway(page, {
      methodResponses: {
        [ask]: { answer: "The next step is ready.", ts: 1 },
        "sessions.companion.state": { exchanges: [] },
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await openChatSidePanelType(page, "Side chat");

    await run(gateway, page.getByRole("textbox", { name: "Ask in side chat", exact: true }), page);
  });
}

async function dropSideChatImage(composer: Locator, fileName: string) {
  const image =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
  await composer.evaluate(
    (element, file) => {
      const dataTransfer = new DataTransfer();
      const bytes = Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0));
      dataTransfer.items.add(new File([bytes], file.name, { type: "image/png" }));
      for (const type of ["dragenter", "dragover", "drop"]) {
        element.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }),
        );
      }
    },
    { content: image, name: fileName },
  );
  const side = composer.page().locator("openclaw-chat-session-rail");
  const preview = side.locator('.chat-attachment-thumb[aria-busy="false"] img');
  await preview.waitFor();
  await preview.evaluate((element) => (element as HTMLImageElement).decode());
  await expect
    .poll(() => side.locator(".chat-session-rail__composer button[type=submit]").isEnabled())
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

function screenshot(page: Page, name: string, animations: "allow" | "disabled" = "allow") {
  const dir = captureUiProofEnabled ? createControlUiE2eArtifactDir(name) : null;
  return async (file: string) => {
    if (dir) {
      await page.screenshot({ path: path.join(dir, file), animations });
    }
  };
}

suite.define(() => {
  it.each([false, true])(
    "sends Side chat image bytes without main-chat leakage (model recovery=%s)",
    async (recover) => {
      await withSideChat(async (gateway, composer, page) => {
        const side = page.locator("openclaw-chat-session-rail");
        const thumbnails = side.locator(".chat-attachment-thumb");
        const text = (value: string) => side.getByText(value, { exact: true });
        const capture = screenshot(
          page,
          recover ? "side-chat-image-model-retry" : "side-chat-image-drop",
          "disabled",
        );
        const question = recover ? "Describe this image" : "What does this image show?";
        const fileName = recover ? "retry-image.png" : "side-chat.png";
        await composer.fill(question);
        const image = await dropSideChatImage(composer, fileName);
        if (recover) {
          await gateway.deferNext(ask);
        } else {
          await capture("dropped.png");
        }
        expect(await thumbnails.locator("img").count()).toBe(1);
        expect(
          await page.locator(".agent-chat__composer-shell .chat-attachment-thumb").count(),
        ).toBe(0);
        await composer.press("Enter");
        const original = await gateway.waitForRequest(ask);
        expect(original.params).toMatchObject({
          question,
          attachments: [{ mimeType: "image/png", fileName, content: image }],
        });
        if (recover) {
          await gateway.rejectDeferred(ask, {
            code: "UNAVAILABLE",
            message: "The selected model does not support image input.",
            retryable: false,
            details: { reason: "image-input-unsupported" },
          });
          await text(
            "This Side chat model cannot read images. Choose an image-capable utility model, then retry.",
          ).waitFor();
          expect(await text("No utility model is configured for this session.").count()).toBe(0);
          const retry = side.getByRole("button", { name: "Retry", exact: true });
          expect(await retry.isEnabled()).toBe(true);
          expect(await gateway.getRequests(ask)).toHaveLength(1);
          await composer.fill("Keep my next question");
          await capture("unsupported-image.png");
          // The mock now represents the operator's recovered image-capable model.
          await gateway.deferNext(ask);
          await retry.click();
          await expect.poll(async () => (await gateway.getRequests(ask)).length).toBe(2);
          expect((await gateway.getRequests(ask))[1]?.params).toEqual(original.params);
          const answer = "The image shows a sunny landscape.";
          await gateway.resolveDeferred(ask, { answer, ts: 2 });
          await text(answer).waitFor();
          expect(await retry.count()).toBe(0);
          expect(await composer.inputValue()).toBe("Keep my next question");
          expect(await gateway.getRequests("sessions.companion.reset")).toEqual([]);
          await capture("recovered-image.png");
        } else {
          await side.locator(".chat-session-rail__answer").waitFor();
          expect(
            await side.locator(".chat-session-rail__composer .chat-attachment-thumb").count(),
          ).toBe(0);
        }
        expect(await gateway.getRequests("chat.send")).toEqual([]);
      });
    },
  );

  it("wraps and grows a question, keeps Shift+Enter, then sends and shrinks", async () => {
    await withSideChat(async (gateway, composer, page) => {
      const capture = screenshot(page, "chat-session-companion-composer");
      const empty = await composerGeometry(composer);
      await capture("empty.png");

      const question = "Explain the next step and remaining checks. ".repeat(6).trim();
      await composer.fill(question);
      const filled = await composerGeometry(composer);
      await capture("wrapped.png");
      expect(filled.scrollWidth).toBeLessThanOrEqual(filled.clientWidth);
      expect(filled.height).toBeGreaterThan(empty.height);

      await composer.press("End");
      await composer.press("Shift+Enter");
      await page.keyboard.type("Include the final verification.");
      const multiline = `${question}\nInclude the final verification.`;
      expect(await composer.inputValue()).toBe(multiline);
      expect(await gateway.getRequests(ask)).toHaveLength(0);

      const confirmationConsumed = await composer.evaluate((textarea) => {
        textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        const end = new CompositionEvent("compositionend", { bubbles: true });
        textarea.dispatchEvent(end);
        const confirm = new KeyboardEvent("keydown", {
          key: "Enter",
          keyCode: 13,
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(confirm, "timeStamp", { value: end.timeStamp - 1 });
        textarea.dispatchEvent(confirm);
        return confirm.defaultPrevented;
      });
      await capture("ime-confirmation.png");
      expect(confirmationConsumed).toBe(false);
      expect(await composer.inputValue()).toBe(multiline);
      expect(await gateway.getRequests(ask)).toHaveLength(0);
      await composer.dispatchEvent("keyup", { key: "Enter" });
      await composer.press("Enter");
      const request = await gateway.waitForRequest(ask);
      expect(request.params).toMatchObject({ question: multiline });
      await expect.poll(() => composer.inputValue()).toBe("");
      await expect.poll(async () => (await composerGeometry(composer)).height).toBe(empty.height);
      await capture("cleared.png");
    });
  });

  it.each(["Control", "Meta"])(
    "uses %s+Enter to send when the configured shortcut requires a modifier",
    async (modifier) => {
      await withSideChat(async (gateway, composer, page) => {
        await composer.fill("Explain the next step.");
        await composer.press("Enter");
        await page.keyboard.type("Include the checks.");
        const question = "Explain the next step.\nInclude the checks.";
        expect(await composer.inputValue()).toBe(question);
        expect(await gateway.getRequests(ask)).toHaveLength(0);
        await composer.press(`${modifier}+Enter`);
        const request = await gateway.waitForRequest(ask);
        expect(request.params).toMatchObject({ question });
        await expect.poll(() => composer.inputValue()).toBe("");
      }, "modifier-enter");
    },
  );
});
