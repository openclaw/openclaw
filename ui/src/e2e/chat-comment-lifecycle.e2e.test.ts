import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { catalog, pluginModule } from "./native-plugin-ui.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI comment lifecycle" });
const passage = "Review the deployment checklist.";

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
  await page
    .getByRole("toolbar", { name: "Selection actions" })
    .getByRole("button", { name: "Add to chat", exact: true })
    .click();
  const editor = page.getByRole("dialog", { name: "Comment", exact: true });
  await editor.getByRole("textbox").fill(comment);
  await editor.getByRole("textbox").press("Enter");
}

suite.define(() => {
  it.each(["delegated-composer", "failing-composer"])(
    "shows one usable comment chip when %s restores the built-in composer",
    async (replacement) => {
      await suite.withPage(
        { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", locale: "en-US" },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            historyMessages: [{ role: "assistant", content: passage }],
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
                "container.append(output); update(context);",
                `const replace = document.createElement("button"); replace.textContent = "Replace composer"; replace.onclick = () => host.ui.selectReplacement("composer", ${JSON.stringify(replacement)}); container.append(output, replace); update(context);`,
              ),
            }),
          );
          await page.goto(`${suite.server.baseUrl}chat`);
          const composer = page.locator(".agent-chat__composer-shell textarea");
          await composer.fill("Keep this draft through the composer change.");
          const source = page.locator(".chat-bubble .chat-text p").filter({ hasText: passage });
          const editor = page.getByRole("dialog", { name: "Comment", exact: true });
          for (const comment of ["Check the rollback steps.", "Remove this extra comment."]) {
            await addComment(page, source, comment);
          }
          await page.getByRole("button", { name: "Replace composer", exact: true }).click();
          await page
            .locator("openclaw-plugin-view[data-plugin-composer] .agent-chat__composer-shell")
            .waitFor({ state: "visible" });
          if (replacement === "failing-composer") {
            await page.getByRole("alert").filter({ hasText: "Fixture composer failed" }).waitFor();
          }
          await page.mouse.move(0, 0);
          await page.screenshot({ path: `${suite.artifactDir}/${replacement}.png` });
          const chip = page.locator(".chat-selection-annotations__chip");
          expect(await chip.count()).toBe(1);
          expect(await chip.textContent()).toContain("2 comments");
          expect(await composer.inputValue()).toBe("Keep this draft through the composer change.");
          await chip.hover();
          const preview = page.getByRole("region", { name: "Comments", exact: true });
          await preview.getByRole("button", { name: "Edit comment 1", exact: true }).click();
          await editor.getByRole("textbox").fill("Edited after the composer changed.");
          await editor.getByRole("button", { name: "Save", exact: true }).click();
          await chip.hover();
          await preview
            .getByText("Edited after the composer changed.", { exact: true })
            .waitFor({ state: "visible" });
          await preview.getByRole("button", { name: "Delete comment", exact: true }).last().click();
          await expect.poll(() => chip.textContent()).toContain("1 comment");
          expect(await chip.count()).toBe(1);
          expect(await preview.isVisible()).toBe(true);
          await expect
            .poll(() =>
              preview
                .getByRole("button", { name: "Delete comment", exact: true })
                .evaluate((element) => element === document.activeElement),
            )
            .toBe(true);
          await page.getByRole("button", { name: "Send message", exact: true }).click();
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
        },
      );
    },
  );

  it("keeps deletion in place, dismisses on hover exit, and clears all with the keyboard", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", locale: "en-US" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          historyMessages: [{ role: "assistant", content: passage }],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const composer = page.locator(".agent-chat__composer-shell textarea");
        await composer.fill("Preserve the draft.");
        const source = page.locator(".chat-bubble .chat-text p").filter({ hasText: passage });
        for (const comment of ["First note", "Second note"]) {
          await addComment(page, source, comment);
        }
        const chip = page.locator(".chat-attachments-preview .chat-selection-annotations__chip");
        const trigger = chip.getByRole("button", { name: /^\d+ comments?$/ });
        const preview = page.getByRole("region", { name: "Comments", exact: true });
        await page.mouse.move(0, 0);
        const restingBounds = await chip.boundingBox();
        await chip.hover();
        await preview.waitFor({ state: "visible" });
        expect(await chip.boundingBox()).toEqual(restingBounds);
        const deletes = preview.getByRole("button", { name: "Delete comment", exact: true });
        await deletes.first().click();
        await expect.poll(() => chip.textContent()).toContain("1 comment");
        // Shrinking above the chip moves the first row away from a stationary pointer.
        await page.waitForTimeout(250);
        expect(await preview.isVisible()).toBe(true);
        await expect
          .poll(() => deletes.first().evaluate((element) => element === document.activeElement))
          .toBe(true);
        expect(await preview.textContent()).not.toContain("First note");
        expect(
          await preview.getByRole("button", { name: "Edit comment 1", exact: true }).count(),
        ).toBe(1);
        expect(
          await preview.getByRole("button", { name: "Edit comment 2", exact: true }).count(),
        ).toBe(0);
        await page.keyboard.press("Escape");
        await expect.poll(() => preview.isVisible()).toBe(false);
        await expect
          .poll(() => trigger.evaluate((element) => element === document.activeElement))
          .toBe(true);
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
        const clear = page.getByRole("button", { name: "Remove all comments", exact: true });
        expect(await clear.evaluate((element) => element === document.activeElement)).toBe(true);
        await page.keyboard.press("Shift+Tab");
        expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);
        await page.keyboard.press("Tab");
        await page.keyboard.press("Enter");
        await chip.waitFor({ state: "detached" });
        await expect
          .poll(() => composer.evaluate((element) => element === document.activeElement))
          .toBe(true);
        expect(await composer.inputValue()).toBe("Preserve the draft.");
        const toast = page.getByRole("status").filter({ hasText: "Comments removed" });
        await toast.waitFor({ state: "visible" });
        await page.screenshot({ path: `${suite.artifactDir}/comments-cleared.png` });
        expect(await toast.getByRole("button", { name: "Undo", exact: true }).count()).toBe(0);
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const request = await gateway.waitForRequest("chat.send");
        expect((request.params as { attachments?: unknown[] }).attachments ?? []).toHaveLength(0);
      },
    );
  });

  it("keeps comment actions alive when a plugin replaces the transcript", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          historyMessages: [{ role: "assistant", content: passage }],
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
            body: pluginModule("one")
              .replace(
                "container.append(output); update(context);",
                `const replace = document.createElement("button"); replace.textContent = "Replace transcript"; replace.onclick = () => host.ui.selectReplacement("transcript", "comment-transcript"); container.append(output, replace); update(context);`,
              )
              .replace(
                "const registerComposer =",
                `host.ui.registerReplacement({id: "comment-transcript", label: "Comment transcript", surface: "transcript", mount(container) { container.textContent = "Replacement transcript"; }}); const registerComposer =`,
              ),
          }),
        );
        await page.goto(`${suite.server.baseUrl}chat`);
        const composer = page.locator(".agent-chat__composer-shell textarea");
        await composer.fill("Keep this draft.");
        const source = page.locator(".chat-bubble .chat-text p").filter({ hasText: passage });
        await selectText(source);
        await page
          .getByRole("toolbar", { name: "Selection actions" })
          .getByRole("button", { name: "Add to chat", exact: true })
          .click();
        const editor = page.getByRole("dialog", { name: "Comment", exact: true });
        await editor.getByRole("textbox").fill("Check the rollback steps.");
        await editor.getByRole("textbox").press("Enter");
        await page.getByRole("button", { name: "Replace transcript", exact: true }).click();
        await page
          .getByText("Replacement transcript", { exact: true })
          .waitFor({ state: "visible" });
        expect(await page.locator(".chat-thread").count()).toBe(0);
        const chip = page.locator(".chat-selection-annotations__chip");
        await chip.hover();
        const preview = page.getByRole("region", { name: "Comments", exact: true });
        await preview.getByRole("button", { name: "Edit comment 1", exact: true }).click();
        await editor.getByRole("textbox").fill("Edited with a replacement transcript.");
        await editor.getByRole("button", { name: "Save", exact: true }).click();
        await chip.hover();
        await preview
          .getByText("Edited with a replacement transcript.", { exact: true })
          .waitFor({ state: "visible" });
        await preview.getByRole("button", { name: "Delete comment", exact: true }).click();
        await chip.waitFor({ state: "detached" });
        await expect
          .poll(() => composer.evaluate((element) => element === document.activeElement))
          .toBe(true);
        expect(await composer.inputValue()).toBe("Keep this draft.");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const request = await gateway.waitForRequest("chat.send");
        expect((request.params as { attachments?: unknown[] }).attachments ?? []).toHaveLength(0);
      },
    );
  });

  it("opens an offscreen comment from the composer without dismissing its own editor", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" },
      async ({ page }) => {
        const filler = Array.from(
          { length: 35 },
          (_, i) => `Deployment context paragraph ${i + 1}.`,
        ).join("\n\n");
        await installMockGateway(page, {
          historyMessages: [{ role: "assistant", content: `${passage}\n\n${filler}` }],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const source = page.locator(".chat-bubble .chat-text p").filter({ hasText: passage });
        await source.scrollIntoViewIfNeeded();
        await waitForChatScrollIdle(page);
        await selectText(source);
        await page
          .getByRole("toolbar", { name: "Selection actions" })
          .getByRole("button", { name: "Add to chat", exact: true })
          .click();
        const editor = page.getByRole("dialog", { name: "Comment", exact: true });
        await editor.getByRole("textbox").fill("Keep the source context.");
        await editor.getByRole("textbox").press("Enter");
        const thread = page.locator(".chat-thread");
        await thread.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await waitForChatScrollIdle(page);
        const sourceBox = await source.boundingBox();
        const threadBox = await thread.boundingBox();
        expect(sourceBox!.y + sourceBox!.height).toBeLessThan(threadBox!.y);
        const chip = page.locator(".chat-selection-annotations__chip");
        const trigger = chip.getByRole("button", { name: "1 comment", exact: true });
        await chip.hover();
        const preview = page.getByRole("region", { name: "Comments", exact: true });
        await preview.getByRole("button", { name: "Edit comment 1", exact: true }).click();
        await waitForChatScrollIdle(page);
        await editor.getByRole("textbox").fill("Edited from the composer.");
        await editor.getByRole("button", { name: "Save", exact: true }).click();
        await expect
          .poll(() => trigger.evaluate((element) => element === document.activeElement))
          .toBe(true);
        await chip.hover();
        await preview
          .getByText("Edited from the composer.", { exact: true })
          .waitFor({ state: "visible" });
        await preview.getByRole("button", { name: "Edit comment 1", exact: true }).click();
        await editor.getByRole("textbox").fill("Discard this edit.");
        await editor.getByRole("textbox").press("Escape");
        await expect
          .poll(() => trigger.evaluate((element) => element === document.activeElement))
          .toBe(true);
      },
    );
  });
});
