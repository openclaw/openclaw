import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import { CHAT_TRANSCRIPT_END_THRESHOLD_PX } from "../pages/chat/scroll.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  chatMessage,
  chatThreadDistanceFromBottom,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Mobile latest clearance" });
const sessionKey = "agent:main:main";

async function capture(page: Page, name: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  await page.screenshot({
    path: path.join(suite.artifactDir, `${name}.png`),
    animations: "disabled",
  });
  const frame = page.locator(".chat-main__conversation-frame");
  const bounds = (await frame.boundingBox())!;
  await page.screenshot({
    path: path.join(suite.artifactDir, `${name}-crop.png`),
    clip: {
      x: bounds.x,
      y: Math.max(bounds.y, bounds.y + bounds.height - 230),
      width: bounds.width,
      height: Math.min(bounds.height, 230),
    },
    animations: "disabled",
  });
}

suite.define(() => {
  it.each([360, 430])(
    "keeps latest reachable as mobile activity appears and disappears at %i px",
    async (width) => {
      await suite.withPage(
        {
          ...createControlUiE2eContextOptions(),
          viewport: { width, height: 844 },
          isMobile: true,
          hasTouch: true,
        },
        async ({ page }) => {
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          const gateway = await installMockGateway(page, {
            sessionKey,
            featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
            historyMessages: Array.from({ length: 30 }, (_, index) =>
              chatMessage(
                index % 2 ? "user" : "assistant",
                `Workspace review ${index}.\n\nReviewing the implementation and recording the result.`,
                { timestamp: index + 1 },
              ),
            ),
            methodResponses: { "progressCard.get": { card: null } },
          });
          await page.goto(suite.server.baseUrl + "chat");
          await page.getByText("Workspace review 29.", { exact: false }).waitFor();
          const thread = page.locator(".chat-thread");
          const latest = page.locator('.chat-scroll-to-bottom[data-visible="true"]');
          await thread.press("Home");
          await latest.waitFor();
          await waitForChatScrollIdle(page);
          await waitForLayoutSettled(page, ".chat-scroll-to-bottom, .agent-chat__composer-float");
          const resting = (await latest.boundingBox())!;
          await capture(page, `${width}-no-pills`);
          await gateway.setMethodResponse("progressCard.get", {
            card: {
              sessionKey,
              revision: 1,
              updatedAt: 1,
              markdown: "Reviewing the workspace.",
              steps: [],
            },
          });
          await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 1 });
          const pill = page.locator('.chat-activity-pills [data-family="progress"]');
          await pill.waitFor();
          await waitForLayoutSettled(page, ".chat-scroll-to-bottom, .agent-chat__composer-float");
          const leftOnly = (await pill.boundingBox())!;
          expect(leftOnly.x + leftOnly.width).toBeLessThan(resting.x);
          expect(
            (await latest.boundingBox())!.y,
            "left-only activity leaves latest in place",
          ).toBeCloseTo(resting.y, 0);
          await capture(page, `${width}-left-only`);
          await gateway.setMethodResponse("progressCard.get", {
            card: {
              sessionKey,
              revision: 2,
              updatedAt: 1,
              markdown: "Reviewing the workspace.",
              steps: [
                { step: "Inspect the project", status: "completed" },
                { step: "Verify the changes", status: "in_progress" },
                { step: "Record the result", status: "pending" },
              ],
            },
          });
          await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 2 });
          await pill.getByText("1/3", { exact: true }).waitFor();
          await waitForLayoutSettled(page, ".chat-scroll-to-bottom, .agent-chat__composer-float");
          await capture(page, `${width}-pills`);
          const button = (await latest.boundingBox())!;
          const activity = (await pill.boundingBox())!;
          console.log("LATEST_GEOMETRY", JSON.stringify({ width, resting, button, activity }));
          await latest.tap();
          await expect
            .poll(() => chatThreadDistanceFromBottom(page))
            .toBeLessThanOrEqual(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
          await thread.press("Home");
          await latest.waitFor();
          if (width === 430) {
            const editor = page.locator(".agent-chat__composer-combobox textarea");
            await editor.fill("Review this part of the draft.\n".repeat(8));
            await page.setViewportSize({ width, height: 560 });
            await page
              .locator('.agent-chat__composer-shell[data-composer-editing="true"]')
              .waitFor();
            await waitForLayoutSettled(
              page,
              ".chat-scroll-to-bottom, .agent-chat__composer-float, .agent-chat__input",
            );
            const editingButton = (await latest.boundingBox())!;
            const editingPill = (await pill.boundingBox())!;
            expect(editingButton.y).toBeGreaterThanOrEqual(0);
            expect(editingButton.y + editingButton.height).toBeLessThanOrEqual(editingPill.y - 4);
            await capture(page, `${width}-editing-short-viewport`);
            await latest.tap();
            await expect
              .poll(() => chatThreadDistanceFromBottom(page))
              .toBeLessThanOrEqual(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
            await capture(page, `${width}-editing-jump-complete`);
            await editor.fill("");
            await page.setViewportSize({ width, height: 844 });
            await thread.press("Home");
            await latest.waitFor();
          }
          await gateway.setMethodResponse("progressCard.get", { card: null });
          await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 3 });
          await pill.waitFor({ state: "hidden" });
          await waitForLayoutSettled(page, ".chat-scroll-to-bottom, .agent-chat__composer-float");
          expect((await latest.boundingBox())!.y).toBeCloseTo(resting.y, 0);
          await latest.tap();
          await expect
            .poll(() => chatThreadDistanceFromBottom(page))
            .toBeLessThanOrEqual(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
          expect(errors).toEqual([]);
          expect(
            button.y + button.height,
            "latest button clears the actual activity pill",
          ).toBeLessThanOrEqual(activity.y - 4);
        },
      );
    },
  );
});
