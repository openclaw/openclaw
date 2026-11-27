import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { waitForControlUiProofSurface } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import {
  createChatFlowE2eSuite,
  expectDefined,
  installMockGateway,
  chatMessage,
  waitForTranscriptScrollIdle as waitForProgressThreadIdle,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import { captureTopVisibleVirtualRow } from "./virtual-row-anchor.test-support.ts";

const suite = createChatFlowE2eSuite();
const height = (card: Locator) => card.evaluate((el) => el.getBoundingClientRect().height);
async function headerPoint(card: Locator) {
  const box = expectDefined(await card.locator("summary").boundingBox(), "progress header");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
async function wheel(page: Page, card: Locator, dy: number) {
  const point = await headerPoint(card);
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, dy);
}

suite.define(() => {
  it.each([
    { reducedMotion: "no-preference", touch: false },
    { reducedMotion: "reduce", touch: true },
  ] as const)(
    "keeps Details disclosure manual through scrolling and streaming ($reducedMotion, touch=$touch)",
    async ({ reducedMotion, touch }) => {
      await suite.withPage(
        {
          ...createControlUiE2eContextOptions(),
          reducedMotion,
          viewport: { width: 1280, height: 900 },
          isMobile: false,
          hasTouch: touch,
        },
        async ({ page }) => {
          const sessionKey = "agent:main:main";
          const runId = "details-motion-run";
          const initialCard = {
            sessionKey,
            revision: 1,
            updatedAt: Date.now(),
            markdown: "- A detailed finding to verify.\n".repeat(48),
            steps: [{ step: "Verify manual disclosure", status: "in_progress" }],
          };
          const gateway = await installMockGateway(page, {
            sessionKey,
            featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
            historyMessages: Array.from({ length: 40 }, (_, i) =>
              chatMessage(i % 2 ? "assistant" : "user", "Earlier context " + i + "."),
            ),
            inFlightRun: { runId, text: "Reviewing the workspace." },
            sessionInfo: { key: sessionKey, activeRunIds: [runId], hasActiveRun: true },
            methodResponses: { "progressCard.get": { card: initialCard } },
          });
          await page.goto(suite.server.baseUrl + "chat");
          const card = page.locator('[data-progress-card-placement="details"]');
          const panel = page.locator('.chat-details[role="dialog"]');
          const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
          await page.locator(".agent-chat__composer-combobox textarea").waitFor();
          expect(await panel.isVisible()).toBe(false);
          expect(await page.locator('[data-progress-card-placement="composer"]').count()).toBe(0);
          await openChatDetails(page);
          await expect.poll(() => card.getAttribute("open")).toBe("");
          const body = panel.locator(".chat-details-desktop-body");
          await waitForControlUiProofSurface(body, [card]);
          await waitForProgressThreadIdle(thread);
          // Transcript input cannot collapse the adjacent desktop disclosure.
          const bounds = expectDefined(await thread.boundingBox(), "transcript bounds");
          await page.mouse.move(bounds.x + bounds.width / 4, bounds.y + bounds.height / 2);
          await page.mouse.wheel(0, -640);
          await expect
            .poll(() => thread.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
            .toBeGreaterThan(200);
          await waitForProgressThreadIdle(thread);
          expect(await card.getAttribute("open")).toBe("");
          await card.locator("summary").click();
          await expect.poll(() => card.getAttribute("open")).toBeNull();
          await waitForControlUiProofSurface(card, [card.locator("summary")]);
          const closed = await height(card);
          await wheel(page, card, -48);
          await expect.poll(() => card.getAttribute("data-reveal")).toBe("closed");
          expect(await height(card)).toBe(closed);
          const point = await headerPoint(card);
          if (touch) {
            const touchSession = await page.context().newCDPSession(page);
            try {
              await touchSession.send("Input.dispatchTouchEvent", {
                type: "touchStart",
                touchPoints: [point],
              });
              await touchSession.send("Input.dispatchTouchEvent", {
                type: "touchMove",
                touchPoints: [{ x: point.x, y: point.y - 36 }],
              });
              await touchSession.send("Input.dispatchTouchEvent", {
                type: "touchEnd",
                touchPoints: [],
              });
            } finally {
              await touchSession.detach();
            }
          } else {
            await page.mouse.move(point.x, point.y);
            await page.mouse.down();
            await page.mouse.move(point.x, point.y - 36, { steps: 6 });
            await page.mouse.up();
          }
          expect(await card.getAttribute("data-reveal")).not.toBe("partial");
          // Normalize via the public summary if a native release produced a click.
          if ((await card.getAttribute("open")) !== null) {
            await card.locator("summary").click();
          }
          await waitForProgressThreadIdle(thread);
          const reader = await captureTopVisibleVirtualRow(thread);
          await gateway.emitGatewayEvent("chat", {
            sessionKey,
            runId,
            state: "delta",
            message: chatMessage("assistant", "A streaming finding arrived."),
          });
          await gateway.setMethodResponse("progressCard.get", {
            card: {
              ...initialCard,
              revision: 2,
              markdown: initialCard.markdown + "\nUpdated findings.",
            },
          });
          await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 2 });
          await expect.poll(() => card.textContent()).toContain("Updated findings.");
          await waitForProgressThreadIdle(thread);
          expect(await card.getAttribute("open")).toBeNull();
          const streamedReader = await captureTopVisibleVirtualRow(thread);
          expect(streamedReader.key).toBe(reader.key);
          expect(Math.abs(streamedReader.viewportTop - reader.viewportTop)).toBeLessThanOrEqual(2);
          await gateway.emitChatFinal({ sessionKey, runId, text: "Complete." });
          await expect.poll(() => thread.textContent()).toContain("Complete.");
          expect(await card.getAttribute("open")).toBeNull();
          for (const key of ["Enter", "Space"]) {
            await card.locator("summary").press(key);
            await expect.poll(() => card.getAttribute("open")).toBe("");
            expect(await body.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(
              0,
            );
            await card.locator(".session-progress-card__step").last().scrollIntoViewIfNeeded();
            expect(await body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
            const disclosedReader = await captureTopVisibleVirtualRow(thread);
            expect(disclosedReader.key).toBe(reader.key);
            expect(Math.abs(disclosedReader.viewportTop - reader.viewportTop)).toBeLessThanOrEqual(
              2,
            );
            await card.locator("summary").press(key);
            await expect.poll(() => card.getAttribute("open")).toBeNull();
          }
        },
      );
    },
  );
});
