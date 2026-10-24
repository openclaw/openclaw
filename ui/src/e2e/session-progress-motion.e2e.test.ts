import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { openChatDetails } from "./chat-details.test-support.ts";
import {
  createChatFlowE2eSuite,
  expectDefined,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import { openProgressHomeDock } from "./session-progress-home.test-support.ts";

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
  it.each([false, true])("keeps Details manual with touch=%s", async (touch) => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, hasTouch: touch },
      async ({ page }) => {
        await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
          inFlightRun: { runId: "details-motion-run", text: "Reviewing the workspace." },
          sessionInfo: {
            key: "agent:main:main",
            activeRunIds: ["details-motion-run"],
            hasActiveRun: true,
          },
          methodResponses: {
            "progressCard.get": {
              card: {
                sessionKey: "agent:main:main",
                revision: 1,
                updatedAt: 1,
                markdown: "- A detailed finding.\n".repeat(48),
                steps: [{ step: "Verify manual disclosure", status: "in_progress" }],
              },
            },
          },
        });
        await page.goto(suite.server.baseUrl + "chat");
        await openChatDetails(page);
        const card = page.locator('[data-progress-card-placement="details"]');
        await expect.poll(() => card.getAttribute("open")).toBe("");
        await card.locator("summary").click();
        await expect.poll(() => card.getAttribute("open")).toBeNull();
        const closed = await height(card);
        await wheel(page, card, -48);
        await expect.poll(() => card.getAttribute("data-reveal")).toBe("closed");
        expect(await height(card)).toBe(closed);
        const point = await headerPoint(card);
        if (touch) {
          const input = await page.context().newCDPSession(page);
          try {
            await input.send("Input.dispatchTouchEvent", {
              type: "touchStart",
              touchPoints: [point],
            });
            await input.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [{ x: point.x, y: point.y - 36 }],
            });
            await input.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          } finally {
            await input.detach();
          }
        } else {
          await page.mouse.move(point.x, point.y);
          await page.mouse.down();
          await page.mouse.move(point.x, point.y - 36, { steps: 6 });
          await page.mouse.up();
        }
        expect(await card.getAttribute("data-reveal")).not.toBe("partial");
      },
    );
  });
  it.each([
    { reducedMotion: "no-preference", mobile: false },
    { reducedMotion: "reduce", mobile: false },
    { reducedMotion: "reduce", mobile: true },
  ] as const)(
    "scrubs embedded Home progress with wheel and drag, holds through streaming, and reverses ($reducedMotion, touch=$mobile)",
    async ({ reducedMotion, mobile }) => {
      const viewport = mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 };
      const context = await suite.newBrowserContext({
        ...createControlUiE2eContextOptions(),
        reducedMotion,
        viewport,
        isMobile: mobile,
        hasTouch: mobile,
      });
      const page = await context.newPage();
      const sessionKey = "agent:main:main";
      const runId = "elastic-progress-run";
      let text = Array.from({ length: 48 }, (_, i) => "Current findings " + i + ".").join("\n\n");
      const initialCard = {
        sessionKey,
        revision: 1,
        updatedAt: Date.now(),
        markdown:
          "Reviewing the synthetic workspace.\n\n" + "- A detailed finding to verify.\n".repeat(18),
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
        historyMessages: Array.from({ length: 30 }, (_, i) => ({
          role: i % 2 ? "assistant" : "user",
          content: [{ type: "text", text: "Earlier context " + i + "." }],
          timestamp: i + 1,
        })),
        inFlightRun: { runId, text },
        sessionInfo: { key: sessionKey, activeRunIds: [runId], hasActiveRun: true },
        methodResponses: { "progressCard.get": { card: initialCard } },
      });
      const home = page.locator("openclaw-home-session");
      const card = home.locator('[data-progress-card-placement="composer"]');
      const thread = home.locator(".chat-thread");
      try {
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
        await expect.poll(() => card.getAttribute("open")).toBeNull();
        await waitForProgressThreadIdle(thread);
        const closed = await height(card);
        const readerTop = await thread.evaluate((el) => el.scrollTop);
        await wheel(page, card, -48);
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => resolve());
            }),
        );
        await expect.poll(() => height(card)).toBeCloseTo(closed + 48, 0);
        await still(card, closed + 48);
        await wheel(page, card, -24);
        await expect.poll(() => height(card)).toBeCloseTo(closed + 72, 0);
        await wheel(page, card, 24);
        await expect.poll(() => height(card)).toBeCloseTo(closed + 48, 0);
        await still(card, closed + 48);
        for (let line = 1; line <= 6; line++) {
          text += "\n\nStreaming finding " + line + ".";
          await gateway.emitGatewayEvent("chat", {
            sessionKey,
            runId,
            state: "delta",
            message: { role: "assistant", content: [{ type: "text", text }] },
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
        expect(
          Math.abs((await thread.evaluate((el) => el.scrollTop)) - readerTop),
        ).toBeLessThanOrEqual(2);
        const point = await headerPoint(card);
        if (mobile) {
          const touch = await context.newCDPSession(page);
          try {
            await touch.send("Input.dispatchTouchEvent", {
              type: "touchStart",
              touchPoints: [point],
            });
            for (let step = 1; step <= 6; step++) {
              await touch.send("Input.dispatchTouchEvent", {
                type: "touchMove",
                touchPoints: [{ x: point.x, y: point.y - step * 6 }],
              });
            }
            await expect.poll(() => height(card)).toBeCloseTo(closed + 84, 0);
            await still(card, closed + 84);
            await touch.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [{ x: point.x, y: point.y - 16 }],
            });
            await expect.poll(() => height(card)).toBeCloseTo(closed + 64, 0);
            await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
            await still(card, closed + 64);
            const next = await headerPoint(card);
            await touch.send("Input.dispatchTouchEvent", {
              type: "touchStart",
              touchPoints: [next],
            });
            await touch.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [{ x: next.x, y: next.y - 12 }],
            });
            await expect.poll(() => height(card)).toBeCloseTo(closed + 76, 0);
            await touch.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
            await still(card, closed + 76);
            await wheel(page, card, 12);
          } finally {
            await touch.detach();
          }
        } else {
          await page.mouse.move(point.x, point.y);
          await page.mouse.down();
          await page.mouse.move(point.x, point.y - 36, { steps: 12 });
          await expect.poll(() => height(card)).toBeCloseTo(closed + 84, 0);
          await still(card, closed + 84);
          await page.mouse.move(point.x, point.y - 16, { steps: 4 });
          await expect.poll(() => height(card)).toBeCloseTo(closed + 64, 0);
          await page.mouse.up();
          await still(card, closed + 64);
        }
        await wheel(page, card, -200);
        await expect.poll(() => height(card)).toBeCloseTo(closed + 264, 0);
        await wheel(page, card, 200);
        await expect.poll(() => height(card)).toBeCloseTo(closed + 64, 0);
        await home.locator('.chat-scroll-to-bottom[data-visible="true"]').click();
        await waitForProgressThreadIdle(thread);
        await still(card, closed + 64);
        await gateway.emitChatFinal({ sessionKey, runId, text: text + "\n\nComplete." });
        await still(card, closed + 64);
        await card.locator("summary").focus();
        await page.keyboard.press("Enter");
        await expect.poll(() => height(card)).toBeCloseTo(full, 0);
        const body = card.locator(".session-progress-card__body");
        await body.hover();
        await page.mouse.wheel(0, 90);
        await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
        await still(card, full);
        await card.locator("summary").focus();
        await page.keyboard.press("Space");
        await expect.poll(() => card.getAttribute("open")).toBeNull();
        await still(card, closed);
        // A full opening reached by a gesture must close on the first activation.
        for (const activation of ["click", "Enter", "Space"] as const) {
          await wheel(page, card, -1000);
          await expect.poll(() => height(card)).toBeCloseTo(full, 0);
          if (activation === "click") {
            await card.locator("summary").click();
          } else {
            await card.locator("summary").focus();
            await page.keyboard.press(activation);
          }
          await expect.poll(() => card.getAttribute("open")).toBeNull();
        }
      } finally {
        await page.close();
        await suite.closeBrowserContext(context);
      }
    },
  );
});
