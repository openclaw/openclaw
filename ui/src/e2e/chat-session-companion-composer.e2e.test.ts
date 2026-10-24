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
import { captureUiProofEnabled, confirmIme } from "./chat-flow.test-support.ts";
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

async function dropSideChatImage(
  composer: Locator,
  fileName: string,
  image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=",
) {
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

function composerHeight(composer: Locator) {
  return composer.evaluate((element) => element.getBoundingClientRect().height);
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
            "This Side chat model cannot read images. Choose an image-capable model, then retry.",
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
          await text("The next step is ready.").waitFor();
          expect(
            await side.locator(".chat-session-rail__composer .chat-attachment-thumb").count(),
          ).toBe(0);
        }
        expect(await gateway.getRequests("chat.send")).toEqual([]);
      });
    },
  );

  it("opens composer image previews in Side chat and the main chat", async () => {
    await withSideChat(async (_gateway, composer, page) => {
      const capture = screenshot(page, "composer-image-preview", "disabled");
      const image = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 480;
        canvas.height = 270;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#1f6feb";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#ffffff";
        context.font = "bold 40px sans-serif";
        context.fillText("Composer preview", 64, 150);
        return canvas.toDataURL("image/png").split(",")[1]!;
      });
      const openPreview = async (scope: Locator, fileName: string) => {
        await scope.getByRole("button", { name: `Open image ${fileName}`, exact: true }).click();
        const dialog = page.getByRole("dialog", { name: `Image preview: ${fileName}` });
        await dialog.waitFor();
        await page
          .locator("openclaw-image-lightbox img")
          .first()
          .evaluate((element) => (element as HTMLImageElement).decode());
        return dialog;
      };

      const side = page.locator("openclaw-chat-session-rail");
      await dropSideChatImage(composer, "side-chat-preview.png", image);
      await capture("side-chat-attached.png");
      const sideDialog = await openPreview(side, "side-chat-preview.png");
      await capture("side-chat-preview.png");
      await page.keyboard.press("Escape");
      await sideDialog.waitFor({ state: "detached" });
      expect(await side.locator(".chat-attachment-thumb").count()).toBe(1);

      const main = page.locator(".agent-chat__composer-shell");
      await main.locator(".agent-chat__file-input").setInputFiles({
        name: "main-chat-preview.png",
        mimeType: "image/png",
        buffer: Buffer.from(image, "base64"),
      });
      const mainDialog = await openPreview(main, "main-chat-preview.png");
      await capture("main-chat-preview.png");
      await page.keyboard.press("Escape");
      await mainDialog.waitFor({ state: "detached" });
      expect(await main.locator(".chat-attachment-thumb").count()).toBe(1);
    });
  });

  it.each(["Enter", "Control+Enter", "Meta+Enter"])(
    "preserves newlines and sends with the configured %s shortcut",
    async (shortcut) => {
      const plain = shortcut === "Enter";
      await withSideChat(
        async (gateway, composer, page) => {
          const capture = plain ? screenshot(page, "chat-session-companion-composer") : undefined;
          const empty = plain ? await composerHeight(composer) : null;
          await capture?.("empty.png");
          const initial = plain
            ? "Explain the next step and remaining checks. ".repeat(6).trim()
            : "Explain the next step.";
          const continuation = plain ? "Include the final verification." : "Include the checks.";
          await composer.fill(initial);
          if (empty !== null) {
            await capture?.("wrapped.png");
            expect(await composer.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
            expect(await composerHeight(composer)).toBeGreaterThan(empty);
            await composer.press("End");
          }
          await composer.press(plain ? "Shift+Enter" : "Enter");
          await page.keyboard.type(continuation);
          const question = `${initial}\n${continuation}`;
          expect(await composer.inputValue()).toBe(question);
          expect(await gateway.getRequests(ask)).toHaveLength(0);
          if (plain) {
            const confirmationConsumed = await confirmIme(composer, "");
            await capture?.("ime-confirmation.png");
            expect(confirmationConsumed).toBe(false);
            expect(await composer.inputValue()).toBe(question);
            expect(await gateway.getRequests(ask)).toHaveLength(0);
            await composer.dispatchEvent("keyup", { key: "Enter" });
          }
          await composer.press(shortcut);
          const request = await gateway.waitForRequest(ask);
          expect(request.params).toMatchObject({ question });
          await expect.poll(() => composer.inputValue()).toBe("");
          if (empty !== null) {
            await expect.poll(() => composerHeight(composer)).toBe(empty);
            await capture?.("cleared.png");
          }
        },
        plain ? "enter" : "modifier-enter",
      );
    },
  );
});
