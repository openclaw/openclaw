import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { requireRecord, requireString } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI session composer size" });

suite.define(() => {
  it.each([360, 375])(
    "keeps active-run text clear of actions in a %ipx-wide shortened phone viewport",
    async (width) => {
      await suite.withPage(
        { viewport: { width, height: 240 }, isMobile: true, hasTouch: true },
        async ({ page }) => {
          const gateway = await installMockGateway(page);
          await page.goto(`${suite.server.baseUrl}chat`);
          const editor = page.locator(".agent-chat__composer-combobox textarea");
          await editor.fill("Keep working while I draft a follow-up.");
          await page.getByRole("button", { name: "Send message", exact: true }).click();
          const send = requireRecord((await gateway.waitForRequest("chat.send")).params);
          await gateway.emitGatewayEvent("chat", {
            runId: requireString(send.idempotencyKey, "active run"),
            sessionKey: requireString(send.sessionKey, "active session"),
            state: "delta",
            message: { role: "assistant", content: [{ type: "text", text: "Still working." }] },
          });
          await page.locator(".chat-bubble.streaming").waitFor();
          await expect.poll(() => editor.inputValue()).toBe("");

          const measure = async (label: string) => {
            await waitForLayoutSettled(page, ".agent-chat__input");
            const geometry = await page
              .getByRole("button", { name: label, exact: true })
              .evaluate((button) => {
                const textarea = button.closest(".agent-chat__input")!.querySelector("textarea")!;
                const text = textarea.getBoundingClientRect();
                const action = button.getBoundingClientRect();
                return {
                  overlap:
                    Math.max(
                      0,
                      Math.min(text.right, action.right) - Math.max(text.left, action.left),
                    ) *
                    Math.max(
                      0,
                      Math.min(text.bottom, action.bottom) - Math.max(text.top, action.top),
                    ),
                  text: { top: text.top, bottom: text.bottom, left: text.left, right: text.right },
                  action: {
                    top: action.top,
                    bottom: action.bottom,
                    left: action.left,
                    right: action.right,
                  },
                  hit: button.contains(
                    document.elementFromPoint(
                      action.x + action.width / 2,
                      action.y + action.height / 2,
                    ),
                  ),
                  scrollHeight: textarea.scrollHeight,
                  clientHeight: textarea.clientHeight,
                  scrollWidth: textarea.scrollWidth,
                  clientWidth: textarea.clientWidth,
                  scrollTop: textarea.scrollTop,
                };
              });
            expect.soft(geometry.overlap).toBe(0);
            expect.soft(geometry.hit).toBe(true);
            for (const box of [geometry.text, geometry.action]) {
              expect.soft(box.top).toBeGreaterThanOrEqual(0);
              expect.soft(box.bottom).toBeLessThanOrEqual(240);
              expect.soft(box.left).toBeGreaterThanOrEqual(0);
              expect.soft(box.right).toBeLessThanOrEqual(width);
            }
            return geometry;
          };
          await editor.focus();
          await measure("Stop");
          // An outside pointer action selects the one-line, side-by-side layout.
          await page.mouse.click(100, 80);
          await expect
            .poll(() =>
              editor.evaluate((element) =>
                element
                  .closest(".agent-chat__composer-shell")
                  ?.getAttribute("data-composer-resting"),
              ),
            )
            .toBe("true");
          const resting = await measure("Stop");
          expect(resting.text.right).toBeLessThanOrEqual(resting.action.left);

          const draft =
            "A long follow-up should wrap before the action button, without hiding text. ".repeat(
              32,
            );
          await editor.fill(draft);
          await editor.press("Control+Home");
          const top = await measure("Send message");
          expect(top.scrollHeight).toBeGreaterThan(top.clientHeight);
          expect(top.scrollWidth).toBe(top.clientWidth);
          await editor.press("Control+End");
          const bottom = await measure("Send message");
          expect(bottom.scrollTop).toBeGreaterThan(top.scrollTop);
          expect(await editor.inputValue()).toBe(draft);
        },
      );
    },
  );

  it("only collapses an empty, unfocused composer at phone widths", async () => {
    await suite.withPage(
      { viewport: { width: 900, height: 1000 }, colorScheme: "light" },
      async ({ page }) => {
        await installMockGateway(page, {
          assistantName: "OpenClaw",
          historyMessages: [
            { role: "user", content: "Can you review the layout?", timestamp: 1000 },
            {
              role: "assistant",
              content: "The conversation is ready. What would you like to change?",
              timestamp: 2000,
            },
          ],
        });
        await page.goto(suite.server.baseUrl + "chat");
        const reply = page.getByText("The conversation is ready. What would you like to change?", {
          exact: true,
        });
        await reply.waitFor();
        await reply.click();
        const composer = page.locator(".chat-footer .agent-chat__input");
        const editor = composer.locator("textarea");
        const originalEditor = await editor.elementHandle();
        const model = composer.locator(".chat-composer-model-control");
        const height = () => composer.evaluate((element) => element.getBoundingClientRect().height);
        const capture = async (name: string) => {
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
            return;
          }
          const frame = await takeControlUiScreenshotFrame(page, composer, [editor, reply], {
            animations: "disabled",
          });
          await writeFile(path.join(suite.artifactDir, name + ".png"), frame.png);
        };
        await capture("wide-resting");
        for (const width of [900, 820, 768, 641]) {
          await page.setViewportSize({ width, height: 1000 });
          await expect.poll(() => model.isVisible()).toBe(true);
          await expect.poll(height).toBeGreaterThanOrEqual(88);
        }
        for (const viewport of [
          { width: 640, height: 1000 },
          { width: 390, height: 844 },
          { width: 844, height: 390 },
        ]) {
          await page.setViewportSize(viewport);
          await expect.poll(() => model.isVisible()).toBe(false);
          await expect.poll(height).toBe(52);
        }
        await page.setViewportSize({ width: 390, height: 844 });
        await capture("phone-resting");
        await editor.click();
        await expect.poll(() => model.isVisible()).toBe(true);
        await expect.poll(height).toBeGreaterThan(52);
        await capture("phone-focused");
        await editor.fill("Keep this draft when I leave the composer.");
        await reply.click();
        await expect.poll(() => model.isVisible()).toBe(true);
        await page.setViewportSize({ width: 900, height: 1000 });
        expect(await editor.inputValue()).toBe("Keep this draft when I leave the composer.");
        expect(await editor.evaluate((node, original) => node === original, originalEditor)).toBe(
          true,
        );
        await editor.fill("");
        await reply.click();
        await expect.poll(() => model.isVisible()).toBe(true);
        await page.setViewportSize({ width: 390, height: 844 });
        await expect.poll(() => model.isVisible()).toBe(false);
        // Keyboard/programmatic focus expands the same editor, not just a pointer gesture.
        await editor.focus();
        await expect.poll(() => model.isVisible()).toBe(true);
      },
    );
  });

  it("keeps existing sessions compact without shrinking new-chat or multiline drafts", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, {
        historyMessages: [
          { role: "assistant", content: "Ready for a follow-up.", timestamp: 1000 },
        ],
      });
      await page.goto(`${suite.server.baseUrl}new`);
      const newComposer = page.locator(".new-session-page__composer > .agent-chat__input");
      await expect
        .poll(() => newComposer.evaluate((element) => element.getBoundingClientRect().height))
        .toBe(112);

      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("Ready for a follow-up.", { exact: true }).waitFor();
      const composer = page.locator(".chat-footer .agent-chat__input");
      const editor = composer.locator("textarea");
      const height = () => composer.evaluate((element) => element.getBoundingClientRect().height);
      // The content keeps its own editor and control spacing above the 88px floor.
      await expect.poll(height).toBeLessThanOrEqual(96);
      const compactHeight = await height();
      expect(compactHeight).toBeGreaterThanOrEqual(88);
      await editor.fill("A short follow-up");
      await expect.poll(height).toBe(compactHeight);
      await editor.fill(
        "A longer follow-up\nwith several lines\nthat needs more space\nwithout clipping.",
      );
      await expect.poll(height).toBeGreaterThan(compactHeight);
      expect(await editor.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(
        true,
      );
      await editor.fill("");
      await expect.poll(height).toBe(compactHeight);

      await page.setViewportSize({ width: 390, height: 844 });
      await editor.fill("A mobile follow-up");
      const send = composer.getByRole("button", { name: "Send message", exact: true });
      await send.waitFor({ state: "visible" });
      // A responsive layout can move the whole composer between protocol calls.
      const [composerBox, sendBox] = await send.evaluate((button) =>
        [button.closest(".agent-chat__input"), button].map((element) => {
          if (!element || element.getClientRects().length === 0) {
            return null;
          }
          const { x, y, width, height: boxHeight } = element.getBoundingClientRect();
          return { x, y, width, height: boxHeight };
        }),
      );
      expect(composerBox).not.toBeNull();
      expect(sendBox).not.toBeNull();
      if (!composerBox || !sendBox) {
        throw new Error("Expected visible composer and send control");
      }
      expect(sendBox.x + sendBox.width).toBeLessThanOrEqual(composerBox.x + composerBox.width);
      expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(composerBox.y + composerBox.height);
      expect(await editor.evaluate((element) => getComputedStyle(element).fontSize)).toBe("14px");
    });
  });
});
