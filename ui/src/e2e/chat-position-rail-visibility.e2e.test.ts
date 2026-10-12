import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiMockSameOriginGatewayScript } from "../test-helpers/control-ui-e2e.ts";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
suite.define(() => {
  it("shows the position rail only when the conversation overflows", async () => {
    await suite.withPage(
      { colorScheme: "dark", viewport: { width: 1440, height: 900 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          historyMessages: [
            {
              __openclaw: { id: "short-question", seq: 1 },
              role: "user",
              content: [
                { type: "text", text: "Can we keep short conversations distraction-free?" },
              ],
            },
            {
              __openclaw: { id: "short-answer", seq: 2 },
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "Yes. Navigation should appear only when there is more conversation to explore.",
                },
              ],
            },
          ],
        });
        await page.addInitScript(createControlUiMockSameOriginGatewayScript());
        await page.goto(suite.server.baseUrl + "chat");
        const thread = page.locator(".chat-thread");
        const answer = page.getByText(
          "Yes. Navigation should appear only when there is more conversation to explore.",
          { exact: true },
        );
        await answer.waitFor();
        await waitForChatScrollIdle(page);
        expect(
          await thread.evaluate((element) => element.scrollHeight - element.clientHeight),
        ).toBe(0);
        const frame = await takeControlUiScreenshotFrame(page, thread, [answer], {
          animations: "disabled",
        });
        await writeFile(path.join(suite.artifactDir, "short-conversation.png"), frame.png);
        const marks = page.locator(".chat-position-rail__marks");
        expect(await marks.isVisible()).toBe(false);
        const marker = marks.locator("button").first();
        await marker.evaluate((element) => (element as HTMLElement).focus());
        expect(await marker.evaluate((element) => element === document.activeElement)).toBe(false);
        const rail = page.locator(".chat-position-rail");
        await rail.evaluate((element) => {
          element.addEventListener(
            "transitionrun",
            () => {
              const fade = element
                .getAnimations()
                .find(
                  (animation) =>
                    animation instanceof CSSTransition &&
                    animation.transitionProperty === "opacity",
                );
              if (fade) {
                const currentTime = fade.currentTime;
                fade.currentTime = 120;
                element.setAttribute("data-proof-fade-midpoint", getComputedStyle(element).opacity);
                fade.currentTime = currentTime;
              }
            },
            { once: true },
          );
        });
        const column = thread.locator(".chat-thread-inner");
        const columnLeft = await column.evaluate((element) => element.getBoundingClientRect().left);
        await page
          .locator(".agent-chat__composer-combobox textarea")
          .fill("Walk me through the details.");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const request = await gateway.waitForRequest("chat.send");
        const runId = (request.params as { idempotencyKey: string }).idempotencyKey;
        await gateway.emitGatewayEvent("chat", {
          runId,
          sessionKey: "agent:main:main",
          state: "delta",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: Array.from(
                  { length: 12 },
                  (_, index) =>
                    "### Checkpoint " +
                    (index + 1) +
                    "\nKeep the conversation easy to read while preserving useful navigation for longer discussions.",
                ).join("\n\n"),
              },
            ],
          },
        });
        await expect
          .poll(() => thread.evaluate((element) => element.scrollHeight - element.clientHeight))
          .toBeGreaterThan(0);
        await marks.waitFor({ state: "visible" });
        await expect
          .poll(() => rail.evaluate((element) => getComputedStyle(element).opacity))
          .toBe("1");
        expect(await rail.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe(
          "0.24s",
        );
        const midpoint = Number(await rail.getAttribute("data-proof-fade-midpoint"));
        expect(midpoint).toBeGreaterThan(0);
        expect(midpoint).toBeLessThan(1);
        expect(await column.evaluate((element) => element.getBoundingClientRect().left)).toBe(
          columnLeft,
        );
        const overflowFrame = await takeControlUiScreenshotFrame(page, thread, [marks], {
          animations: "disabled",
        });
        await writeFile(
          path.join(suite.artifactDir, "overflowing-conversation.png"),
          overflowFrame.png,
        );
        await marker.focus();
        await page.setViewportSize({ width: 1440, height: 3000 });
        await expect.poll(() => marks.isVisible()).toBe(false);
        expect(await thread.evaluate((element) => element === document.activeElement)).toBe(true);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.setViewportSize({ width: 1440, height: 900 });
        await marks.waitFor({ state: "visible" });
        expect(await rail.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe(
          "0s",
        );
        await page.setViewportSize({ width: 900, height: 900 });
        await expect.poll(() => marks.isVisible()).toBe(false);
      },
    );
  });
});
