import type { BrowserContextOptions, Locator, Page } from "playwright";
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

const companionResponses = {
  "sessions.companion.ask": { answer: "Review the rollback steps.", ts: 1 },
  "sessions.companion.state": { exchanges: [] },
};
function controls(page: Page) {
  const editor = commentEditor(page);
  return {
    page,
    editor,
    comment: editor.getByRole("textbox"),
    composer: page.locator(".agent-chat__composer-shell textarea"),
    preview: page.getByRole("region", { name: "Comments", exact: true }),
    pendingChip: page.locator(".chat-attachments-preview .chat-selection-annotations__chip"),
    sentChip: page.locator("openclaw-chat-sent-comments .chat-selection-annotations__chip"),
    toolbar: page.getByRole("toolbar", { name: "Selection actions" }),
    side: page.locator("openclaw-chat-session-rail"),
    sideComposer: page.locator(".chat-session-rail__input"),
  };
}
function withPage(
  run: (ui: ReturnType<typeof controls>) => Promise<void>,
  options: BrowserContextOptions = {},
) {
  return suite.withPage(
    { viewport: viewports[0], locale: "en-US", reducedMotion: "reduce", ...options },
    ({ page }) => run(controls(page)),
  );
}
async function submitComment(comment: Locator, text: string, action = "Save comment") {
  await comment.fill(text);
  await button(commentEditor(comment.page()), action).click();
}
function verticalGap(popup: { y: number; height: number }, pin: { y: number; height: number }) {
  return Math.min(Math.abs(popup.y + popup.height - pin.y), Math.abs(popup.y - pin.y - pin.height));
}
async function expectPreview(preview: Locator, text: string) {
  await preview.waitFor({ state: "visible" });
  await expect.poll(() => preview.textContent()).toContain(text);
}
async function expectReadOnlyPreview(preview: Locator, text: string) {
  await expect.poll(() => preview.isVisible()).toBe(true);
  await expect.poll(() => preview.textContent()).toContain(text);
  expect(await preview.locator("button").count()).toBe(0);
}
function attachmentText(attachment: { content: string }) {
  return Buffer.from(attachment.content, "base64").toString("utf8");
}
type Gateway = Awaited<ReturnType<typeof installMockGateway>>;
type Attachment = { content: string; mimeType: string };
async function sentMessage(gateway: Gateway) {
  return (await gateway.waitForRequest("chat.send")).params as {
    message: string;
    idempotencyKey: string;
    attachments: Attachment[];
  };
}
async function sideQuestion(gateway: Gateway) {
  return (await gateway.waitForRequest("sessions.companion.ask")).params as {
    question: string;
    selectionContext?: string;
    attachments?: unknown[];
  };
}
async function openSelection(
  page: Page,
  options: Parameters<typeof installMockGateway>[1] = {},
  passage = selectedText,
) {
  const gateway = await installMockGateway(page, {
    historyMessages: [{ role: "assistant", content: passage }],
    ...options,
  });
  await page.goto(suite.server.baseUrl + "chat");
  return gateway;
}

