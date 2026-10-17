import type { BrowserContextOptions, Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { openChatDetails } from "./chat-details.test-support.ts";
import {
  chatMessage,
  createChatFlowE2eSuite,
  expectDefined,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import { openProgressHomeDock } from "./session-progress-home.test-support.ts";

const suite = createChatFlowE2eSuite();
const sessionKey = "agent:main:main";
const viewportFor = (mobile: boolean) =>
  mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 };
const contextOptions = (
  reducedMotion: BrowserContextOptions["reducedMotion"],
  mobile: boolean,
) => ({
  ...createControlUiE2eContextOptions(),
  reducedMotion,
  viewport: viewportFor(mobile),
  isMobile: mobile,
  hasTouch: mobile,
});
const height = (card: Locator) => card.evaluate((el) => el.getBoundingClientRect().height);
const scrollTop = (thread: Locator) => thread.evaluate((el) => el.scrollTop);
const expectOpen = (card: Locator, open: boolean) =>
  expect.poll(() => card.getAttribute("open")).toBe(open ? "" : null);
const expectHeight = (card: Locator, expected: number) =>
  expect.poll(() => height(card)).toBeCloseTo(expected, 0);
async function gesture(page: Page, mobile: boolean) {
  const touch = mobile ? await page.context().newCDPSession(page) : undefined;
  const send = (
    type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
    point?: { x: number; y: number },
  ) => touch!.send("Input.dispatchTouchEvent", { type, touchPoints: point ? [point] : [] });
  return {
    async start(point: { x: number; y: number }) {
      if (touch) {
        await send("touchStart", point);
      } else {
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
      }
    },
    async move(point: { x: number; y: number }, steps = 1) {
      if (touch) {
        await send("touchMove", point);
      } else {
        await page.mouse.move(point.x, point.y, { steps });
      }
    },
    async end(cancel = false) {
      if (touch) {
        await send(cancel ? "touchCancel" : "touchEnd");
      } else {
        await page.mouse.up();
      }
    },
    close: async () => {
      await touch?.detach();
    },
  };
}
async function headerPoint(card: Locator) {
  const box = expectDefined(await card.locator("summary").boundingBox(), "progress header");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
async function wheel(page: Page, card: Locator, dy: number) {
  const point = await headerPoint(card);
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, dy);
}
async function waitForProgressThreadIdle(thread: Locator) {
  await expect
    .poll(() =>
      thread.evaluate(async (element) => {
        const before = [element.scrollTop, element.scrollHeight, element.clientHeight];
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        const after = [element.scrollTop, element.scrollHeight, element.clientHeight];
        return before.every((value, index) => value === after[index]);
      }),
    )
    .toBe(true);
}

async function still(card: Locator, expected: number) {
  // A real pause, longer than the retired 240ms animation, must not finish the reveal.
  for (let i = 0; i < 6; i++) {
    await card.page().waitForTimeout(100);
    expect(Math.abs((await height(card)) - expected)).toBeLessThanOrEqual(1);
  }
}

suite.define(() => {
  it.each([
    { reducedMotion: "no-preference", mobile: false },
    { reducedMotion: "reduce", mobile: false },
    { reducedMotion: "reduce", mobile: true },
  ] as const)(
    "keeps Details disclosure manual through scrolling and streaming ($reducedMotion, touch=$mobile)",
    async ({ reducedMotion, mobile }) => {
      await suite.withPage(contextOptions(reducedMotion, mobile), async ({ page }) => {
        const runId = "details-motion-run";
        const initialCard = {
          sessionKey,
          revision: 1,
          updatedAt: Date.now(),
          markdown: "- A detailed finding to verify.\n".repeat(24),
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
        await card.waitFor({ state: "attached" });
        expect(await panel.isVisible()).toBe(false);
        expect(await page.locator('[data-progress-card-placement="composer"]').count()).toBe(0);
        if (!mobile) {
          await openChatDetails(page);
          await expectOpen(card, true);
        }
        await waitForProgressThreadIdle(thread);
        // Mobile Details covers the transcript; scroll it before opening the overlay.
        // On desktop, transcript input cannot collapse the adjacent disclosure.
        const bounds = expectDefined(await thread.boundingBox(), "transcript bounds");
        await page.mouse.move(bounds.x + 8, bounds.y + bounds.height / 2);
        await page.mouse.wheel(0, -640);
        await expect
          .poll(() => thread.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
          .toBeGreaterThan(200);
        await waitForProgressThreadIdle(thread);
        if (mobile) {
          await openChatDetails(page);
          await expectOpen(card, true);
        }
        expect(await card.getAttribute("open")).toBe("");
        await card.locator("summary").click();
        await expectOpen(card, false);
        const closed = await height(card);
        await wheel(page, card, -48);
        await expect.poll(() => card.getAttribute("data-reveal")).toBe("closed");
        expect(await height(card)).toBe(closed);
        const point = await headerPoint(card);
        const drag = await gesture(page, mobile);
        try {
          await drag.start(point);
          await drag.move({ x: point.x, y: point.y - 36 }, 6);
          await drag.end();
        } finally {
          await drag.close();
        }
        expect(await card.getAttribute("data-reveal")).not.toBe("partial");
        // Normalize via the public summary if a native release produced a click.
        if ((await card.getAttribute("open")) !== null) {
          await card.locator("summary").click();
        }
        const readerTop = await scrollTop(thread);
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
        expect(await scrollTop(thread)).toBe(readerTop);
        await gateway.emitChatFinal({ sessionKey, runId, text: "Complete." });
        await expect.poll(() => thread.textContent()).toContain("Complete.");
        expect(await card.getAttribute("open")).toBeNull();
        for (const key of ["Enter", "Space"]) {
          await card.locator("summary").press(key);
          await expectOpen(card, true);
          await card.locator(".session-progress-card__step").last().scrollIntoViewIfNeeded();
          expect(await panel.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
          expect(await scrollTop(thread)).toBe(readerTop);
          await card.locator("summary").press(key);
          await expectOpen(card, false);
        }
      });
    },
  );
  it.each([
    { reducedMotion: "no-preference", mobile: false },
    { reducedMotion: "reduce", mobile: false },
    { reducedMotion: "reduce", mobile: true },
  ] as const)(
    "scrubs embedded Home progress with wheel and drag, holds through streaming, and reverses ($reducedMotion, touch=$mobile)",
    async ({ reducedMotion, mobile }) => {
      await suite.withPage(contextOptions(reducedMotion, mobile), async ({ page }) => {
        const runId = "elastic-progress-run";
        let text = Array.from({ length: 48 }, (_, i) => "Current findings " + i + ".").join("\n\n");
        const initialCard = {
          sessionKey,
          revision: 1,
          updatedAt: Date.now(),
          markdown:
            "Reviewing the synthetic workspace.\n\n" +
            "- A detailed finding to verify.\n".repeat(18),
          steps: [
            { step: "Inspect the workspace", status: "completed" },
            { step: "Verify direct manipulation", status: "in_progress" },
            { step: "Summarize the result", status: "pending" },
          ],
        };
        const gateway = await installMockGateway(page, {
          sessionKey,
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "chat.history",
            "chat.send",
            "progressCard.get",
          ],
          historyMessages: Array.from({ length: 30 }, (_, i) =>
            chatMessage(i % 2 ? "assistant" : "user", "Earlier context " + i + ".", {
              timestamp: i + 1,
            }),
          ),
          inFlightRun: { runId, text },
          sessionInfo: { key: sessionKey, activeRunIds: [runId], hasActiveRun: true },
          methodResponses: { "progressCard.get": { card: initialCard } },
        });
        const home = page.locator("openclaw-home-session");
        const card = home.locator('[data-progress-card-placement="composer"]');
        const thread = home.locator(".chat-thread");
        // The dock requires advertised history/send capabilities and is suppressed
        // when its own Home conversation already owns the primary chat page.
        await page.goto(suite.server.baseUrl + "new");
        await openProgressHomeDock(page);
        await gateway.waitForRequest("chat.startup", { match: { sessionKey } });
        if (mobile) {
          await card.locator("summary").click();
        }
        await card.locator(".session-progress-card__body").waitFor();
        await waitForProgressThreadIdle(thread);
        const full = await height(card);
        await thread.hover();
        await page.mouse.wheel(0, -320);
        await waitForProgressThreadIdle(thread);
        await page.waitForTimeout(201);
        await page.mouse.wheel(0, -320);
        if (mobile) {
          // Explicitly close the manually opened mobile card before scrubbing it.
          await card.locator("summary").click();
        }
        await expectOpen(card, false);
        await waitForProgressThreadIdle(thread);
        const closed = await height(card);
        const readerTop = await scrollTop(thread);
        await wheel(page, card, -48);
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => resolve());
            }),
        );
        await expectHeight(card, closed + 48);
        await still(card, closed + 48);
        await wheel(page, card, -24);
        await expectHeight(card, closed + 72);
        await wheel(page, card, 24);
        await expectHeight(card, closed + 48);
        await still(card, closed + 48);
        for (let line = 1; line <= 6; line++) {
          text += "\n\nStreaming finding " + line + ".";
          await gateway.emitGatewayEvent("chat", {
            sessionKey,
            runId,
            state: "delta",
            message: chatMessage("assistant", text),
          });
        }
        await gateway.setMethodResponse("progressCard.get", {
          card: {
            ...initialCard,
            revision: 2,
            markdown: initialCard.markdown + "\nMore findings arrived.",
          },
        });
        await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 2 });
        await expect.poll(() => card.textContent()).toContain("More findings arrived.");
        await still(card, closed + 48);
        expect(Math.abs((await scrollTop(thread)) - readerTop)).toBeLessThanOrEqual(2);
        const point = await headerPoint(card);
        const drag = await gesture(page, mobile);
        try {
          await drag.start(point);
          if (mobile) {
            for (let step = 1; step <= 6; step++) {
              await drag.move({ x: point.x, y: point.y - step * 6 });
            }
          } else {
            await drag.move({ x: point.x, y: point.y - 36 }, 12);
          }
          await expectHeight(card, closed + 84);
          await still(card, closed + 84);
          await drag.move({ x: point.x, y: point.y - 16 }, 4);
          await expectHeight(card, closed + 64);
          await drag.end();
          await still(card, closed + 64);
          if (mobile) {
            const next = await headerPoint(card);
            await drag.start(next);
            await drag.move({ x: next.x, y: next.y - 12 });
            await expectHeight(card, closed + 76);
            await drag.end(true);
            await still(card, closed + 76);
            await wheel(page, card, 12);
          }
        } finally {
          await drag.close();
        }
        await wheel(page, card, -200);
        await expectHeight(card, closed + 264);
        await wheel(page, card, 200);
        await expectHeight(card, closed + 64);
        await home.locator('.chat-scroll-to-bottom[data-visible="true"]').click();
        await waitForProgressThreadIdle(thread);
        await still(card, closed + 64);
        await gateway.emitChatFinal({ sessionKey, runId, text: text + "\n\nComplete." });
        await still(card, closed + 64);
        await card.locator("summary").focus();
        await page.keyboard.press("Enter");
        await expectHeight(card, full);
        const body = card.locator(".session-progress-card__body");
        await body.hover();
        await page.mouse.wheel(0, 90);
        await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
        await still(card, full);
        await card.locator("summary").focus();
        await page.keyboard.press("Space");
        await expectOpen(card, false);
        await still(card, closed);
        // A full opening reached by a gesture must close on the first activation.
        for (const activation of ["click", "Enter", "Space"] as const) {
          await wheel(page, card, -1000);
          await expectHeight(card, full);
          if (activation === "click") {
            await card.locator("summary").click();
          } else {
            await card.locator("summary").focus();
            await page.keyboard.press(activation);
          }
          await expectOpen(card, false);
        }
      });
    },
  );
});
