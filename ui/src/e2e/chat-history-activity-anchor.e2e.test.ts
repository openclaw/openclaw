import { expect, it } from "vitest";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
type AnchorProbe = { frame: number; tops: Array<number | null> };
type ProbeWindow = typeof window & { activityAnchor: AnchorProbe };

suite.define(() => {
  it.each([1440, 390])(
    "keeps visible messages still when older activity coalesces at %i px",
    async (width) => {
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
        const pane = page.locator(".chat-pane-cache__pane--active");
        const thread = pane.locator(".chat-thread");
        await thread.getByText(/^Retained message 51\./).waitFor();
        await thread.focus();
        await page.keyboard.press("Home");
        await gateway.waitForRequest("chat.history", {
          match: { sessionKey: "agent:main:main", offset: 72 },
        });
        await waitForChatScrollIdle(page);
        // The initial virtual range can still settle after native Home. A second
        // native key places the same retained bubble at the top before delivery.
        await expect
          .poll(() => thread.getByText("Read 20 files", { exact: true }).isVisible())
          .toBe(true);
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
        const anchor = thread.locator(".chat-bubble").filter({ hasText: "Retained message 0." });
        const before = await anchor.boundingBox();
        expect(before).not.toBeNull();
        expect(before!.y).toBeGreaterThan(0);
        await page.evaluate(
          (key) => {
            const probe: AnchorProbe = { frame: 0, tops: [] };
            (window as ProbeWindow).activityAnchor = probe;
            const sample = () => {
              const bubble = [
                ...document.querySelectorAll<HTMLElement>(
                  ".chat-pane-cache__pane--active .chat-bubble[data-message-id]",
                ),
              ].find((element) => element.dataset.messageId === key);
              probe.tops.push(bubble?.getBoundingClientRect().top ?? null);
              probe.frame = requestAnimationFrame(sample);
            };
            sample();
          },
          await anchor.getAttribute("data-message-id"),
        );
        await gateway.deferNext("chat.history");
        await gateway.resolveDeferred("chat.history");
        await expect.poll(count).toBe(1072);
        await expect
          .poll(() => thread.getByText("Read 1020 files", { exact: true }).isVisible())
          .toBe(true);
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
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
