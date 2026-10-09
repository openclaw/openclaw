import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";

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

suite.define(() => {
  it.each(["nested output", "canceled wheel"] as const)(
    "preserves manually reopened progress and its session choice after %s",
    async (target) => {
      const artifactDir = createControlUiE2eArtifactDir(
        `session-progress-${target.replaceAll(" ", "-")}`,
      );
      const context = await suite.newBrowserContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessionInfo: { key: sessionKey, hasActiveRun: true, activeRunIds: ["progress-run"] },
        inFlightRun: { runId: "progress-run", startedAt: 1_800_000_001_000 },
        historyMessages: [
          ...Array.from({ length: 60 }, (_, index) => message(index)),
          { role: "user", content: "Inspect the command output.", timestamp: 1_800_000_000_060 },
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "scroll-output",
                name: "bash",
                arguments: { command: "cat scroll-evidence.txt" },
              },
            ],
            timestamp: 1_800_000_000_061,
          },
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
          {
            role: "assistant",
            content: "The command output is ready to inspect.",
            timestamp: 1_800_000_000_063,
          },
          {
            role: "user",
            content: "Continue the verification while I read the output.",
            timestamp: 1_800_000_000_064,
          },
        ],
        methodResponses: { "progressCard.get": progress },
      });
      const thread = page.locator(".chat-thread");
      const card = page.locator(".session-progress-card--composer");
      const isOpen = () => card.evaluate((element) => (element as HTMLDetailsElement).open);
      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        await card.waitFor();
        await waitForChatScrollIdle(page);
        await page
          .locator(".chat-tool-msg-summary")
          .filter({ hasText: "cat scroll-evidence.txt" })
          .click();
        const outputScroller = page.locator(".chat-tool-term__out").last();
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
        await waitForChatScrollIdle(page);
        expect(
          await thread.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        ).toBeGreaterThan(8);
        await card.locator("summary").click();
        await card.locator("summary").click();
        expect(await isOpen()).toBe(true);
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
          thread: await thread.evaluate((element) => element.scrollTop),
          output: await outputScroller.evaluate((element) => element.scrollTop),
        };
        await page.screenshot({ path: path.join(artifactDir, "before-wheel.png") });
        for (let index = 0; index < 3; index++) {
          await page.mouse.wheel(0, -240);
          // These are three separate gestures under the disclosure's 200 ms boundary.
          await page.waitForTimeout(220);
        }
        await waitForChatScrollIdle(page);
        await page.waitForTimeout(300);
        const after = {
          thread: await thread.evaluate((element) => element.scrollTop),
          output: await outputScroller.evaluate((element) => element.scrollTop),
        };
        await page.screenshot({ path: path.join(artifactDir, "after-wheel.png") });
        await writeFile(
          path.join(artifactDir, "offsets.json"),
          JSON.stringify({ target, before, after, cardOpen: await isOpen() }, null, 2),
        );
        expect(Math.abs(after.thread - before.thread)).toBeLessThanOrEqual(1);
        if (target === "nested output") {
          expect(before.output - after.output).toBeGreaterThanOrEqual(700);
        } else {
          expect(after.output).toBe(before.output);
        }
        expect(await isOpen()).toBe(true);
        // A completed card defaults closed on a new visit. Remaining open then
        // distinguishes the remembered manual choice from the active-run default.
        await gateway.setMethodResponse("progressCard.get", {
          card: {
            ...progress.card,
            revision: 2,
            steps: progress.card.steps.map((step) => ({ ...step, status: "completed" })),
          },
        });
        await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 2 });
        await expect.poll(() => card.getAttribute("data-complete")).toBe("true");
        const sidebar = page.locator("openclaw-app-sidebar");
        await sidebar.locator(".sidebar-identity-card").click();
        await sidebar
          .locator("wa-dropdown.sidebar-identity-menu")
          .getByRole("menuitem", { exact: true, name: "Settings" })
          .click();
        await page.locator("openclaw-chat-pane").waitFor({ state: "hidden" });
        await page.goBack();
        await card.waitFor({ state: "visible" });
        await waitForChatScrollIdle(page);
        expect(await isOpen()).toBe(true);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("counts native touch inertia in transcript movement", async () => {
    const artifactDir = createControlUiE2eArtifactDir("session-progress-touch-inertia");
    const context = await suite.newBrowserContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      sessionKey,
      sessionInfo: { key: sessionKey, hasActiveRun: true, activeRunIds: ["progress-run"] },
      inFlightRun: { runId: "progress-run", startedAt: 1_800_000_001_000 },
      historyMessages: Array.from({ length: 80 }, (_, index) => message(index)),
      methodResponses: { "progressCard.get": progress },
    });
    const thread = page.locator(".chat-thread");
    const card = page.locator(".session-progress-card--composer");
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await card.waitFor();
      await waitForChatScrollIdle(page);
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
      await page.screenshot({ path: path.join(artifactDir, "before-touch.png") });
      for (let index = 0; index < 2; index++) {
        const before = await thread.evaluate((element) => element.scrollTop);
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
        await waitForChatScrollIdle(page);
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
      await page.screenshot({ path: path.join(artifactDir, "after-touch.png") });
      await writeFile(
        path.join(artifactDir, "touch-offsets.json"),
        JSON.stringify(offsets, null, 2),
      );
      // The fingers travel only 280 px. Crossing 320 px therefore requires the
      // transcript's native inertia, which raw touch-coordinate counting omits.
      expect(
        offsets.reduce((distance, offset) => distance + offset.before - offset.settled, 0),
      ).toBeGreaterThan(320);
      for (const offset of offsets) {
        expect(offset.released - offset.settled).toBeGreaterThan(1);
      }
      await expect
        .poll(() => card.evaluate((element) => (element as HTMLDetailsElement).open))
        .toBe(false);
      await cdp.detach();
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("does not count scroll-to-end or a deferred history prepend as reader gestures", async () => {
    const context = await suite.newBrowserContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const recent = Array.from({ length: 80 }, (_, index) => message(index + 80));
    const older = Array.from({ length: 80 }, (_, index) => message(index));
    const gateway = await installMockGateway(page, {
      sessionKey,
      sessionInfo: { key: sessionKey, hasActiveRun: true, activeRunIds: ["progress-run"] },
      inFlightRun: { runId: "progress-run", startedAt: 1_800_000_001_000 },
      methodResponses: {
        "progressCard.get": progress,
        "chat.startup": {
          messages: recent,
          hasMore: true,
          nextOffset: 80,
          totalMessages: 160,
          sessionId: "progress-scroll",
        },
        "chat.history": {
          messages: older,
          hasMore: false,
          nextOffset: 160,
          totalMessages: 160,
          sessionId: "progress-scroll",
        },
      },
    });
    const thread = page.locator(".chat-thread");
    const card = page.locator(".session-progress-card--composer");
    const isOpen = () => card.evaluate((element) => (element as HTMLDetailsElement).open);
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await card.waitFor();
      await waitForChatScrollIdle(page);
      await gateway.deferNext("chat.history");
      await thread.hover();
      await page.mouse.wheel(0, -100_000);
      await gateway.waitForRequest("chat.history", { match: { offset: 80 } });
      await waitForChatScrollIdle(page);
      await card.locator("summary").click();
      await card.locator("summary").click();
      expect(await isOpen()).toBe(true);
      const beforePrepend = await thread.evaluate((element) => element.scrollTop);
      await gateway.resolveDeferred("chat.history");
      await expect
        .poll(() => thread.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(beforePrepend + 1000);
      await waitForChatScrollIdle(page);
      expect(await isOpen()).toBe(true);
      await page.locator('.chat-scroll-to-bottom[data-visible="true"]').click();
      await waitForChatScrollIdle(page);
      expect(await isOpen()).toBe(true);
      // Two genuine gestures exceed the default 320 px threshold, but not the
      // three-gesture threshold belonging to the retained manual reopen.
      await thread.hover();
      for (let index = 0; index < 2; index++) {
        await page.mouse.wheel(0, -240);
        await page.waitForTimeout(220);
      }
      await waitForChatScrollIdle(page);
      await page.waitForTimeout(300);
      expect(await isOpen()).toBe(true);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