function button(scope: Page | Locator, name: string) {
  return scope.getByRole("button", { name, exact: true });
}
function selectedSource(page: Page, passage = selectedText) {
  return page.locator(".chat-bubble .chat-text p").filter({ hasText: passage });
}
function commentEditor(page: Page) {
  return page.getByRole("dialog", { name: "Comment", exact: true });
}
async function addComment(page: Page, comment: string, passage = selectedText) {
  await selectText(selectedSource(page, passage));
  await button(page.getByRole("toolbar", { name: "Selection actions" }), "Add to chat").click();
  await commentEditor(page).getByRole("textbox").fill(comment);
  await commentEditor(page).getByRole("textbox").press("Enter");
}
async function selectText(text: Locator) {
  // The selection toolbar dismisses on scroll, so settle before opening it.
  await waitForChatScrollIdle(text.page());
  await text.scrollIntoViewIfNeeded();
  await waitForChatScrollIdle(text.page());
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
  it.each([
    { scenario: "oversized selection", viewport: viewports[0] },
    { scenario: "low media limit", viewport: viewports[0] },
    { scenario: "oversized edit", viewport: viewports[0] },
    { scenario: "empty question", viewport: viewports[0] },
    { scenario: "normal", viewport: viewports[0] },
    { scenario: "normal", viewport: viewports[1] },
  ])(
    "keeps side-chat selection drafts usable with $scenario at $viewport.width px",
    async ({ scenario, viewport }) => {
      await withPage(
        async ({ page, composer, editor, comment, side, sideComposer, toolbar }) => {
          const passage = scenario === "oversized selection" ? "x".repeat(16_001) : selectedText;
          const gateway = await openSelection(
            page,
            {
              ...(scenario === "low media limit" ? { attachmentMaxBytes: 1 } : {}),
              methodResponses: companionResponses,
            },
            passage,
          );
          await composer.fill(draft);
          const text = selectedSource(page, passage);
          await selectText(text);
          if (scenario === "normal") {
            await toolbar.waitFor({ state: "visible" });
            await page.keyboard.press("Escape");
            expect(await toolbar.count()).toBe(0);
            await selectText(text);
          }
          await button(page, "Ask in side chat").click();
          await editor.waitFor({ state: "visible" });
          if (scenario === "normal") {
            expect(await sideComposer.count()).toBe(0);
          }
          if (scenario === "oversized edit") {
            await submitComment(comment, "x".repeat(16_001));
            expect(await editor.isVisible()).toBe(true);
          }
          await submitComment(comment, "Check the rollback steps.");
          await sideComposer.waitFor({ state: "visible" });
          const quotedDraft = await sideComposer.inputValue();
          expect(quotedDraft).toContain(passage.slice(0, 300));
          expect(quotedDraft.length).toBeLessThan(400);
          if (scenario === "normal") {
            expect(quotedDraft).toBe(`Regarding "${selectedText}": `);
            expect(
              await page
                .locator(".agent-chat__composer-shell .chat-selection-annotations__chip")
                .count(),
            ).toBe(0);
            expect(await composer.inputValue()).toBe(draft);
          }
          const chip = side.locator(".chat-selection-annotations__chip");
          if (scenario === "normal") {
            await chip.waitFor({ state: "visible" });
          }
          expect(await chip.count()).toBe(scenario === "oversized selection" ? 0 : 1);
          if (["normal", "oversized edit", "low media limit"].includes(scenario)) {
            await chip.click();
            await button(side, "Edit comment 1").click();
            if (scenario === "oversized edit") {
              await submitComment(comment, "x".repeat(16_001), "Save");
              expect(await editor.isVisible()).toBe(true);
              expect(await comment.inputValue()).toHaveLength(16_001);
              expect(await sideComposer.inputValue()).toBe(quotedDraft);
              expect(await gateway.getRequests("sessions.companion.ask")).toHaveLength(0);
            }
            await submitComment(
              comment,
              scenario === "normal"
                ? "Check the rollback steps and the owner."
                : "Corrected comment.",
              "Save",
            );
            if (scenario === "normal") {
              expect(await sideComposer.inputValue()).toBe(quotedDraft);
            }
            await editor.waitFor({ state: "detached" });
          }
          const send = side.locator(".chat-session-rail__composer button[type=submit]");
          if (scenario === "empty question") {
            await sideComposer.fill("");
            expect(await send.isDisabled()).toBe(true);
            await sideComposer.press("Enter");
            expect(await gateway.getRequests("sessions.companion.ask")).toHaveLength(0);
            expect(await chip.count()).toBe(1);
            await sideComposer.fill("Explain the selected text.");
          }
          await send.click();
          const params = await sideQuestion(gateway);
          expect(params.question).toBe(
            scenario === "empty question" ? "Explain the selected text." : quotedDraft.trim(),
          );
          expect(params.attachments).toBeUndefined();
          if (scenario === "oversized selection") {
            expect(params.selectionContext).toBeUndefined();
          } else {
            expect(params.selectionContext).toContain(`Selected text:\n${passage}`);
            expect(params.selectionContext).toContain(
              scenario === "normal"
                ? "User comment:\nCheck the rollback steps and the owner."
                : scenario === "oversized edit" || scenario === "low media limit"
                  ? "Corrected comment."
                  : "Check the rollback steps.",
            );
          }
          expect(await composer.inputValue()).toBe(draft);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        },
        { viewport },
      );
    },
  );

  it("reveals draft and sent comments by touch before and after reload", async () => {
    await withPage(
      async ({ page, composer, editor, comment, preview, sentChip, pendingChip }) => {
        const gateway = await openSelection(page);
        const source = selectedSource(page);
        await source.waitFor({ state: "visible" });
        await selectText(source);
        await button(page, "Add to chat").tap();
        await comment.fill("Check the rollback steps. 🦞");
        await button(editor, "Save comment").tap();
        await pendingChip.tap();
        await expect.poll(() => preview.isVisible()).toBe(true);
        const clear = button(page, "Remove all comments");
        expect(await clear.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
        await composer.tap();
        await expect.poll(() => preview.isVisible()).toBe(false);
        await button(page, "Send message").tap();
        const request = await gateway.waitForRequest("chat.send");
        await gateway.emitChatFinal({
          runId: (request.params as { idempotencyKey: string }).idempotencyKey,
          text: "Selected passage received.",
        });
        await page.reload();
        await sentChip.waitFor({ state: "visible" });
        await sentChip.tap();
        await expectReadOnlyPreview(preview, "Check the rollback steps. 🦞");
        expect(await preview.textContent()).toContain(selectedText);
        await composer.tap();
        await expect.poll(() => preview.isVisible()).toBe(false);
        await selectText(source);
        await button(page, "Add to chat").tap();
        await comment.fill("Remove only this pending comment.");
        await button(editor, "Save comment").tap();
        await button(pendingChip, "Remove all comments").tap();
        await pendingChip.waitFor({ state: "detached" });
        expect(await sentChip.count()).toBe(1);
        await sentChip.tap();
        await expectReadOnlyPreview(preview, "Check the rollback steps. 🦞");
        expect(await preview.textContent()).not.toContain("Remove only this pending comment.");
      },
      { viewport: viewports[1], hasTouch: true, isMobile: true, reducedMotion: "no-preference" },
    );
  });

  it.each(viewports)(
    "stages, edits, restores, and sends annotations at $width px",
    async (viewport) => {
      await withPage(
        async ({ page, composer, editor, comment, toolbar, preview, sentChip, pendingChip }) => {
          const gateway = await openSelection(page);
          await composer.waitFor({ state: "visible" });
          const text = selectedSource(page);
          const highlightedText = () =>
            page.evaluate(() =>
              Array.from(CSS.highlights.get("openclaw-comment") ?? [])
                .map((range) => (range instanceof Range ? range.toString() : ""))
                .join(""),
            );
          const chip = (count: number) =>
            pendingChip.filter({ hasText: count === 1 ? "1 comment" : `${count} comments` });
          const pin = (number: number) =>
            page.getByRole("button", { name: `Edit comment ${number}`, exact: true });
          const open = async () => {
            await selectText(text);
            await button(toolbar, "Add to chat").click();
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

          await composer.fill(draft);
          await open();
          expect(await comment.inputValue()).toBe("");
          expect(await composer.inputValue()).toBe(draft);
          expect(await highlightedText()).toBe(selectedText);
          await bounded(editor);
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
          expect(await button(editor, "Cancel").count()).toBe(0);
          expect(await button(editor, "Delete comment").count()).toBe(0);
          await bounded(editor);
          await button(editor, "Save comment").click();
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
          await expect.poll(() => preview.isVisible()).toBe(true);
          await composer.click();
          await expect.poll(() => preview.isVisible()).toBe(false);

          const pinBounds = (await pin(1).boundingBox())!;
          const sourceBounds = (await text.boundingBox())!;
          expect(Math.abs(pinBounds.y - sourceBounds.y)).toBeLessThan(30);
          await pin(1).click();
          expect(await highlightedText()).toBe(selectedText);
          expect((await editor.boundingBox())!.height).toBeGreaterThan(compactHeight);
          const editorBounds = (await editor.boundingBox())!;
          expect(verticalGap(editorBounds, pinBounds)).toBeLessThan(20);
          const deleteComment = button(editor, "Delete comment");
          expect((await deleteComment.textContent())?.trim()).toBe("");
          expect(await deleteComment.locator("svg").count()).toBe(1);
          await bounded(editor);
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
          await submitComment(comment, "Explain the rollback checks. 🦞");
          await pin(1).waitFor({ state: "visible" });
          await bounded(pin(1));
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          await waitForCommittedComposerDraft(
            page,
            `chat:v3:${storedChatOutboxScopeKey({ agentId: "main", sessionKey: "agent:main:main" })}`,
            draft,
            1,
            ["Explain the rollback checks. 🦞"],
          );
          await page.reload();
          await chip(1).waitFor({ state: "visible" });
          expect(await composer.inputValue()).toBe(draft);
          await chip(1).hover();
          await expectPreview(preview, "Explain the rollback checks. 🦞");
          await button(preview, "Edit comment 1").click();
          expect(await comment.inputValue()).toBe("Explain the rollback checks. 🦞");
          await comment.press("Escape");
          await composer.click();
          await open();
          await comment.press("Enter");
          await chip(2).waitFor({ state: "visible" });
          await button(page, "Send message").click();
          const params = await sentMessage(gateway);
          expect(params.message).toBe(draft);
          expect(params.attachments).toHaveLength(2);
          const contents = params.attachments.map((attachment) => {
            expect(attachment.mimeType).toBe("text/plain");
            return attachmentText(attachment);
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
          await sentChip.waitFor({ state: "visible" });
          expect(await sentChip.textContent()).toContain("2 comments");
          await sentChip.hover();
          await expectPreview(preview, "Explain the rollback checks. 🦞");
          expect(await preview.locator("li").count()).toBe(2);
          expect(await preview.locator("button").count()).toBe(0);
          await bounded(preview);
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
        },
        { viewport, serviceWorkers: "block" },
      );
    },
  );

  it.each(viewports)(
    "keeps comment pins anchored through scrolling and reflow at $width px",
    async (viewport) => {
      await withPage(
        async ({ page, editor, comment }) => {
          const passage =
            "Review the rollback checklist carefully before the deployment starts. Confirm every recovery step with the team.";
          const filler = Array.from(
            { length: 24 },
            (_, index) => `Deployment context paragraph ${index + 1}.`,
          ).join("\n\n");
          await openSelection(page, {}, `${filler}\n\n${passage}\n\n${filler}`);
          const text = selectedSource(page, passage);
          await waitForChatScrollIdle(page);
          await page.locator(".chat-thread").hover();
          await page.mouse.wheel(0, -32);
          await waitForChatScrollIdle(page);
          await addComment(page, "Keep this pin on its original passage.", passage);
          const pin = button(page, "Edit comment 1");
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
          expect(await comment.inputValue()).toBe("Keep this pin on its original passage.");
          await comment.press("Escape");
        },
        { viewport },
      );
    },
  );

  it.each([false, true])(
    "keeps retained comments usable after clearing history (replacement: %s)",
    async (replacement) => {
      await withPage(
        async ({ page, editor, comment, preview, composer: mainComposer }) => {
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
            : mainComposer;
          await composer.fill(draft);
          expect(await mainComposer.count()).toBe(replacement ? 0 : 1);
          const pin = button(page, "Edit comment 1");
          const saveComment = async () => {
            await addComment(page, "Review before deployment.");
            await pin.waitFor({ state: "visible" });
          };
          await selectedSource(page).waitFor({ state: "visible" });
          await waitForChatScrollIdle(page);
          await saveComment();
          await pin.click();
          await submitComment(comment, "Check rollback first.", "Save");
          await pin.click();
          expect(await comment.inputValue()).toBe("Check rollback first.");
          await button(editor, "Delete comment").click();
          expect(await pin.count()).toBe(0);
          await saveComment();
          await saveComment();
          expect(await composer.inputValue()).toBe(draft);
          const send = replacement ? button(page, "Fixture send") : button(page, "Send message");
          await gateway.setHistoryMessages([]);
          await composer.fill("/clear");
          await send.click();
          await gateway.waitForRequest("sessions.reset");
          await selectedSource(page).waitFor({ state: "detached" });
          const chip = page.locator(".chat-selection-annotations__chip");
          await chip.hover();
          await preview.waitFor({ state: "visible" });
          expect(await preview.getByText(selectedText, { exact: true }).count()).toBe(2);
          await button(preview, "Edit comment 1").click();
          await comment.fill("Edited after history was cleared.");
          await page.setViewportSize({ width: 900, height: 850 });
          await expect.poll(() => editor.isVisible()).toBe(true);
          await button(editor, "Save").click();
          await chip.hover();
          await preview
            .getByText("Edited after history was cleared.", { exact: true })
            .waitFor({ state: "visible" });
          await button(preview, "Delete comment").first().click();
          await expect.poll(() => chip.textContent()).toContain("1 comment");
          await composer.fill(draft);
          await send.click();
          const params = await sentMessage(gateway);
          expect(params.message).toBe(draft);
          expect(params.attachments).toHaveLength(1);
          expect(attachmentText(params.attachments[0]!)).toContain("Review before deployment.");
          await expect.poll(() => pin.count()).toBe(0);
        },
        { reducedMotion: "no-preference" },
      );
    },
  );

  it("repositions the open editor when its pinned passage wraps", async () => {
    await withPage(async ({ page, editor, comment }) => {
      const passage =
        "Review the rollback checklist carefully before the deployment starts. Confirm every recovery step with the team before proceeding.";
      await openSelection(page, {}, passage);
      const text = page.locator(".chat-bubble .chat-text p");
      await text.waitFor({ state: "visible" });
      await addComment(page, "Review this passage.", passage);
      const pin = button(page, "Edit comment 1");
      await pin.click();
      await page.setViewportSize({ width: 390, height: 900 });
      await expect
        .poll(async () => {
          const marker = await pin.boundingBox();
          const popup = await editor.boundingBox();
          return marker && popup ? verticalGap(popup, marker) : 1000;
        })
        .toBeLessThan(12);
      expect(await comment.inputValue()).toBe("Review this passage.");
    });
  });

  it("keeps formatted selection text and DOM source offsets consistent", async () => {
    await withPage(async ({ page, preview, sentChip }) => {
      const gateway = await openSelection(page, {}, "A  \nB");
      const paragraph = page.locator(".chat-bubble .chat-text p");
      await paragraph.waitFor({ state: "visible" });
      const sourceText = await page.locator(".chat-bubble").textContent();
      const selectedDomText = await paragraph.textContent();
      await selectText(paragraph);
      await button(page.getByRole("toolbar", { name: "Selection actions" }), "Add to chat").click();
      await button(commentEditor(page), "Save comment").click();
      await button(page, "Send message").click();
      const params = await sentMessage(gateway);
      const content = attachmentText(params.attachments[0]!);
      expect(content).toContain("Selected text:\nA\nB");
      const offsets = /DOM text UTF-16 range: \[(\d+), (\d+)\)/.exec(content);
      expect(offsets).not.toBeNull();
      expect(sourceText?.slice(Number(offsets![1]), Number(offsets![2]))).toBe(selectedDomText);
      await gateway.emitChatFinal({
        runId: params.idempotencyKey,
        text: "Selected passage received.",
      });
      await sentChip.waitFor({ state: "visible" });
      await sentChip.hover();
      await expect
        .poll(() => preview.locator(".chat-comment-preview__text").textContent())
        .toBe("A\nB");
      await page.reload();
      await sentChip.waitFor({ state: "visible" });
      await sentChip.hover();
      await expect
        .poll(() => preview.locator(".chat-comment-preview__text").textContent())
        .toBe("A\nB");
    });
  });
});
