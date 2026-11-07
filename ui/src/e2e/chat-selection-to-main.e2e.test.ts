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
import { pollText, pollValue, pollCount } from "./new-session-page.test-support.ts";
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
  await pollText(preview).toContain(text);
}
type Gateway = Awaited<ReturnType<typeof installMockGateway>>;
async function sentMessage(gateway: Gateway) {
  return (await gateway.waitForRequest("chat.send")).params as {
    message: string;
    idempotencyKey: string;
    attachments?: unknown[];
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
  // Sent comments quote the passage; the source is the unquoted paragraph.
  return page.locator(".chat-bubble .chat-text p:not(blockquote p)").filter({ hasText: passage });
}
function commentEditor(page: Page) {
  return page.getByRole("dialog", { name: "Comment", exact: true });
}
async function addComment(page: Page, comment: string, passage = selectedText) {
  await selectText(selectedSource(page, passage));
  await button(page.getByRole("toolbar", { name: "Selection actions" }), "Add to message").click();
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
    { scenario: "normal", viewport: viewports[1] },
  ])(
    "stages side-chat selection comments without a prefilled question with $scenario at $viewport.width px",
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
          if (scenario === "oversized selection") {
            // A passage Side chat cannot carry stays correctable in the editor.
            await page
              .getByText("These comments are too long for Side chat.", { exact: false })
              .waitFor();
            expect(await editor.isVisible()).toBe(true);
            expect(await side.locator(".chat-selection-annotations__chip").count()).toBe(0);
            expect(await gateway.getRequests("sessions.companion.ask")).toHaveLength(0);
            expect(await composer.inputValue()).toBe(draft);
            return;
          }
          await sideComposer.waitFor({ state: "visible" });
          // The comment chip carries the passage; the question field stays the user's.
          expect(await sideComposer.inputValue()).toBe("");
          await expect
            .poll(() => sideComposer.evaluate((element) => document.activeElement === element))
            .toBe(true);
          if (scenario === "normal") {
            expect(
              await page
                .locator(".agent-chat__composer-shell .chat-selection-annotations__chip")
                .count(),
            ).toBe(0);
            expect(await composer.inputValue()).toBe(draft);
          }
          const chip = side.locator(".chat-selection-annotations__chip");
          // The preview loads independently of the side-chat textarea.
          await chip.waitFor({ state: "visible" });
          expect(await chip.count()).toBe(1);
          await chip.click();
          await button(side, "Edit comment 1").click();
          if (scenario === "oversized edit") {
            await submitComment(comment, "x".repeat(16_001), "Save");
            expect(await editor.isVisible()).toBe(true);
            expect(await comment.inputValue()).toHaveLength(16_001);
            expect(await sideComposer.inputValue()).toBe("");
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
            expect(await sideComposer.inputValue()).toBe("");
          }
          await editor.waitFor({ state: "detached" });
          const send = side.locator(".chat-session-rail__composer button[type=submit]");
          if (scenario === "normal") {
            // Saving a comment is sufficient input; no second question is required.
            expect(await send.isEnabled()).toBe(true);
          } else {
            await sideComposer.fill("Explain the selected text.");
          }
          await send.click();
          const params = await sideQuestion(gateway);
          expect(params.question).toBe(
            scenario === "normal"
              ? "Respond to the selected text and comments."
              : "Explain the selected text.",
          );
          expect(params.attachments).toBeUndefined();
          expect(params.selectionContext).toContain(`Selected text:\n${passage}`);
          expect(params.selectionContext).toContain(
            scenario === "normal"
              ? "User comment:\nCheck the rollback steps and the owner."
              : "Corrected comment.",
          );
          expect(await composer.inputValue()).toBe(draft);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        },
        { viewport },
      );
    },
  );

  it("reveals draft and sent comments by touch before and after reload", async () => {
    await withPage(
      async ({ page, composer, editor, comment, preview, pendingChip }) => {
        const sent = page.locator(".chat-bubble").filter({ has: page.locator("blockquote") });
        const sentQuote = sent.locator("blockquote").filter({ hasText: selectedText });
        const gateway = await openSelection(page);
        const source = selectedSource(page);
        await source.waitFor({ state: "visible" });
        await selectText(source);
        await button(page, "Add to message").tap();
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
        const params = request.params as { idempotencyKey: string; message: string };
        expect(params.message).toBe(`> ${selectedText}\n\nCheck the rollback steps. 🦞`);
        await gateway.emitChatFinal({
          runId: params.idempotencyKey,
          text: "Selected passage received.",
        });
        await page.reload();
        await sentQuote.waitFor({ state: "visible" });
        await pollText(sent).toContain("Check the rollback steps. 🦞");
        await selectText(source);
        await button(page, "Add to message").tap();
        await comment.fill("Remove only this pending comment.");
        await button(editor, "Save comment").tap();
        await button(pendingChip, "Remove all comments").tap();
        await pendingChip.waitFor({ state: "detached" });
        expect(await sentQuote.count()).toBe(1);
        await pollText(sent).toContain("Check the rollback steps. 🦞");
        expect(await sent.textContent()).not.toContain("Remove only this pending comment.");
      },
      { viewport: viewports[1], hasTouch: true, isMobile: true, reducedMotion: "no-preference" },
    );
  });

  it("restores staged annotations and sends ordered read-only comments", async () => {
    const viewport = viewports[1]!;
    await withPage(
      async ({ page, composer, editor, comment, toolbar, preview, pendingChip }) => {
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
          await button(toolbar, "Add to message").click();
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
        expect(await highlightedText()).toBe(selectedText);
        await comment.press("Escape");
        await expect.poll(highlightedText).toBe("");
        await open();
        await bounded(editor);
        await submitComment(comment, "Explain the rollback checks. 🦞");
        await pin(1).waitFor({ state: "visible" });
        await bounded(pin(1));
        expect(await highlightedText()).toBe("");
        expect(await composer.inputValue()).toBe(draft);
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
        // Comments are part of the user message, in order, ahead of the draft.
        expect(params.message).toBe(
          `> ${selectedText}\n\nExplain the rollback checks. 🦞\n\n> ${selectedText}\n\n${draft}`,
        );
        expect(params.attachments ?? []).toHaveLength(0);
        await pollValue(composer).toBe("");
        expect(await chip(2).count()).toBe(0);
        expect(await pin(1).count()).toBe(0);
        await gateway.emitChatFinal({
          runId: params.idempotencyKey,
          text: "The checks are ready.",
        });
        const sent = page.locator(".chat-bubble").filter({ hasText: draft });
        const sentQuotes = sent.locator("blockquote").filter({ hasText: selectedText });
        await pollCount(sentQuotes).toBe(2);
        await pollText(sent).toContain("Explain the rollback checks. 🦞");
        await page.reload();
        await pollCount(sentQuotes).toBe(2);
        await pollText(sent).toContain("Explain the rollback checks. 🦞");
        expect(
          await page
            .locator(".chat-assistant-attachment-card__title")
            .filter({ hasText: "selection-comment.txt" })
            .count(),
        ).toBe(0);
      },
      { viewport, serviceWorkers: "block" },
    );
  });

  it("keeps comment pins and their editor anchored through scrolling and reflow", async () => {
    await withPage(async ({ page, editor, comment }) => {
      const passage =
        "Review the rollback checklist carefully before the deployment starts. Confirm every recovery step with the team.";
      const filler = Array.from(
        { length: 24 },
        (_, index) => `Deployment context paragraph ${index + 1}.`,
      ).join("\n\n");
      const sourceMarkdown = `**${passage}** This context is not selected.`;
      await openSelection(page, {}, `${filler}\n\n${sourceMarkdown}\n\n${filler}`);
      const text = selectedSource(page, passage);
      await waitForChatScrollIdle(page);
      await page.locator(".chat-thread").hover();
      await page.mouse.wheel(0, -32);
      await waitForChatScrollIdle(page);
      await selectText(text.locator("strong"));
      await button(page, "Add to message").click();
      await submitComment(comment, "Keep this pin on its original passage.");
      const pin = button(page, "Edit comment 1");
      const aligned = async () => {
        await expect
          .poll(async () => {
            const lastLine = await text.evaluate((element) => {
              const last = [...element.querySelector("strong")!.getClientRects()].at(-1)!;
              const range = document.createRange();
              range.selectNodeContents(element);
              const right = Math.max(
                ...Array.from(range.getClientRects(), (rect) =>
                  rect.top < last.bottom && rect.bottom > last.top ? rect.right : 0,
                ),
              );
              return { top: last.top, height: last.height, right };
            });
            const marker = await pin.boundingBox();
            return marker && marker.x >= lastLine.right
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
      await pin.click();
      await page.setViewportSize({ width: 390, height: viewports[0]!.height });
      await aligned();
      await expect
        .poll(async () => {
          const marker = await pin.boundingBox();
          const popup = await editor.boundingBox();
          return marker && popup ? verticalGap(popup, marker) : 1000;
        })
        .toBeLessThan(12);
      expect(await comment.inputValue()).toBe("Keep this pin on its original passage.");
      await comment.press("Escape");
    });
  });

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
          await button(editor, "Save").click();
          await chip.hover();
          await preview
            .getByText("Edited after history was cleared.", { exact: true })
            .waitFor({ state: "visible" });
          await button(preview, "Delete comment").first().click();
          await pollText(chip).toContain("1 comment");
          await composer.fill(draft);
          await send.click();
          const params = await sentMessage(gateway);
          expect(params.message).toBe(`> ${selectedText}\n\nReview before deployment.\n\n${draft}`);
          expect(params.attachments ?? []).toHaveLength(0);
          await pollCount(pin).toBe(0);
        },
        { reducedMotion: "no-preference" },
      );
    },
  );

  it("quotes every line of formatted selection text in the message", async () => {
    await withPage(async ({ page }) => {
      const gateway = await openSelection(page, {}, "A  \nB");
      const paragraph = page.locator(".chat-bubble .chat-text p");
      await paragraph.waitFor({ state: "visible" });
      await selectText(paragraph);
      await button(
        page.getByRole("toolbar", { name: "Selection actions" }),
        "Add to message",
      ).click();
      await button(commentEditor(page), "Save comment").click();
      await button(page, "Send message").click();
      const params = await sentMessage(gateway);
      expect(params.message).toBe("> A\n> B");
      expect(params.attachments ?? []).toHaveLength(0);
    });
  });

  it("starts a new session from the launcher with the selected excerpt attached", async () => {
    await withPage(async ({ page, composer, toolbar }) => {
      const gateway = await openSelection(page);
      await composer.fill(draft);
      await selectText(selectedSource(page));
      await toolbar.waitFor({ state: "visible" });
      const destinations = toolbar.getByRole("group", { name: "Ask in…", exact: true });
      await destinations.hover();
      await button(destinations, "Ask in new session").click();
      const palette = page.locator("openclaw-command-palette");
      const input = palette.locator(".cmd-palette__input");
      await input.waitFor({ state: "visible" });
      const chip = palette.locator(".chat-selection-annotations__chip");
      await chip.click();
      await button(palette, "Delete comment").waitFor({ state: "visible" });
      // The launcher has no transcript anchor to reopen the editor against.
      expect(await palette.getByRole("button", { name: "Edit comment 1" }).count()).toBe(0);
      await input.fill("Summarize the risks.");
      await input.press("ControlOrMeta+Enter");
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        message: `> ${selectedText}\n\nSummarize the risks.`,
      });
      expect(create.params).not.toHaveProperty("attachments");
      expect(await composer.inputValue()).toBe(draft);
    });
  });
});
