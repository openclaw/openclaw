import { expect, it } from "vitest";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  newChatPage,
  textContent,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { layoutBox, twoFrames } from "./chat-presentation.test-support.ts";

const suite = createChatFlowE2eSuite();
type HistoryPane = HTMLElement & { state: { chatMessages: unknown[] } };
const historyPage = (messages: unknown[], nextOffset: number) => ({
  messages,
  nextOffset,
  hasMore: true,
  totalMessages: 2072,
  sessionId: "activity-history",
});

suite.define(() => {
  it.each([
    { width: 1440, split: false },
    { width: 390, split: false },
    { width: 1440, split: true },
  ])("anchors coalesced activity at $width px (split=$split)", async ({ width, split }) => {
    const page = await newChatPage(suite, {
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width, height: 900 },
    });
    const activity = (seq: number) => ({
      __openclaw: { id: `activity-${seq}`, seq, runId: `wake-${seq}` },
      role: "toolResult",
      toolCallId: `call-${seq}`,
      toolName: "read",
      content: textContent("Synthetic check completed."),
      timestamp: 1_800_000_000_000 + seq,
    });
    const recent = [
      ...Array.from({ length: 20 }, (_, index) => activity(1001 + index)),
      ...Array.from({ length: 52 }, (_, index) => ({
        __openclaw: { id: `message-${index}`, seq: 1021 + index },
        role: index % 2 ? "assistant" : "user",
        content: textContent(`Retained message ${index}. ${"History detail. ".repeat(8)}`),
        timestamp: 1_800_000_001_021 + index,
      })),
    ];
    const gateway = await installMockGateway(page, {
      sessions: [{ key: "agent:main:main", sessionId: "activity-history" }],
      heldMethods: ["chat.history"],
      methodResponses: {
        "chat.startup": historyPage(recent, 72),
        "chat.history": historyPage(
          Array.from({ length: 1000 }, (_, index) => activity(index + 1)),
          1072,
        ),
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    let pane = page.locator(".chat-pane-cache__pane--active");
    let thread = pane.locator(".chat-thread");
    await thread.getByText(/^Retained message 51\./).waitFor();
    if (split) {
      await selectChatLayoutAction(pane, "Open split view");
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
    // Let virtualization settle, then anchor the same retained bubble before delivery.
    const anchor = thread.locator(".chat-bubble").filter({ hasText: "Retained message 0." });
    await expect.poll(() => anchor.isVisible()).toBe(true);
    await page.keyboard.press("Home");
    await expect.poll(() => thread.evaluate((element) => element.scrollTop)).toBe(0);
    const count = () => pane.evaluate((element: HistoryPane) => element.state.chatMessages.length);
    expect(await count()).toBe(72);
    const before = await layoutBox(anchor);
    expect(before.y).toBeGreaterThan(0);
    const probe = await anchor.evaluateHandle((original) => {
      const host = original.closest("openclaw-chat-pane")!;
      const selector = `.chat-bubble[data-message-id="${CSS.escape(original.getAttribute("data-message-id")!)}"]`;
      const tops: Array<number | null> = [];
      let frame = 0;
      const sample = () => {
        const bubble = host.querySelector(selector);
        tops.push(bubble?.getBoundingClientRect().top ?? null);
        frame = requestAnimationFrame(sample);
      };
      sample();
      return () => {
        cancelAnimationFrame(frame);
        return tops;
      };
    });
    if (split) {
      const sibling = page.locator("openclaw-chat-pane.chat-split-view__pane").nth(0);
      await sibling.locator(".chat-pane__header").click();
      await expect
        .poll(() => pane.getAttribute("class"))
        .not.toContain("chat-pane-cache__pane--active");
    }
    await gateway.deferNext("chat.history");
    await gateway.resolveDeferred("chat.history");
    await expect.poll(count).toBe(1072);
    await twoFrames(page);
    const tops = await probe.evaluate((stop) => stop());
    await probe.dispose();
    expect(tops.length).toBeGreaterThan(1);
    expect(
      tops.every((top) => top !== null),
      "anchor stays mounted",
    ).toBe(true);
    const displacement = Math.max(...tops.map((top) => Math.abs(top! - before.y)));
    expect(displacement, "each frame must preserve the reading position").toBeLessThanOrEqual(1);
    expect(Math.abs((await anchor.boundingBox())!.y - before.y)).toBeLessThanOrEqual(1);
  });
});
