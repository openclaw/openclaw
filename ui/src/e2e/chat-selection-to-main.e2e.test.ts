import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { storedChatOutboxScopeKey } from "../lib/chat/outbox-store.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { catalog, pluginModule } from "./native-plugin-ui.test-support.ts";
import { waitForCommittedComposerDraft } from "./settle.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI selected text destinations" });
const selectedText = "Review the deployment checklist.";
const draft = "Please explain the next step.";
const viewports = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

async function selectText(text: Locator) {
  await text.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await text.dispatchEvent("pointerup", { button: 0, pointerType: "mouse" });
}

suite.define(() => {
  it.each(viewports)(
    "stages, edits, restores, and sends annotations at $width px",
    async (viewport) => {
      await suite.withPage(
        {
          viewport,
          locale: "en-US",
          reducedMotion: "reduce",
          serviceWorkers: "block",
          recordVideo: { dir: suite.artifactDir, size: viewport },
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            historyMessages: [{ role: "assistant", content: selectedText }],
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          const composer = page.locator(".agent-chat__composer-shell textarea");
          await composer.waitFor({ state: "visible" });
          const text = page.locator(".chat-bubble .chat-text p").filter({ hasText: selectedText });
          const toolbar = page.getByRole("toolbar", { name: "Selection actions" });
          const editor = page.getByRole("dialog", { name: "Comment", exact: true });
          const comment = editor.getByRole("textbox");
          const highlightedText = () =>
            page.evaluate(() =>
              Array.from(CSS.highlights.get("openclaw-comment") ?? [])
                .map((range) => (range instanceof Range ? range.toString() : ""))
                .join(""),
            );
          const chip = (count: number) =>
            page
              .locator(".chat-attachments-preview .chat-selection-annotations__chip")
              .filter({ hasText: count === 1 ? "1 comment" : `${count} comments` });
          const pin = (number: number) =>
            page.getByRole("button", { name: `Edit comment ${number}`, exact: true });
          const open = async () => {
            await selectText(text);
            await toolbar.getByRole("button", { name: "Add to chat", exact: true }).click();
            await editor.waitFor({ state: "visible" });
          };
          const bounded = async (locator: Locator) => {
            const bounds = await locator.boundingBox();
            expect(bounds).not.toBeNull();
            expect(bounds!.x).toBeGreaterThanOrEqual(0);
            expect(bounds!.y).toBeGreaterThanOrEqual(0);
            expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
            expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
          };
          const capture = async (stage: string) =>
            page.screenshot({
              path: `${suite.artifactDir}/after-${viewport.width}-${stage}.png`,
            });

          await composer.fill(draft);
          await open();
          expect(await comment.inputValue()).toBe("");
          expect(await composer.inputValue()).toBe(draft);
          expect(await highlightedText()).toBe(selectedText);
          await bounded(editor);
          await capture("inline-comment");
          await comment.fill("Discard this comment.");
          await comment.press("Escape");
          expect(await highlightedText()).toBe("");
          expect(await chip(1).count()).toBe(0);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);

          await open();
          const compactHeight = (await editor.boundingBox())!.height;
          await comment.fill("Why is this step needed? 🦞");
          expect(await highlightedText()).toBe(selectedText);
          expect((await editor.boundingBox())!.height).toBe(compactHeight);
          expect(await editor.getByRole("button", { name: "Cancel", exact: true }).count()).toBe(0);
          expect(
            await editor.getByRole("button", { name: "Delete comment", exact: true }).count(),
          ).toBe(0);
          await bounded(editor);
          await capture("inline-typed");
          await editor.getByRole("button", { name: "Save comment", exact: true }).click();
          await chip(1).waitFor({ state: "visible" });
          expect(await highlightedText()).toBe("");
          expect(await composer.inputValue()).toBe(draft);
          await expect
            .poll(() => composer.evaluate((element) => element === document.activeElement))
            .toBe(true);
          await open();
          await comment.press("Enter");
          await pin(2).waitFor({ state: "visible" });
          await chip(2).click();
          expect(await editor.count()).toBe(0);
          expect(await page.getByRole("region", { name: "Comments", exact: true }).count()).toBe(0);
          await capture("multiple");

          const pinBounds = (await pin(1).boundingBox())!;
          const sourceBounds = (await text.boundingBox())!;
          expect(Math.abs(pinBounds.y - sourceBounds.y)).toBeLessThan(30);
          await pin(1).click();
          expect(await highlightedText()).toBe(selectedText);
          expect((await editor.boundingBox())!.height).toBeGreaterThan(compactHeight);
          const editorBounds = (await editor.boundingBox())!;
          expect(
            Math.min(
              Math.abs(editorBounds.y + editorBounds.height - pinBounds.y),
              Math.abs(editorBounds.y - pinBounds.y - pinBounds.height),
            ),
          ).toBeLessThan(20);
          const deleteComment = editor.getByRole("button", { name: "Delete comment", exact: true });
          expect((await deleteComment.textContent())?.trim()).toBe("");
          expect(await deleteComment.locator("svg").count()).toBe(1);
          await bounded(editor);
          await capture("editor");
          expect(await comment.inputValue()).toBe("Why is this step needed? 🦞");
          await comment.fill("An unsaved replacement");
          await comment.press("Escape");
          await pin(1).click();
          expect(await comment.inputValue()).toBe("Why is this step needed? 🦞");
          await comment.fill("Explain the rollback checks. 🦞\nKeep the existing draft.");
          await comment.press("Control+Enter");
          await pin(1).click();
          expect(await comment.inputValue()).toContain("Explain the rollback checks. 🦞");
          await comment.press("Escape");
          await pin(2).click();
          await deleteComment.click();
          await chip(1).waitFor({ state: "visible" });
          expect(await pin(2).count()).toBe(0);
          await pin(1).click();
          await deleteComment.click();
          expect(await chip(1).count()).toBe(0);
          expect(await pin(1).count()).toBe(0);
          expect(await composer.inputValue()).toBe(draft);

          await open();
          await comment.fill("Explain the rollback checks. 🦞");
          await editor.getByRole("button", { name: "Save comment", exact: true }).click();
          await pin(1).waitFor({ state: "visible" });
          await bounded(pin(1));
          await capture("composer");
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          await waitForCommittedComposerDraft(
            page,
            `chat:v3:${storedChatOutboxScopeKey({ agentId: "main", sessionKey: "agent:main:main" })}`,
            draft,
            1,
          );
          await page.reload();
          await chip(1).waitFor({ state: "visible" });
          expect(await composer.inputValue()).toBe(draft);
          await chip(1).hover();
          const preview = page.getByRole("region", { name: "Comments", exact: true });
          await preview.waitFor({ state: "visible" });
          expect(await preview.textContent()).toContain("Explain the rollback checks. 🦞");
          await preview.getByRole("button", { name: "Edit comment 1", exact: true }).click();
          expect(await comment.inputValue()).toBe("Explain the rollback checks. 🦞");
          await comment.press("Escape");
          await composer.click();
          await open();
          await comment.press("Enter");
          await chip(2).waitFor({ state: "visible" });
          await page.getByRole("button", { name: "Send message", exact: true }).click();
          const request = await gateway.waitForRequest("chat.send");
          const params = request.params as {
            message: string;
            idempotencyKey: string;
            attachments: Array<{ content: string; mimeType: string; fileName: string }>;
          };
          expect(params.message).toBe(draft);
          expect(params.attachments).toHaveLength(2);
          const contents = params.attachments.map((attachment) => {
            expect(attachment.mimeType).toBe("text/plain");
            return Buffer.from(attachment.content, "base64").toString("utf8");
          });
          expect(contents[0]).toContain(selectedText);
          expect(contents[0]).toContain("Explain the rollback checks. 🦞");
          expect(contents[0]).toContain("agent:main:main");
          expect(contents[1]).toContain(selectedText);
          expect(contents[1]).not.toContain("Explain the rollback checks.");
          await expect.poll(() => composer.inputValue()).toBe("");
          expect(await chip(2).count()).toBe(0);
          expect(await pin(1).count()).toBe(0);
          await gateway.emitChatFinal({
            runId: params.idempotencyKey,
            text: "The checks are ready.",
          });
          const sentChip = page.locator(
            "openclaw-chat-sent-comments .chat-selection-annotations__chip",
          );
          await sentChip.waitFor({ state: "visible" });
          expect(await sentChip.textContent()).toContain("2 comments");
          await sentChip.hover();
          await preview.waitFor({ state: "visible" });
          await expect
            .poll(() => preview.textContent())
            .toContain("Explain the rollback checks. 🦞");
          expect(await preview.locator("li").count()).toBe(2);
          expect(await preview.locator("button").count()).toBe(0);
          await bounded(preview);
          await capture("sent-hover");
          await page.keyboard.press("Escape");
          await preview.waitFor({ state: "hidden" });
          await page.reload();
          await sentChip.waitFor({ state: "visible" });
          await sentChip.focus();
          await preview.waitFor({ state: "visible" });
          await expect
            .poll(() => preview.textContent())
            .toContain("Explain the rollback checks. 🦞");
          expect(
            await page
              .locator(".chat-assistant-attachment-card__title")
              .filter({ hasText: "selection-comment.txt" })
              .count(),
          ).toBe(0);
          await capture("sent-reloaded");
        },
      );
    },
  );

  it.each(viewports)(
    "keeps comment pins anchored through scrolling and reflow at $width px",
    async (viewport) => {
      await suite.withPage(
        { viewport, locale: "en-US", reducedMotion: "reduce" },
        async ({ page }) => {
          const passage =
            "Review the rollback checklist carefully before the deployment starts. Confirm every recovery step with the team.";
          const filler = Array.from(
            { length: 24 },
            (_, index) => `Deployment context paragraph ${index + 1}.`,
          ).join("\n\n");
          await installMockGateway(page, {
            historyMessages: [
              { role: "assistant", content: `${filler}\n\n${passage}\n\n${filler}` },
            ],
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          const text = page.locator(".chat-bubble .chat-text p").filter({ hasText: passage });
          await waitForChatScrollIdle(page);
          await page.locator(".chat-thread").hover();
          await page.mouse.wheel(0, -32);
          await waitForChatScrollIdle(page);
          await text.scrollIntoViewIfNeeded();
          await waitForChatScrollIdle(page);
          await selectText(text);
          await page
            .getByRole("toolbar", { name: "Selection actions" })
            .getByRole("button", { name: "Add to chat", exact: true })
            .click();
          const editor = page.getByRole("dialog", { name: "Comment", exact: true });
          await editor.getByRole("textbox").fill("Keep this pin on its original passage.");
          await editor.getByRole("textbox").press("Enter");
          const pin = page.getByRole("button", { name: "Edit comment 1", exact: true });
          const aligned = async () => {
            await expect
              .poll(async () => {
                const lastLine = await text.evaluate((element) => {
                  const range = document.createRange();
                  range.selectNodeContents(element);
                  const last = Array.from(range.getClientRects()).findLast(
                    (rect) => rect.width && rect.height,
                  )!;
                  return { top: last.top, height: last.height, right: last.right };
                });
                const marker = await pin.boundingBox();
                return marker
                  ? Math.abs(marker.y + marker.height / 2 - lastLine.top - lastLine.height / 2)
                  : 1000;
              })
              .toBeLessThan(3);
          };
          await aligned();
          await pin.click();
          await page.locator(".chat-thread").evaluate((element) => (element.scrollTop += 100));
          await editor.waitFor({ state: "detached" });
          await text.scrollIntoViewIfNeeded();
          await aligned();
          await page.setViewportSize({
            width: viewport.width === 390 ? 560 : 390,
            height: viewport.height,
          });
          await text.scrollIntoViewIfNeeded();
          await aligned();
          await pin.click();
          expect(await editor.getByRole("textbox").inputValue()).toBe(
            "Keep this pin on its original passage.",
          );
          await editor.getByRole("textbox").press("Escape");
        },
      );
    },
  );

  it.each([false, true])(
    "keeps retained comments usable after clearing history (replacement: %s)",
    async (replacement) => {
      await suite.withPage({ viewport: viewports[0], locale: "en-US" }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          historyMessages: [{ role: "assistant", content: selectedText }],
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "plugins.controlUi.list",
            "plugins.controlUi.report",
          ],
          methodResponses: {
            "plugins.controlUi.list": catalog("one"),
            "plugins.controlUi.report": { ok: true },
          },
        });
        await page.route("**/__openclaw__/plugins/control-ui/ui-fixture/*/index.js", (route) =>
          route.fulfill({
            status: 200,
            contentType: "text/javascript",
            body: pluginModule("one").replace(
              "let unregisterComposer = registerComposer();",
              replacement
                ? 'let unregisterComposer = registerComposer(); host.ui.selectReplacement("composer", "composer");'
                : "let unregisterComposer = registerComposer();",
            ),
          }),
        );
        await page.goto(`${suite.server.baseUrl}chat`);
        const composer = replacement
          ? page.getByRole("textbox", { name: "Fixture draft", exact: true })
          : page.locator(".agent-chat__composer-shell textarea");
        await composer.fill(draft);
        expect(await page.locator(".agent-chat__composer-shell textarea").count()).toBe(
          replacement ? 0 : 1,
        );
        const editor = page.getByRole("dialog", { name: "Comment", exact: true });
        const pin = page.getByRole("button", { name: "Edit comment 1", exact: true });
        const saveComment = async () => {
          await selectText(
            page.locator(".chat-bubble .chat-text p").filter({ hasText: selectedText }),
          );
          await page
            .getByRole("toolbar", { name: "Selection actions" })
            .getByRole("button", { name: "Add to chat", exact: true })
            .click();
          await editor.getByRole("textbox").fill("Review before deployment.");
          await editor.getByRole("textbox").press("Enter");
          await pin.waitFor({ state: "visible" });
        };
        await saveComment();
        await pin.click();
        await editor.getByRole("textbox").fill("Check rollback first.");
        await editor.getByRole("button", { name: "Save", exact: true }).click();
        await pin.click();
        expect(await editor.getByRole("textbox").inputValue()).toBe("Check rollback first.");
        await editor.getByRole("button", { name: "Delete comment", exact: true }).click();
        expect(await pin.count()).toBe(0);
        await saveComment();
        await saveComment();
        expect(await composer.inputValue()).toBe(draft);
        const send = replacement
          ? page.getByRole("button", { name: "Fixture send", exact: true })
          : page.getByRole("button", { name: "Send message", exact: true });
        await gateway.setHistoryMessages([]);
        await composer.fill("/clear");
        await send.click();
        await gateway.waitForRequest("sessions.reset");
        await page
          .locator(".chat-bubble .chat-text p")
          .filter({ hasText: selectedText })
          .waitFor({ state: "detached" });
        const chip = page.locator(".chat-selection-annotations__chip");
        await chip.hover();
        const preview = page.getByRole("region", { name: "Comments", exact: true });
        await preview.waitFor({ state: "visible" });
        expect(await preview.getByText(selectedText, { exact: true }).count()).toBe(2);
        await preview.getByRole("button", { name: "Edit comment 1", exact: true }).click();
        await editor.getByRole("textbox").fill("Edited after history was cleared.");
        await page.setViewportSize({ width: 900, height: 850 });
        await expect.poll(() => editor.isVisible()).toBe(true);
        await editor.getByRole("button", { name: "Save", exact: true }).click();
        await chip.hover();
        await preview
          .getByText("Edited after history was cleared.", { exact: true })
          .waitFor({ state: "visible" });
        await page.screenshot({
          path: `${suite.artifactDir}/retained-comments-${replacement ? "replacement" : "default"}.png`,
        });
        await preview.getByRole("button", { name: "Delete comment", exact: true }).first().click();
        await expect.poll(() => chip.textContent()).toContain("1 comment");
        await composer.fill(draft);
        await send.click();
        const request = await gateway.waitForRequest("chat.send");
        const params = request.params as {
          message: string;
          attachments: Array<{ content: string }>;
        };
        expect(params.message).toBe(draft);
        expect(params.attachments).toHaveLength(1);
        expect(Buffer.from(params.attachments[0]!.content, "base64").toString("utf8")).toContain(
          "Review before deployment.",
        );
        await expect.poll(() => pin.count()).toBe(0);
      });
    },
  );

  it("repositions the open editor when its pinned passage wraps", async () => {
    await suite.withPage(
      { viewport: viewports[0], locale: "en-US", reducedMotion: "reduce" },
      async ({ page }) => {
        const passage =
          "Review the rollback checklist carefully before the deployment starts. Confirm every recovery step with the team before proceeding.";
        await installMockGateway(page, {
          historyMessages: [{ role: "assistant", content: passage }],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const text = page.locator(".chat-bubble .chat-text p");
        await text.waitFor({ state: "visible" });
        await selectText(text);
        await page
          .getByRole("toolbar", { name: "Selection actions" })
          .getByRole("button", { name: "Add to chat", exact: true })
          .click();
        const editor = page.getByRole("dialog", { name: "Comment", exact: true });
        await editor.getByRole("textbox").fill("Review this passage.");
        await editor.getByRole("textbox").press("Enter");
        const pin = page.getByRole("button", { name: "Edit comment 1", exact: true });
        await pin.click();
        await page.setViewportSize({ width: 390, height: 900 });
        await expect
          .poll(async () => {
            const marker = await pin.boundingBox();
            const popup = await editor.boundingBox();
            return marker && popup
              ? Math.min(
                  Math.abs(popup.y + popup.height - marker.y),
                  Math.abs(popup.y - marker.y - marker.height),
                )
              : 1000;
          })
          .toBeLessThan(12);
        expect(await editor.getByRole("textbox").inputValue()).toBe("Review this passage.");
      },
    );
  });

  it("keeps formatted selection text and DOM source offsets consistent", async () => {
    await suite.withPage(
      { viewport: viewports[0], locale: "en-US", reducedMotion: "reduce" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          historyMessages: [{ role: "assistant", content: "A  \nB" }],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const paragraph = page.locator(".chat-bubble .chat-text p");
        await paragraph.waitFor({ state: "visible" });
        const sourceText = await page.locator(".chat-bubble").textContent();
        const selectedDomText = await paragraph.textContent();
        await selectText(paragraph);
        await page
          .getByRole("toolbar", { name: "Selection actions" })
          .getByRole("button", { name: "Add to chat", exact: true })
          .click();
        await page
          .getByRole("dialog", { name: "Comment", exact: true })
          .getByRole("button", { name: "Save comment", exact: true })
          .click();
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const request = await gateway.waitForRequest("chat.send");
        const params = request.params as {
          idempotencyKey: string;
          attachments: Array<{ content: string }>;
        };
        const content = Buffer.from(params.attachments[0]!.content, "base64").toString("utf8");
        expect(content).toContain("Selected text:\nA\nB");
        const offsets = /DOM text UTF-16 range: \[(\d+), (\d+)\)/.exec(content);
        expect(offsets).not.toBeNull();
        expect(sourceText?.slice(Number(offsets![1]), Number(offsets![2]))).toBe(selectedDomText);
        await gateway.emitChatFinal({
          runId: params.idempotencyKey,
          text: "Selected passage received.",
        });
        const sentChip = page.locator(
          "openclaw-chat-sent-comments .chat-selection-annotations__chip",
        );
        await sentChip.waitFor({ state: "visible" });
        await sentChip.hover();
        const preview = page.getByRole("region", { name: "Comments", exact: true });
        await expect
          .poll(() => preview.locator(".chat-comment-preview__text").textContent())
          .toBe("A\nB");
        await page.screenshot({ path: `${suite.artifactDir}/formatted-sent-hover.png` });
        await page.reload();
        await sentChip.waitFor({ state: "visible" });
        await sentChip.hover();
        await expect
          .poll(() => preview.locator(".chat-comment-preview__text").textContent())
          .toBe("A\nB");
      },
    );
  });

  it.each(viewports)(
    "preserves side chat and selection dismissal at $width px",
    async (viewport) => {
      await suite.withPage(
        { viewport, locale: "en-US", reducedMotion: "reduce" },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            historyMessages: [{ role: "assistant", content: selectedText }],
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          const composer = page.locator(".agent-chat__composer-shell textarea");
          await composer.fill(draft);
          const text = page.locator(".chat-bubble .chat-text p").filter({ hasText: selectedText });
          const toolbar = page.getByRole("toolbar", { name: "Selection actions" });
          await selectText(text);
          await toolbar.waitFor({ state: "visible" });
          await page.keyboard.press("Escape");
          expect(await toolbar.count()).toBe(0);
          await selectText(text);
          await toolbar.getByRole("button", { name: "Ask in side chat", exact: true }).click();
          const sideComposer = page.locator(".chat-session-rail__input");
          await sideComposer.waitFor({ state: "visible" });
          expect(await sideComposer.inputValue()).toBe(`Regarding "${selectedText}": `);
          expect(await composer.inputValue()).toBe(draft);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        },
      );
    },
  );
});
