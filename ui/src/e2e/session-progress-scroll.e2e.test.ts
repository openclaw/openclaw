import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  textContent,
} from "./chat-flow.test-support.ts";
import { openProgressHomeDock } from "./session-progress-home.test-support.ts";
import { parts, waitForIdle } from "./session-progress.test-support.ts";

const suite = createChatFlowE2eSuite();

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
const historyPage = (nextOffset: number, hasMore: boolean) => ({
  messages: history(80, hasMore ? 80 : 0),
  hasMore,
  nextOffset,
  totalMessages: 160,
  sessionId: "progress-scroll",
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
  const { card } = parts(home, "composer");
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
  await waitForIdle(thread);
  await page.waitForTimeout(300);
}

suite.define(() => {
  it.each(["nested output", "canceled wheel"] as const)(
    "preserves compact Home progress and its session choice after %s",
    async (target) => {
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const command = "cat scroll-evidence.txt";
        const output = textContent("Command evidence.\n".repeat(179) + "Command evidence.");
        const toolCall = {
          type: "toolCall",
          id: "scroll-output",
          name: "bash",
          arguments: { command },
        };
        const { gateway, home, thread, card } = await openHome(page, {
          historyMessages: [
            ...history(60),
            entry("user", "Inspect the command output.", 60),
            entry("assistant", [toolCall], 61),
            { ...entry("toolResult", output, 62), toolCallId: "scroll-output", toolName: "bash" },
            entry("assistant", "The command output is ready to inspect.", 63),
            entry("user", "Continue the verification while I read the output.", 64),
          ],
        });
        await waitForIdle(thread);
        await home.locator(".chat-tool-msg-summary").filter({ hasText: command }).click();
        const outputScroller = home.locator(".chat-tool-term__out").last();
        await outputScroller.waitFor({ state: "visible" });
        expect(
          await outputScroller.evaluate((el) => el.scrollHeight - el.clientHeight),
        ).toBeGreaterThan(1000);
        await outputScroller.evaluate((element) => {
          element.scrollTop = 1200;
        });
        await outputScroller.hover();
        await thread.evaluate((element) => {
          element.scrollTop -= 120;
        });
        await waitForIdle(thread);
        expect(
          await thread.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
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
        const offsets = async () => ({
          thread: await scrollTop(thread),
          output: await scrollTop(outputScroller),
        });
        const before = await offsets();
        await wheelGestures(page, thread, 3);
        const after = await offsets();
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
        await waitForIdle(thread);
        expect(await isOpen(card)).toBe(true);
        // Closed differs from the desktop default and proves remembered choice.
        await card.locator("summary").click();
        await reopenHome(page, home, card);
        expect(await isOpen(card)).toBe(false);
      });
    },
  );

  it("counts native touch inertia toward a manually reopened compact Home card", async () => {
    const options = {
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    };
    await suite.withPage(options, async ({ page, context }) => {
      const { thread, card } = await openHome(page, {
        historyMessages: history(80),
      });
      expect(await card.getAttribute("open")).toBeNull();
      await card.locator("summary").click();
      expect(await card.getAttribute("open")).not.toBeNull();
      await waitForIdle(thread);
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
      let distance = 0;
      for (let index = 0; index < 3; index++) {
        const before = await scrollTop(thread);
        const timestamp = Date.now() / 1000;
        const touch = (
          type: "touchStart" | "touchMove" | "touchEnd",
          elapsed: number,
          y?: number,
        ) =>
          cdp.send("Input.dispatchTouchEvent", {
            type,
            timestamp: timestamp + elapsed,
            touchPoints: y === undefined ? [] : [{ ...point, y }],
          });
        await touch("touchStart", 0, point.y);
        for (let step = 1; step <= 7; step++) {
          // Timestamp the physical gesture independently of CDP round-trip latency.
          await touch("touchMove", step * 0.008, point.y + step * 20);
        }
        await touch("touchEnd", 0.057);
        await waitForIdle(thread);
        const { released, settled } = await thread.evaluate((element) => ({
          released: Number((element as HTMLElement).dataset.touchReleaseOffset),
          settled: element.scrollTop,
        }));
        distance += before - settled;
        expect(released - settled).toBeGreaterThan(1);
      }
      // The fingers travel only 420 px. Crossing the reopened 640 px threshold
      // requires native inertia, which raw touch-coordinate counting omits.
      expect(distance).toBeGreaterThan(640);
      await expect.poll(() => isOpen(card)).toBe(false);
      await cdp.detach();
    });
  });

  it("does not count compact Home scroll-to-end or deferred history prepend as reader gestures", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const { gateway, home, thread, card } = await openHome(page, {
        methodResponses: {
          "progressCard.get": progress,
          "chat.startup": historyPage(80, true),
          "chat.history": historyPage(160, false),
        },
      });
      await waitForIdle(thread);
      await gateway.deferNext("chat.history");
      await thread.hover();
      await page.mouse.wheel(0, -100_000);
      await gateway.waitForRequest("chat.history", { match: { offset: 80 } });
      await waitForIdle(thread);
      await card.locator("summary").click();
      await card.locator("summary").click();
      expect(await isOpen(card)).toBe(true);
      const beforePrepend = await scrollTop(thread);
      await gateway.resolveDeferred("chat.history");
      await expect.poll(() => scrollTop(thread)).toBeGreaterThan(beforePrepend + 1000);
      await waitForIdle(thread);
      expect(await isOpen(card)).toBe(true);
      await home.locator('.chat-scroll-to-bottom[data-visible="true"]').click();
      await waitForIdle(thread);
      expect(await isOpen(card)).toBe(true);
      // Two genuine gestures exceed the default 320 px threshold, but not the
      // three-gesture threshold belonging to the retained manual reopen.
      await thread.hover();
      await wheelGestures(page, thread, 2);
      expect(await isOpen(card)).toBe(true);
    });
  });
});
