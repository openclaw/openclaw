import type { Locator, Page } from "playwright";
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

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const suite = createControlUiE2eSuite({ name: "Control UI selected text destinations" });
const selectedText = "Review the deployment checklist.";
const draft = "Please explain the next step.";
const viewports = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: suite.artifactDir + "/" + name + ".png" });
}
async function openSelection(page: Page, options: Parameters<typeof installMockGateway>[1] = {}) {
  const gateway = await installMockGateway(page, {
    historyMessages: [{ role: "assistant", content: selectedText }],
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
  it.each(["oversized selection", "low media limit", "oversized edit", "empty question"])(
    "keeps side-chat selection drafts usable with %s",
    async (scenario) => {
      await suite.withPage(
        {
          viewport: viewports[0],
          locale: "en-US",
          reducedMotion: "reduce",
          recordVideo: captureUiProof
            ? { dir: suite.artifactDir, size: { width: 1440, height: 900 } }
            : undefined,
        },
        async ({ page }) => {
          const passage = scenario === "oversized selection" ? "x".repeat(16_001) : selectedText;
          const gateway = await installMockGateway(page, {
            historyMessages: [{ role: "assistant", content: passage }],
            ...(scenario === "low media limit" ? { attachmentMaxBytes: 1 } : {}),
            methodResponses: {
              "sessions.companion.ask": { answer: "Review the rollback steps.", ts: 1 },
              "sessions.companion.state": { exchanges: [] },
            },
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          const composer = page.locator(".agent-chat__composer-shell textarea");
          await composer.fill(draft);
          await selectText(selectedSource(page, passage));
          await button(page, "Ask in side chat").click();
          const editor = commentEditor(page);
          if (scenario === "oversized edit") {
            await editor.getByRole("textbox").fill("x".repeat(16_001));
            await button(editor, "Save comment").click();
            expect(await editor.isVisible()).toBe(true);
          }
          await editor.getByRole("textbox").fill("Check the rollback steps.");
          await button(editor, "Save comment").click();
          const side = page.locator("openclaw-chat-session-rail");
          const sideComposer = side.locator(".chat-session-rail__input");
          await sideComposer.waitFor({ state: "visible" });
          const quotedDraft = await sideComposer.inputValue();
          expect(quotedDraft).toContain(passage.slice(0, 300));
          expect(quotedDraft.length).toBeLessThan(400);
          const chip = side.locator(".chat-selection-annotations__chip");
          expect(await chip.count()).toBe(scenario === "oversized selection" ? 0 : 1);
          if (scenario === "oversized edit" || scenario === "low media limit") {
            await chip.click();
            await button(side, "Edit comment 1").click();
            if (scenario === "oversized edit") {
              await editor.getByRole("textbox").fill("x".repeat(16_001));
              await button(editor, "Save").click();
              expect(await editor.isVisible()).toBe(true);
              expect(await editor.getByRole("textbox").inputValue()).toHaveLength(16_001);
              expect(await sideComposer.inputValue()).toBe(quotedDraft);
              expect(await gateway.getRequests("sessions.companion.ask")).toHaveLength(0);
              await screenshot(page, `side-comment-too-long`);
            }
            await editor.getByRole("textbox").fill("Corrected comment.");
            await button(editor, "Save").click();
            await editor.waitFor({ state: "detached" });
          }
          const send = side.locator(".chat-session-rail__composer button[type=submit]");
          if (scenario === "empty question") {
            await sideComposer.fill("");
            expect(await send.isDisabled()).toBe(true);
            await sideComposer.press("Enter");
            expect(await gateway.getRequests("sessions.companion.ask")).toHaveLength(0);
            expect(await chip.count()).toBe(1);
            await screenshot(page, `side-comment-empty-question`);
            await sideComposer.fill("Explain the selected text.");
          }
          await screenshot(page, `side-comment-${scenario.replaceAll(" ", "-")}-ready`);
          await send.click();
          const request = await gateway.waitForRequest("sessions.companion.ask");
          const params = request.params as {
            question: string;
            selectionContext?: string;
            attachments?: unknown[];
          };
          expect(params.question).toBe(
            scenario === "empty question" ? "Explain the selected text." : quotedDraft.trim(),
          );
          expect(params.attachments).toBeUndefined();
          if (scenario === "oversized selection") {
            expect(params.selectionContext).toBeUndefined();
          } else {
            expect(params.selectionContext).toContain(`Selected text:\n${passage}`);
            expect(params.selectionContext).toContain(
              scenario === "oversized edit" || scenario === "low media limit"
                ? "Corrected comment."
                : "Check the rollback steps.",
            );
          }
          expect(await composer.inputValue()).toBe(draft);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        },
      );
    },
  );

  it("reveals draft and sent comments by touch before and after reload", async () => {
    await suite.withPage(
      { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: "en-US" },
      async ({ page }) => {
        const gateway = await openSelection(page);
        const source = page.locator(".chat-bubble .chat-text p").filter({ hasText: selectedText });
        await source.waitFor({ state: "visible" });
        await selectText(source);
        await button(page, "Add to chat").tap();
        const editor = commentEditor(page);
        await editor.getByRole("textbox").fill("Check the rollback steps. 🦞");
        await button(editor, "Save comment").tap();
        const preview = page.getByRole("region", { name: "Comments", exact: true });
        await page.locator(".chat-attachments-preview .chat-selection-annotations__chip").tap();
        await expect.poll(() => preview.isVisible()).toBe(true);
        const clear = button(page, "Remove all comments");
        expect(await clear.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
        await page.locator(".agent-chat__composer-shell textarea").tap();
        await expect.poll(() => preview.isVisible()).toBe(false);
        await button(page, "Send message").tap();
        const request = await gateway.waitForRequest("chat.send");
        await gateway.emitChatFinal({
          runId: (request.params as { idempotencyKey: string }).idempotencyKey,
          text: "Selected passage received.",
        });
        await page.reload();
        const sentChip = page.locator(
          "openclaw-chat-sent-comments .chat-selection-annotations__chip",
        );
        await sentChip.waitFor({ state: "visible" });
        await sentChip.tap();
        await screenshot(page, `sent-comment-touch`);
        await expect.poll(() => preview.isVisible()).toBe(true);
        await expect.poll(() => preview.textContent()).toContain(selectedText);
        await expect.poll(() => preview.textContent()).toContain("Check the rollback steps. 🦞");
        expect(await preview.locator("button").count()).toBe(0);
        await page.locator(".agent-chat__composer-shell textarea").tap();
        await expect.poll(() => preview.isVisible()).toBe(false);
        await selectText(source);
        await button(page, "Add to chat").tap();
        await editor.getByRole("textbox").fill("Remove only this pending comment.");
        await button(editor, "Save comment").tap();
        const pendingChip = page.locator(
          ".chat-attachments-preview .chat-selection-annotations__chip",
        );
        await button(pendingChip, "Remove all comments").tap();
        await pendingChip.waitFor({ state: "detached" });
        expect(await sentChip.count()).toBe(1);
        await sentChip.tap();
        await expect.poll(() => preview.isVisible()).toBe(true);
        await expect.poll(() => preview.textContent()).toContain("Check the rollback steps. 🦞");
        expect(await preview.textContent()).not.toContain("Remove only this pending comment.");
        expect(await preview.locator("button").count()).toBe(0);
      },
    );
  });

  it.each(viewports)(
    "stages, edits, restores, and sends annotations at $width px",
    async (viewport) => {
      await suite.withPage(
        {
          viewport,
          locale: "en-US",
          reducedMotion: "reduce",
          serviceWorkers: "block",
          recordVideo: captureUiProof ? { dir: suite.artifactDir, size: viewport } : undefined,
        },
        async ({ page }) => {
          const gateway = await openSelection(page);
          const composer = page.locator(".agent-chat__composer-shell textarea");
          await composer.waitFor({ state: "visible" });
          const text = selectedSource(page);
          const toolbar = page.getByRole("toolbar", { name: "Selection actions" });
          const editor = commentEditor(page);
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
          expect(await button(editor, "Cancel").count()).toBe(0);
          expect(await button(editor, "Delete comment").count()).toBe(0);
          await bounded(editor);
          await capture("inline-typed");
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
          const openedPreview = page.getByRole("region", { name: "Comments", exact: true });
          await expect.poll(() => openedPreview.isVisible()).toBe(true);
          await composer.click();
          await expect.poll(() => openedPreview.isVisible()).toBe(false);
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
          const deleteComment = button(editor, "Delete comment");
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
          await button(editor, "Save comment").click();
          await pin(1).waitFor({ state: "visible" });
          await bounded(pin(1));
          await capture("composer");
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
          await capture("restored-draft");
          await chip(1).hover();
          const preview = page.getByRole("region", { name: "Comments", exact: true });
          await preview.waitFor({ state: "visible" });
          expect(await preview.textContent()).toContain("Explain the rollback checks. 🦞");
          await button(preview, "Edit comment 1").click();
          expect(await comment.inputValue()).toBe("Explain the rollback checks. 🦞");
          await comment.press("Escape");
          await composer.click();
          await open();
          await comment.press("Enter");
          await chip(2).waitFor({ state: "visible" });
          await button(page, "Send message").click();
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
          const text = selectedSource(page, passage);
          await waitForChatScrollIdle(page);
          await page.locator(".chat-thread").hover();
          await page.mouse.wheel(0, -32);
          await waitForChatScrollIdle(page);
          await text.scrollIntoViewIfNeeded();
          await waitForChatScrollIdle(page);
          const editor = commentEditor(page);
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
        const editor = commentEditor(page);
        const pin = button(page, "Edit comment 1");
        const saveComment = async () => {
          await addComment(page, "Review before deployment.");
          await pin.waitFor({ state: "visible" });
        };
        await saveComment();
        await pin.click();
        await editor.getByRole("textbox").fill("Check rollback first.");
        await button(editor, "Save").click();
        await pin.click();
        expect(await editor.getByRole("textbox").inputValue()).toBe("Check rollback first.");
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
        await page
          .locator(".chat-bubble .chat-text p")
          .filter({ hasText: selectedText })
          .waitFor({ state: "detached" });
        const chip = page.locator(".chat-selection-annotations__chip");
        await chip.hover();
        const preview = page.getByRole("region", { name: "Comments", exact: true });
        await preview.waitFor({ state: "visible" });
        expect(await preview.getByText(selectedText, { exact: true }).count()).toBe(2);
        await button(preview, "Edit comment 1").click();
        await editor.getByRole("textbox").fill("Edited after history was cleared.");
        await page.setViewportSize({ width: 900, height: 850 });
        await expect.poll(() => editor.isVisible()).toBe(true);
        await button(editor, "Save").click();
        await chip.hover();
        await preview
          .getByText("Edited after history was cleared.", { exact: true })
          .waitFor({ state: "visible" });
        await screenshot(page, `retained-comments-${replacement ? "replacement" : "default"}`);
        await button(preview, "Delete comment").first().click();
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
        const editor = commentEditor(page);
        await addComment(page, "Review this passage.", passage);
        const pin = button(page, "Edit comment 1");
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
        await button(
          page.getByRole("toolbar", { name: "Selection actions" }),
          "Add to chat",
        ).click();
        await button(commentEditor(page), "Save comment").click();
        await button(page, "Send message").click();
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
        await screenshot(page, `formatted-sent-hover`);
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
    "stages selected-text comments in side chat at $width px",
    async (viewport) => {
      await suite.withPage(
        { viewport, locale: "en-US", reducedMotion: "reduce" },
        async ({ page }) => {
          const gateway = await openSelection(page, {
            methodResponses: {
              "sessions.companion.ask": { answer: "Review the rollback steps.", ts: 1 },
              "sessions.companion.state": { exchanges: [] },
            },
          });
          const composer = page.locator(".agent-chat__composer-shell textarea");
          await composer.fill(draft);
          const text = selectedSource(page);
          const toolbar = page.getByRole("toolbar", { name: "Selection actions" });
          await selectText(text);
          await toolbar.waitFor({ state: "visible" });
          await page.keyboard.press("Escape");
          expect(await toolbar.count()).toBe(0);
          await selectText(text);
          await button(toolbar, "Ask in side chat").click();
          const editor = commentEditor(page);
          await editor.waitFor({ state: "visible" });
          expect(await page.locator(".chat-session-rail__input").count()).toBe(0);
          await editor.getByRole("textbox").fill("Check the rollback steps.");
          await button(editor, "Save comment").click();
          const sideComposer = page.locator(".chat-session-rail__input");
          await sideComposer.waitFor({ state: "visible" });
          expect(await sideComposer.inputValue()).toBe(`Regarding "${selectedText}": `);
          const side = page.locator("openclaw-chat-session-rail");
          const chip = side.locator(".chat-selection-annotations__chip");
          await chip.waitFor({ state: "visible" });
          expect(
            await page
              .locator(".agent-chat__composer-shell .chat-selection-annotations__chip")
              .count(),
          ).toBe(0);
          expect(await composer.inputValue()).toBe(draft);
          if (viewport.width === 1440) {
            await screenshot(page, `after-side-selection`);
          }
          await chip.click();
          await button(side, "Edit comment 1").click();
          await editor.getByRole("textbox").fill("Check the rollback steps and the owner.");
          await button(editor, "Save").click();
          expect(await sideComposer.inputValue()).toBe(`Regarding "${selectedText}": `);
          await side.locator(".chat-session-rail__composer button[type=submit]").click();
          const request = await gateway.waitForRequest("sessions.companion.ask");
          const params = request.params as {
            question: string;
            selectionContext: string;
            attachments?: unknown[];
          };
          expect(params.question).toBe(`Regarding "${selectedText}":`);
          expect(params.attachments).toBeUndefined();
          const context = params.selectionContext;
          expect(context).toContain(`Selected text:\n${selectedText}`);
          expect(context).toContain("User comment:\nCheck the rollback steps and the owner.");
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          expect(await composer.inputValue()).toBe(draft);
        },
      );
    },
  );
});
