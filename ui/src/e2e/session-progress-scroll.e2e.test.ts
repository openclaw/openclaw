import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";
import { openProgressHomeDock } from "./session-progress-home.test-support.ts";

const suite = createChatFlowE2eSuite();

async function waitForHomeScrollIdle(thread: Locator) {
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

const sessionKey = "agent:main:main";
const progress = {
  card: {
    sessionKey,
    revision: 1,
    updatedAt: 1_800_000_000_000,
    steps: [
      { step: "Inspect command output", status: "in_progress" },
      { step: "Verify transcript scrolling", status: "pending" },
    ],
  },
};
const message = (index: number) => ({
  role: index % 2 ? "assistant" : "user",
  content: [{ type: "text", text: `History ${index}: ${"Reading context. ".repeat(8)}` }],
  timestamp: 1_800_000_000_000 + index,
  __openclaw: { id: `scroll-history-${index}`, seq: index },
});
const scrollTop = (element: Locator) => element.evaluate((el) => el.scrollTop);
const isOpen = (card: Locator) => card.evaluate((el) => (el as HTMLDetailsElement).open);
const history = (length: number, offset = 0) =>
  Array.from({ length }, (_, index) => message(index + offset));
const entry = (role: string, content: unknown, index: number) => ({
  role,
  content,
  timestamp: 1_800_000_000_000 + index,
});
async function openHome(page: Page, options: Parameters<typeof installMockGateway>[1]) {
  const gateway = await installMockGateway(page, {
    featureMethods: [...defaultControlUiFeatureMethods, "chat.history", "chat.send"],
    sessionKey,
    sessionInfo: { key: sessionKey, hasActiveRun: true, activeRunIds: ["progress-run"] },
    inFlightRun: { runId: "progress-run", startedAt: 1_800_000_001_000 },
    methodResponses: { "progressCard.get": progress },
    ...options,
  });
  const home = page.locator("openclaw-home-session");
  const thread = home.locator(".chat-thread");
  const card = home.locator('[data-progress-card-placement="composer"]');
  // The same Home conversation cannot own both the page and its dock.
  await page.goto(`${suite.server.baseUrl}new`);
  await openProgressHomeDock(page);
  await gateway.waitForRequest("chat.startup", { match: { sessionKey } });
  await card.waitFor();
  return { gateway, home, thread, card };
}
async function reopenHome(page: Page, home: Locator, card: Locator) {
  await page.getByRole("button", { name: "Close assistant sidebar", exact: true }).click();
  await home.waitFor({ state: "hidden" });
  await openProgressHomeDock(page);
  await card.waitFor();
}
async function wheelGestures(page: Page, thread: Locator, count: number) {
  for (let index = 0; index < count; index++) {
    await page.mouse.wheel(0, -240);
    // Separate gestures under the disclosure's 200 ms boundary.
    await page.waitForTimeout(220);
  }
  await waitForHomeScrollIdle(thread);
  await page.waitForTimeout(300);
}

suite.define(() => {
  it.each(["nested output", "canceled wheel"] as const)(
    "preserves compact Home progress and its session choice after %s",
    async (target) => {
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const { gateway, home, thread, card } = await openHome(page, {
          historyMessages: [
            ...history(60),
            entry("user", "Inspect the command output.", 60),
            entry(
              "assistant",
              [
                {
                  type: "toolCall",
                  id: "scroll-output",
                  name: "bash",
                  arguments: { command: "cat scroll-evidence.txt" },
                },
              ],
              61,
            ),
            {
              role: "toolResult",
              toolCallId: "scroll-output",
              toolName: "bash",
              content: [
                {
                  type: "text",
                  text: Array.from(
                    { length: 180 },
                    (_, index) => `Output line ${index}: command evidence.`,
                  ).join("\n"),
                },
              ],
              timestamp: 1_800_000_000_062,
            },
            entry("assistant", "The command output is ready to inspect.", 63),
            entry("user", "Continue the verification while I read the output.", 64),
          ],
        });
        await waitForHomeScrollIdle(thread);
        await home
          .locator(".chat-tool-msg-summary")
          .filter({ hasText: "cat scroll-evidence.txt" })
          .click();
        const outputScroller = home.locator(".chat-tool-term__out").last();
        await outputScroller.waitFor({ state: "visible" });
        expect(
          await outputScroller.evaluate((element) => element.scrollHeight - element.clientHeight),
        ).toBeGreaterThan(1000);
        await outputScroller.evaluate((element) => {
          element.scrollTop = 1200;
        });
        await outputScroller.hover();
        await thread.evaluate((element) => {
          element.scrollTop -= 120;
        });
        await waitForHomeScrollIdle(thread);
        expect(
          await thread.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        ).toBeGreaterThan(8);
        await card.locator("summary").click();
        await card.locator("summary").click();
        expect(await isOpen(card)).toBe(true);
        if (target === "canceled wheel") {
          await outputScroller.evaluate((element) => {
            element.addEventListener("wheel", (event) => event.preventDefault(), {
              passive: false,
            });
          });
        }
        const wheelPoint = await outputScroller.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return { x: rect.left + 100, y: rect.top + 100 };
        });
        await page.mouse.move(wheelPoint.x, wheelPoint.y);
        const before = {
          thread: await scrollTop(thread),
          output: await scrollTop(outputScroller),
        };
        await wheelGestures(page, thread, 3);
        const after = {
          thread: await scrollTop(thread),
          output: await scrollTop(outputScroller),
        };
        expect(Math.abs(after.thread - before.thread)).toBeLessThanOrEqual(1);
        if (target === "nested output") {
          expect(before.output - after.output).toBeGreaterThanOrEqual(700);
        } else {
          expect(after.output).toBe(before.output);
        }
        expect(await isOpen(card)).toBe(true);
        // Completion and remount must not discard the manual disclosure choice.
        await gateway.setMethodResponse("progressCard.get", {
          card: {
            ...progress.card,
            revision: 2,
            steps: progress.card.steps.map((step) => ({ ...step, status: "completed" })),
          },
        });
        await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 2 });
        await expect.poll(() => card.getAttribute("data-complete")).toBe("true");
        await reopenHome(page, home, card);
        await waitForHomeScrollIdle(thread);
        expect(await isOpen(card)).toBe(true);
        // Closed differs from the desktop default and proves remembered choice.
        await card.locator("summary").click();
        await reopenHome(page, home, card);
        expect(await isOpen(card)).toBe(false);
      });
    },
  );

  it("counts native touch inertia toward a manually reopened compact Home card", async () => {
    await suite.withPage(
      {
        hasTouch: true,
        isMobile: true,
        viewport: { width: 390, height: 844 },
      },
      async ({ page, context }) => {
        const { thread, card } = await openHome(page, {
          historyMessages: history(80),
        });
        expect(await card.getAttribute("open")).toBeNull();
        await card.locator("summary").click();
        expect(await card.getAttribute("open")).not.toBeNull();
        await waitForHomeScrollIdle(thread);
        const cdp = await context.newCDPSession(page);
        const point = await thread.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + 160, id: 1 };
        });
        await thread.evaluate((element) => {
          element.addEventListener(
            "touchend",
            () => {
              (element as HTMLElement).dataset.touchReleaseOffset = String(element.scrollTop);
            },
            { passive: true },
          );
        });
        const offsets: Array<{ before: number; released: number; settled: number }> = [];
        for (let index = 0; index < 3; index++) {
          const before = await scrollTop(thread);
          const timestamp = Date.now() / 1000;
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [point],
            timestamp,
          });
          for (let step = 1; step <= 7; step++) {
            await cdp.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [{ ...point, y: point.y + step * 20 }],
              // Timestamp the physical gesture independently of CDP round-trip latency.
              timestamp: timestamp + step * 0.008,
            });
          }
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchEnd",
            touchPoints: [],
            timestamp: timestamp + 0.057,
          });
          await waitForHomeScrollIdle(thread);
          offsets.push(
            await thread.evaluate(
              (element, beforeOffset) => ({
                before: beforeOffset,
                released: Number((element as HTMLElement).dataset.touchReleaseOffset),
                settled: element.scrollTop,
              }),
              before,
            ),
          );
        }
        // The fingers travel only 420 px. Crossing the reopened 640 px threshold
        // requires native inertia, which raw touch-coordinate counting omits.
        expect(
          offsets.reduce((distance, offset) => distance + offset.before - offset.settled, 0),
        ).toBeGreaterThan(640);
        for (const offset of offsets) {
          expect(offset.released - offset.settled).toBeGreaterThan(1);
        }
        await expect.poll(() => isOpen(card)).toBe(false);
        await cdp.detach();
      },
    );
  });

  it("does not count compact Home scroll-to-end or deferred history prepend as reader gestures", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const { gateway, home, thread, card } = await openHome(page, {
        methodResponses: {
          "progressCard.get": progress,
          "chat.startup": {
            messages: history(80, 80),
            hasMore: true,
            nextOffset: 80,
            totalMessages: 160,
            sessionId: "progress-scroll",
          },
          "chat.history": {
            messages: history(80),
            hasMore: false,
            nextOffset: 160,
            totalMessages: 160,
            sessionId: "progress-scroll",
          },
        },
      });
      await waitForHomeScrollIdle(thread);
      await gateway.deferNext("chat.history");
      await thread.hover();
      await page.mouse.wheel(0, -100_000);
      await gateway.waitForRequest("chat.history", { match: { offset: 80 } });
      await waitForHomeScrollIdle(thread);
      await card.locator("summary").click();
      await card.locator("summary").click();
      expect(await isOpen(card)).toBe(true);
      const beforePrepend = await scrollTop(thread);
      await gateway.resolveDeferred("chat.history");
      await expect.poll(() => scrollTop(thread)).toBeGreaterThan(beforePrepend + 1000);
      await waitForHomeScrollIdle(thread);
      expect(await isOpen(card)).toBe(true);
      await home.locator('.chat-scroll-to-bottom[data-visible="true"]').click();
      await waitForHomeScrollIdle(thread);
      expect(await isOpen(card)).toBe(true);
      // Two genuine gestures exceed the default 320 px threshold, but not the
      // three-gesture threshold belonging to the retained manual reopen.
      await thread.hover();
      await wheelGestures(page, thread, 2);
      expect(await isOpen(card)).toBe(true);
    });
  });
});
