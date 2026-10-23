import { writeFile } from "node:fs/promises";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { catalog, pluginModule } from "./native-plugin-ui.test-support.ts";

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

async function editComment(ui: Awaited<ReturnType<typeof openChat>>, comment: string) {
  const { chip, preview, input, editor } = ui;
  await chip.hover();
  await button(preview, "Edit comment 1").click();
  await input.fill(comment);
  await button(editor, "Save").click();
  await chip.hover();
  await preview.getByText(comment, { exact: true }).waitFor({ state: "visible" });
}

async function sendWithoutComments(
  page: Page,
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
) {
  await button(page, "Send message").click();
  const request = await gateway.waitForRequest("chat.send");
  expect((request.params as { attachments?: unknown[] }).attachments ?? []).toHaveLength(0);
}

async function openChat(page: Page, pluginBody?: string, content = passage) {
  const gateway = await installMockGateway(page, {
    historyMessages: [{ role: "assistant", content }],
    ...(pluginBody
      ? {
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "plugins.controlUi.list",
            "plugins.controlUi.report",
          ],
          methodResponses: {
            "plugins.controlUi.list": catalog("one"),
            "plugins.controlUi.report": { ok: true },
          },
        }
      : {}),
  });
  if (pluginBody) {
    await page.route("**/__openclaw__/plugins/control-ui/ui-fixture/*/index.js", (route) =>
      route.fulfill({ status: 200, contentType: "text/javascript", body: pluginBody }),
    );
  }
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

