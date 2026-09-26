import { expect, it } from "vitest";
import {
  captureUiProof,
  createChatFlowE2eSuite,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
type AnchorProbe = { frame: number; tops: Array<number | null> };
type ProbeWindow = typeof window & { activityAnchor: AnchorProbe };

suite.define(() => {
  it.each([
    { width: 1440, split: false },
    { width: 390, split: false },
    { width: 1440, split: true },
  ])(
    "keeps visible messages still when older activity coalesces at $width px (split: $split)",
    async ({ width, split }) => {
      const context = await suite.newBrowserContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width, height: 900 },
      });
      const page = await context.newPage();
      const activity = (seq: number) => ({
        __openclaw: { id: `activity-${seq}`, seq, runId: `wake-${seq}` },
        role: "toolResult",
        toolCallId: `call-${seq}`,
        toolName: "read",
        content: [{ type: "text", text: "Synthetic check completed." }],
        timestamp: 1_800_000_000_000 + seq,
      });
      const recent = [
        ...Array.from({ length: 20 }, (_, index) => activity(1001 + index)),
        ...Array.from({ length: 52 }, (_, index) => ({
          __openclaw: { id: `message-${index}`, seq: 1021 + index },
          role: index % 2 ? "assistant" : "user",
          content: [
            { type: "text", text: `Retained message ${index}. ${"History detail. ".repeat(8)}` },
          ],
          timestamp: 1_800_000_001_021 + index,
        })),
      ];
      const gateway = await installMockGateway(page, {
        sessions: [{ key: "agent:main:main", sessionId: "activity-history" }],
        heldMethods: ["chat.history"],
        methodResponses: {
          "chat.startup": {
            messages: recent,
            hasMore: true,
            nextOffset: 72,
            totalMessages: 2072,
            sessionId: "activity-history",
          },
          "chat.history": {
            messages: Array.from({ length: 1000 }, (_, index) => activity(index + 1)),
            hasMore: true,
            nextOffset: 1072,
            totalMessages: 2072,
            sessionId: "activity-history",
          },
        },
      });
      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        let pane = page.locator(".chat-pane-cache__pane--active");
        let thread = pane.locator(".chat-thread");
        await thread.getByText(/^Retained message 51\./).waitFor();
        if (split) {
          await pane.getByRole("button", { name: "Open split view", exact: true }).click();
          const panes = page.locator("openclaw-chat-pane.chat-split-view__pane");
          await expect.poll(() => panes.count()).toBe(2);
          pane = panes.nth(1);
          thread = pane.locator(".chat-thread");
          await thread.getByText(/^Retained message 51\./).waitFor();
        }
        await thread.hover();
        await page.mouse.wheel(0, -100_000);
        await gateway.waitForRequest("chat.history", {
          match: { sessionKey: "agent:main:main", offset: 72 },
        });
        await waitForChatScrollIdle(page);
        // The initial virtual range can still settle after the history request. A native
        // key places the same retained bubble at the top before delivery.
        const anchor = thread.locator(".chat-bubble").filter({ hasText: "Retained message 0." });
        await expect.poll(() => anchor.isVisible()).toBe(true);
        await page.keyboard.press("Home");
        await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBe(0);
        const count = () =>
          pane.evaluate(
            (element) =>
              (
                element as HTMLElement & {
                  state: { chatMessages: unknown[] };
                }
              ).state.chatMessages.length,
          );
        expect(await count()).toBe(72);
        const before = await anchor.boundingBox();
        expect(before).not.toBeNull();
        expect(before!.y).toBeGreaterThan(0);
        await pane.evaluate((element) => {
          element.dataset.activityAnchorProbe = "true";
        });
        await page.evaluate(
          (key) => {
            const probe: AnchorProbe = { frame: 0, tops: [] };
            (window as ProbeWindow).activityAnchor = probe;
            const sample = () => {
              const bubble = [
                ...document.querySelectorAll<HTMLElement>(
                  '[data-activity-anchor-probe="true"] .chat-bubble[data-message-id]',
                ),
              ].find((element) => element.dataset.messageId === key);
              probe.tops.push(bubble?.getBoundingClientRect().top ?? null);
              probe.frame = requestAnimationFrame(sample);
            };
            sample();
          },
          await anchor.getAttribute("data-message-id"),
        );
        if (split) {
          const sibling = page.locator("openclaw-chat-pane.chat-split-view__pane").nth(0);
          await sibling.locator(".chat-pane__header").click();
          await expect
            .poll(() =>
              pane.evaluate((element) => element.matches(":not(.chat-pane-cache__pane--active)")),
            )
            .toBe(true);
        }
        await gateway.deferNext("chat.history");
        await gateway.resolveDeferred("chat.history");
        await expect.poll(count).toBe(1072);
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        const tops = await page.evaluate(() => {
          const probe = (window as ProbeWindow).activityAnchor;
          cancelAnimationFrame(probe.frame);
          return probe.tops;
        });
        expect(tops.length).toBeGreaterThan(1);
        expect(
          tops.every((top) => top !== null),
          "retained bubble remains mounted",
        ).toBe(true);
        const displacement = Math.max(...tops.map((top) => Math.abs(top! - before!.y)));
        expect(displacement, "each frame must preserve the reading position").toBeLessThanOrEqual(
          1,
        );
        expect(Math.abs((await anchor.boundingBox())!.y - before!.y)).toBeLessThanOrEqual(1);
        await captureUiProof(
          suite,
          page,
          "chat-history-activity-anchor",
          `${width}px-${split ? "split" : "classic"}-stable.png`,
        );
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
