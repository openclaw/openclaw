import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { mediaTicketPayload } from "../test-helpers/control-ui-attachment-fixtures.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import { auditMarkdownTable } from "./chat-markdown-table-layout.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI comment lifecycle" });
const passage = "Review the deployment checklist.";
const pageOptions = {
  viewport: { width: 1440, height: 900 },
  reducedMotion: "reduce",
  locale: "en-US",
} as const;

const focused = (locator: Locator) =>
  locator.evaluate((element) => element === document.activeElement);
const expectFocus = (locator: Locator) => expect.poll(() => focused(locator)).toBe(true);
const button = (scope: Page | Locator, name: string | RegExp) =>
  scope.getByRole("button", { name, exact: true });

async function sendComment(page: Page, gateway: Awaited<ReturnType<typeof installMockGateway>>) {
  await button(page, "Send message").click();
  const { params } = await gateway.waitForRequest("chat.send");
  const sent = params as {
    message: string;
    idempotencyKey: string;
    sessionKey: string;
    attachments: Array<{ content: string }>;
  };
  expect(sent.attachments).toHaveLength(1);
  return {
    ...sent,
    attachment: Buffer.from(sent.attachments[0]!.content, "base64").toString("utf8"),
  };
}

async function sendWithoutComments(
  page: Page,
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
) {
  await button(page, "Send message").click();
  const request = await gateway.waitForRequest("chat.send");
  expect((request.params as { attachments?: unknown[] }).attachments ?? []).toHaveLength(0);
}