function replacementPlugin(surface: string, replacement: string) {
  return pluginModule("one").replace(
    "container.append(output); update(context);",
    `const replace = document.createElement("button"); replace.textContent = "Replace ${surface}"; replace.onclick = () => host.ui.selectReplacement(${JSON.stringify(surface)}, ${JSON.stringify(replacement)}); container.append(output, replace); update(context);`,
  );
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
  it.each([
    { width: 1440, height: 900, theme: "dark" },
    { width: 390, height: 844, theme: "light" },
  ] as const)(
    "keeps an annotation-only quote on one line at $width px",
    async ({ width, height, theme }) => {
      await suite.withPage(
        { ...pageOptions, viewport: { width, height }, colorScheme: theme },
        async ({ page }) => {
          const selected = `${passage} The selected deployment and rollback instructions must remain available in full.\nKeep the complete second line and the long identifier deployment_configuration_review_012345678901234567890123456789.`;
          const comment =
            "Keep all of the selected context.\nExplain the rollback steps before changing the deployment.";
          const { source, gateway } = await openChat(page, undefined, selected);
          await addComment(page, source, comment);
          await button(page, "Send message").click();
          const request = await gateway.waitForRequest("chat.send");
          // SAFETY: the real send path supplies the chat.send request captured by the fixture.
          const params = request.params as {
            idempotencyKey: string;
            sessionKey: string;
            message: string;
            attachments: Array<{ content: string }>;
          };
          expect(params.message).toBe("");
          expect(params.attachments).toHaveLength(1);
          const payload = Buffer.from(params.attachments[0]!.content, "base64").toString("utf8");
          expect(payload).toContain(`Selected text:\n${selected}\n\nUser comment:\n${comment}`);
          expect(payload).toContain("Source session:");
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
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            const frame = await takeControlUiScreenshotFrame(page, inline, [authored], {
              elements: [inline],
              scrollTo: inline,
              animations: "disabled",
            });
            await writeFile(`${suite.artifactDir}/annotation-${width}-${theme}.png`, frame.png);
          }
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

  it.each(["delegated-composer", "failing-composer"])(
    "shows one usable comment chip when %s restores the built-in composer",
    async (replacement) => {
      await suite.withPage(pageOptions, async ({ page }) => {
        const ui = await openChat(page, replacementPlugin("composer", replacement));
        const { gateway, composer, source, chip, preview } = ui;
        await composer.fill("Keep this draft through the composer change.");
        for (const comment of ["Check the rollback steps.", "Remove this extra comment."]) {
          await addComment(page, source, comment);
        }
        await button(page, "Replace composer").click();
        await page
          .locator("openclaw-plugin-view[data-plugin-composer] .agent-chat__composer-shell")
          .waitFor({ state: "visible" });
        if (replacement === "failing-composer") {
          await page.getByRole("alert").filter({ hasText: "Fixture composer failed" }).waitFor();
        }
        await page.mouse.move(0, 0);
        await page.screenshot({ path: `${suite.artifactDir}/${replacement}.png` });
        expect(await chip.count()).toBe(1);
        expect(await chip.textContent()).toContain("2 comments");
        expect(await composer.inputValue()).toBe("Keep this draft through the composer change.");
        await editComment(ui, "Edited after the composer changed.");
        await button(preview, "Delete comment").last().click();
        await expect.poll(() => chip.textContent()).toContain("1 comment");
        expect(await chip.count()).toBe(1);
        expect(await preview.isVisible()).toBe(true);
        await expectFocus(button(preview, "Delete comment"));
        await button(page, "Send message").click();
        const request = await gateway.waitForRequest("chat.send");
        const params = request.params as {
          message: string;
          attachments: Array<{ content: string }>;
        };
        expect(params.message).toBe("Keep this draft through the composer change.");
        expect(params.attachments).toHaveLength(1);
        const attachment = Buffer.from(params.attachments[0]!.content, "base64").toString("utf8");
        expect(attachment).toContain("Edited after the composer changed.");
        expect(attachment).not.toContain("Remove this extra comment.");
        await expect
          .poll(() =>
            page
              .locator(
                "openclaw-plugin-view[data-plugin-composer] .chat-selection-annotations__chip",
              )
              .count(),
          )
          .toBe(0);
        await expect
          .poll(() => page.locator(".chat-thread .chat-selection-annotations__chip").count())
          .toBe(1);
      });
    },
  );

  it("keeps deletion in place, dismisses on hover exit, and clears all with the keyboard", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const { gateway, composer, source, preview } = await openChat(page);
      await composer.fill("Preserve the draft.");
      for (const comment of ["First note", "Second note"]) {
        await addComment(page, source, comment);
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
      await expectFocus(trigger);
      await page.waitForTimeout(250);
      expect(await preview.isVisible()).toBe(false);
      await trigger.press("Enter");
      await preview.waitFor({ state: "visible" });
      await deletes.first().hover();
      await page.mouse.move(0, 0);
      await expect.poll(() => preview.isVisible()).toBe(false);
      await trigger.focus();
      await trigger.press("Enter");
      await preview.waitFor({ state: "visible" });
      await page.mouse.move(1, 1);
      await page.waitForTimeout(250);
      expect(await preview.isVisible()).toBe(true);
      await trigger.press("Escape");
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
      await expectFocus(composer);
      expect(await composer.inputValue()).toBe("Preserve the draft.");
      expect(await page.locator("openclaw-toast-host [role=status]").count()).toBe(0);
      await page.screenshot({ path: `${suite.artifactDir}/comments-cleared.png` });
      await sendWithoutComments(page, gateway);
    });
  });

  it("keeps comment actions alive when a plugin replaces the transcript", async () => {
    await suite.withPage(
      { viewport: pageOptions.viewport, reducedMotion: "reduce" },
      async ({ page }) => {
        const ui = await openChat(
          page,
          replacementPlugin("transcript", "comment-transcript").replace(
            "const registerComposer =",
            `host.ui.registerReplacement({id: "comment-transcript", label: "Comment transcript", surface: "transcript", mount(container) { container.textContent = "Replacement transcript"; }}); const registerComposer =`,
          ),
        );
        const { gateway, composer, source, chip, preview } = ui;
        await composer.fill("Keep this draft.");
        await addComment(page, source, "Check the rollback steps.");
        await button(page, "Replace transcript").click();
        await page
          .getByText("Replacement transcript", { exact: true })
          .waitFor({ state: "visible" });
        expect(await page.locator(".chat-thread").count()).toBe(0);
        await editComment(ui, "Edited with a replacement transcript.");
        await button(preview, "Delete comment").click();
        await chip.waitFor({ state: "detached" });
        await expectFocus(composer);
        expect(await composer.inputValue()).toBe("Keep this draft.");
        await sendWithoutComments(page, gateway);
      },
    );
  });

  it("opens an offscreen comment from the composer without dismissing its own editor", async () => {
    await suite.withPage(
      { viewport: pageOptions.viewport, reducedMotion: "reduce" },
      async ({ page }) => {
        const filler = Array.from(
          { length: 35 },
          (_, i) => `Deployment context paragraph ${i + 1}.`,
        ).join("\n\n");
        const ui = await openChat(page, undefined, `${passage}\n\n${filler}`);
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