async function openChat(page: Page, content = passage, historyMessages?: unknown[]) {
  const gateway = await installMockGateway(page, {
    historyMessages: historyMessages ?? [{ role: "assistant", content }],
  });
  await page.goto(`${suite.server.baseUrl}chat`);
  const editor = page.getByRole("dialog", { name: "Comment", exact: true });
  return {
    gateway,
    editor,
    input: editor.getByRole("textbox"),
    composer: page.locator(".agent-chat__composer-shell textarea"),
    source: page.locator(".chat-bubble .chat-text p").filter({ hasText: passage }),
    chip: page.locator(".chat-selection-annotations__chip"),
    preview: page.getByRole("region", { name: "Comments", exact: true }),
  };
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

async function addComment(page: Page, source: Locator, comment: string) {
  await selectText(source);
  await button(page.getByRole("toolbar", { name: "Selection actions" }), "Add to chat").click();
  const editor = page.getByRole("dialog", { name: "Comment", exact: true });
  await editor.getByRole("textbox").fill(comment);
  await editor.getByRole("textbox").press("Enter");
}

suite.define(() => {
  it("keeps the annotation-only bubble visible while its sent attachment is read", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      await page.clock.install({ time: new Date() });
      const history = [
        ...Array.from({ length: 30 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          content: `Deployment checkpoint ${index + 1}. Review the service health before proceeding.`,
        })),
        { role: "assistant", content: passage },
      ];
      const { source, gateway } = await openChat(page, passage, history);
      const comment = "Explain the rollback steps before changing the deployment.";
      await addComment(page, source, comment);
      await gateway.deferNext("chat.send");
      const sent = await sendComment(page, gateway);
      expect(sent.message).toBe("");
      const inline = page.locator(".chat-sent-comments-inline");
      const quote = inline.getByRole("button", { name: passage, exact: true });
      await quote.waitFor();
      const before = await inline.boundingBox();
      expect(before).not.toBeNull();
      await gateway.resolveDeferred("chat.send", {
        runId: sent.idempotencyKey,
        status: "started",
      });
      expect(await quote.isVisible()).toBe(true);
      expect(await inline.textContent()).toContain(comment);
      expect(await inline.textContent()).not.toContain("Loading");
      expect((await inline.boundingBox())?.height).toBe(before!.height);
      const canonicalBody = createDeferred();
      const reread = createDeferred();
      let reads = 0;
      let tickets = 0;
      await page.route("**/__openclaw__/assistant-media?**", async (route) => {
        if (new URL(route.request().url()).searchParams.has("meta")) {
          const now = await page.evaluate(() => Date.now());
          await route.fulfill({
            json: {
              ...mediaTicketPayload(`annotation-${++tickets}`, 60_000),
              mediaTicketExpiresAt: new Date(now + 60_000).toISOString(),
            },
          });
          return;
        }
        await (++reads === 1 ? canonicalBody.promise : reread.promise);
        await route.fulfill({ contentType: "text/plain", body: sent.attachment });
      });
      const canonicalRead = page.waitForResponse(
        (response) =>
          response.url().includes("/assistant-media?") &&
          !new URL(response.url()).searchParams.has("meta"),
      );
      const canonicalId = `mock-user:${sent.idempotencyKey}`;
      const canonicalSeq = history.length + 1;
      const canonical = {
        role: "user",
        content: "",
        idempotencyKey: `${sent.idempotencyKey}:user`,
        __openclaw: {
          id: canonicalId,
          seq: canonicalSeq,
          media: [
            {
              kind: "file",
              url: "media://inbound/selection-comment.txt",
              fileName: "selection-comment.txt",
              contentType: "text/plain",
            },
          ],
        },
      };
      const session = await gateway.getSessionRow(sent.sessionKey);
      try {
        await gateway.emitGatewayEvent("session.message", {
          sessionKey: sent.sessionKey,
          sessionId: session.sessionId,
          status: session.status,
          hasActiveRun: session.hasActiveRun,
          activeRunIds: session.activeRunIds,
          session,
          clientRunId: sent.idempotencyKey,
          messageId: canonicalId,
          messageSeq: canonicalSeq,
          message: canonical,
        });
        await page.locator(`[data-entry-id="${canonicalId}"]`).waitFor();
        expect(await quote.isVisible()).toBe(true);
        expect(await inline.textContent()).toContain(comment);
        expect((await inline.boundingBox())?.height).toBe(before!.height);
      } finally {
        canonicalBody.resolve();
      }
      await (await canonicalRead).finished();
      await quote.waitFor();
      await waitForChatScrollIdle(page);
      expect(await inline.textContent()).toContain(comment);
      const thread = page.locator(".chat-thread");
      const observation = await page.evaluateHandle(() => {
        let loading = false;
        const observer = new MutationObserver(() => {
          loading ||= Boolean(
            document.querySelector(".chat-sent-comments-inline")?.textContent?.includes("Loading"),
          );
        });
        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        return { sawLoading: () => loading, stop: () => observer.disconnect() };
      });
      try {
        for (const renewed of [false, true]) {
          if (renewed) {
            await page.clock.fastForward(31_000);
            await expect.poll(() => reads).toBeGreaterThan(1);
          }
          await thread.evaluate((element) => {
            element.scrollTop = 0;
          });
          await inline.waitFor({ state: "detached" });
          await thread.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          await quote.waitFor();
          expect(await inline.textContent()).toContain(comment);
          expect((await inline.boundingBox())?.height).toBe(before!.height);
          expect(await observation.evaluate((state) => state.sawLoading())).toBe(false);
          if (!renewed) {
            expect(reads).toBe(1);
          }
        }
      } finally {
        reread.resolve();
        await observation.evaluate((state) => state.stop());
        await observation.dispose();
      }
    });
  });
  it.each([
    { width: 1440, height: 900, theme: "dark" },
    { width: 390, height: 844, theme: "light" },
  ] as const)(
    "keeps an annotation-only quote on one line at $width px",
    async ({ width, height, theme }) => {
      await suite.withPage(
        { ...pageOptions, viewport: { width, height }, colorScheme: theme },
        async ({ page }) => {
          // Relative-label minute refreshes are separate from quote geometry and focus.
          await page.clock.setFixedTime(new Date("2026-10-25T09:19:30Z"));
          const selected = `${passage} The selected deployment and rollback instructions must remain available in full.\nKeep the complete second line and the long identifier deployment_configuration_review_012345678901234567890123456789.`;
          const comment =
            "Keep all of the selected context.\nExplain the rollback steps before changing the deployment.";
          const { source, gateway } = await openChat(page, selected);
          await addComment(page, source, comment);
          const params = await sendComment(page, gateway);
          expect(params.message).toBe("");
          expect(params.attachment).toContain(
            `Selected text:\n${selected}\n\nUser comment:\n${comment}`,
          );
          expect(params.attachment).toContain("Source session:");
          await gateway.emitChatFinal({
            runId: params.idempotencyKey,
            sessionKey: params.sessionKey,
            text: "I will keep the full context and explain the rollback steps.",
          });
          await page
            .locator(".chat-text")
            .getByText("I will keep the full context and explain the rollback steps.", {
              exact: true,
            })
            .waitFor();
          await waitForChatScrollIdle(page);
          const inline = page.locator(".chat-sent-comments-inline");
          await inline.waitFor();
          const authored = inline.locator(".chat-sent-comments-inline__comment");
          await expect.poll(() => authored.textContent()).toBe(comment);
          const selection = inline.getByRole("button", { name: selected });
          await selection.waitFor();
          const geometry = await selection.evaluate((element) => ({
            height: element.getBoundingClientRect().height,
            lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
            overflows: element.scrollWidth > element.clientWidth,
            documentOverflows: document.documentElement.scrollWidth > window.innerWidth,
          }));
          expect(geometry.height).toBeLessThanOrEqual(geometry.lineHeight + 1);
          expect(geometry.overflows).toBe(true);
          expect(geometry.documentOverflows).toBe(false);
          await page.keyboard.press("Tab");
          await selection.focus();
          const fullQuote = inline.getByRole("region", {
            name: "Highlighted passage:",
            exact: true,
          });
          await fullQuote.waitFor({ state: "visible" });
          expect(await fullQuote.textContent()).toBe(selected);
          await page.keyboard.press("Escape");
          await fullQuote.waitFor({ state: "hidden" });
          await selection.click();
          await fullQuote.waitFor({ state: "visible" });
          expect(await gateway.getRequests("chat.send")).toHaveLength(1);
        },
      );
    },
  );

  it.each([1600, 390])(
    "keeps transcript and deletion stable with the keyboard at %s px",
    async (width) => {
      await suite.withPage(
        { ...pageOptions, viewport: { width, height: 900 } },
        async ({ page }) => {
          const content = `${auditMarkdownTable}\n\n${passage}`;
          const { gateway, composer, source, preview } = await openChat(page, content);
          await composer.fill("Preserve the draft.");
          const table = page.locator(".chat-group.assistant .markdown-table");
          const geometry = async () =>
            (await Promise.all([table.boundingBox(), source.boundingBox()])).map((box) => ({
              x: box!.x,
              width: box!.width,
            }));
          await Promise.all([table.waitFor(), source.waitFor()]);
          await waitForChatScrollIdle(page);
          const before = await geometry();
          for (const comment of ["First note", "Second note"]) {
            await addComment(page, source, comment);
            await expect.poll(geometry).toEqual(before);
          }
          const chip = page.locator(".chat-attachments-preview .chat-selection-annotations__chip");
          const trigger = chip.getByRole("button", { name: /^\d+ comments?$/ });
          await page.mouse.move(0, 0);
          const restingBounds = await chip.boundingBox();
          await chip.hover();
          await preview.waitFor({ state: "visible" });
          expect(await chip.boundingBox()).toEqual(restingBounds);
          const deletes = button(preview, "Delete comment");
          await deletes.first().click();
          await expect.poll(() => chip.textContent()).toContain("1 comment");
          await expect.poll(geometry).toEqual(before);
          expect(await page.locator("openclaw-toast-host [role=status]").count()).toBe(0);
          // Shrinking above the chip moves the first row away from a stationary pointer.
          await page.waitForTimeout(250);
          expect(await preview.isVisible()).toBe(true);
          await expectFocus(deletes.first());
          expect(await preview.textContent()).not.toContain("First note");
          expect(await button(preview, "Edit comment 1").count()).toBe(1);
          expect(await button(preview, "Edit comment 2").count()).toBe(0);
          await page.keyboard.press("Escape");
          await expect.poll(() => preview.isVisible()).toBe(false);
          await trigger.press("Space");
          await preview.waitFor({ state: "visible" });
          await composer.click();
          await expect.poll(() => preview.isVisible()).toBe(false);
          await trigger.focus();
          await page.keyboard.press("Tab");
          const clear = button(page, "Remove all comments");
          expect(await focused(clear)).toBe(true);
          await page.keyboard.press("Shift+Tab");
          expect(await focused(trigger)).toBe(true);
          await page.keyboard.press("Tab");
          await page.keyboard.press("Enter");
          await chip.waitFor({ state: "detached" });
          await expect.poll(geometry).toEqual(before);
          await expectFocus(composer);
          expect(await composer.inputValue()).toBe("Preserve the draft.");
          expect(await page.locator("openclaw-toast-host [role=status]").count()).toBe(0);
          await sendWithoutComments(page, gateway);
        },
      );
    },
  );

  it("opens an offscreen comment from the composer without dismissing its own editor", async () => {
    await suite.withPage(
      { viewport: pageOptions.viewport, reducedMotion: "reduce" },
      async ({ page }) => {
        const filler = Array.from(
          { length: 35 },
          (_, i) => `Deployment context paragraph ${i + 1}.`,
        ).join("\n\n");
        const ui = await openChat(page, `${passage}\n\n${filler}`);
        const { source, input, chip, preview } = ui;
        await source.scrollIntoViewIfNeeded();
        await waitForChatScrollIdle(page);
        await addComment(page, source, "Keep the source context.");
        const thread = page.locator(".chat-thread");
        await thread.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await waitForChatScrollIdle(page);
        const sourceBox = await source.boundingBox();
        const threadBox = await thread.boundingBox();
        expect(sourceBox!.y + sourceBox!.height).toBeLessThan(threadBox!.y);
        const trigger = chip.getByRole("button", { name: "1 comment", exact: true });
        await chip.hover();
        await button(preview, "Edit comment 1").click();
        await waitForChatScrollIdle(page);
        await input.fill("Edited from the composer.");
        await button(ui.editor, "Save").click();
        await expectFocus(trigger);
        await chip.hover();
        await preview
          .getByText("Edited from the composer.", { exact: true })
          .waitFor({ state: "visible" });
        await button(preview, "Edit comment 1").click();
        await input.fill("Discard this edit.");
        await input.press("Escape");
        await expectFocus(trigger);
      },
    );
  });
});
