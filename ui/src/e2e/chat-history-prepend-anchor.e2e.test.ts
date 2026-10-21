import { expect, it } from "vitest";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  newChatPage,
  waitForChatScrollIdle,
  waitForRequests,
} from "./chat-flow.test-support.ts";
import { layoutBox, twoFrames } from "./chat-presentation.test-support.ts";

const suite = createChatFlowE2eSuite();
type AnchorFrames = { frame: number; positions: Array<number | null>; readerDelta: number };
type AnchorWindow = typeof window & { prependFrames: AnchorFrames };

function touchGesture(
  element: Element,
  { start, momentum }: { start: boolean; momentum: boolean },
) {
  const thread = element as HTMLElement;
  const move = (delta: number) => {
    (window as AnchorWindow).prependFrames.readerDelta += delta;
    thread.scrollTop += delta;
    thread.dispatchEvent(new Event("scroll"));
  };
  if (start && momentum) {
    // Model browsers that release momentum through idle, not scrollend.
    thread.addEventListener("scrollend", (event) => event.stopImmediatePropagation(), {
      capture: true,
    });
  }
  if (!start && momentum) {
    move(10);
  }
  const contact = [new Touch({ identifier: 1, target: thread })];
  thread.dispatchEvent(
    new TouchEvent(start ? "touchstart" : "touchend", {
      changedTouches: contact,
      bubbles: true,
      ...(start ? { touches: contact, targetTouches: contact } : {}),
    }),
  );
  // End-contact movement, release and momentum stay in one browser task.
  if (momentum) {
    move(start ? 20 : 10);
  }
}

suite.define(() => {
  it("recalls older prompts after returning to the draft", async () => {
    const page = await newChatPage(suite, {
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const prompts: Record<number, string> = {
      1: "Earlier prompt",
      3: "Recent prompt",
      81: "Latest prompt",
    };
    const message = (seq: number) => ({
      __openclaw: { id: `recall-${seq}`, seq },
      role: prompts[seq] ? "user" : "assistant",
      content: [
        {
          type: "text",
          text: prompts[seq] ?? `History entry ${seq}. ${"History detail. ".repeat(20)}`,
        },
      ],
      timestamp: 1_800_000_000_000 + seq,
    });
    const gateway = await installMockGateway(page, {
      sessionKey: "agent:main:main",
      sessions: [{ key: "agent:main:main", sessionId: "recall-session" }],
      methodResponses: {
        "chat.startup": {
          messages: Array.from({ length: 80 }, (_, index) => message(index + 3)),
          hasMore: true,
          nextOffset: 80,
          totalMessages: 82,
          sessionId: "recall-session",
        },
        "chat.history": {
          messages: [message(1), message(2)],
          hasMore: false,
          totalMessages: 82,
          sessionId: "recall-session",
        },
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    const pane = page.locator(".chat-pane-cache__pane--active");
    const thread = pane.locator(".chat-thread");
    const textarea = pane.locator(".agent-chat__composer-combobox textarea");
    await thread.getByText(/^History entry 82\./).waitFor();
    await waitForChatScrollIdle(page);
    expect(await gateway.getRequests("chat.history")).toHaveLength(0);
    await textarea.press("ArrowUp");
    await expect.poll(() => textarea.inputValue()).toBe("Latest prompt");
    await textarea.press("ArrowDown");
    await expect.poll(() => textarea.inputValue()).toBe("");

    await gateway.deferNext("chat.history");
    await thread.hover();
    await page.mouse.wheel(0, -1_000_000);
    await waitForRequests(gateway, "chat.history", 1);
    await gateway.resolveDeferred("chat.history");
    await waitForChatScrollIdle(page);
    await thread.hover();
    await page.mouse.wheel(0, -1_000_000);
    await thread.getByText("Earlier prompt", { exact: true }).waitFor();
    const requests = await gateway.getRequests("chat.history");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.params).toMatchObject({ offset: 80 });
    await textarea.press("ArrowUp");
    await expect.poll(() => textarea.inputValue()).toBe("Latest prompt");
    await textarea.press("ArrowUp");
    await expect.poll(() => textarea.inputValue()).toBe("Recent prompt");
    await textarea.press("ArrowUp");
    await expect.poll(() => textarea.inputValue()).toBe("Earlier prompt");
    await textarea.press("ArrowDown");
    await expect.poll(() => textarea.inputValue()).toBe("Recent prompt");
    await textarea.press("ArrowDown");
    await expect.poll(() => textarea.inputValue()).toBe("Latest prompt");
    await textarea.press("ArrowDown");
    await expect.poll(() => textarea.inputValue()).toBe("");
  });

  it.each(
    [
      {},
      { sharedGroup: true },
      { manual: true },
      { sharedGroup: true, manual: true },
      { sharedGroup: true, onlyGroup: true },
      { sharedGroup: true, onlyGroup: true, more: true },
      { sharedGroup: true, onlyGroup: true, persisted: false },
      { sharedGroup: true, more: true, activeTouch: true },
      { sharedGroup: true, more: true, activeTouch: true, momentum: true },
    ].map((row) =>
      Object.assign({ sharedGroup: false, manual: false, onlyGroup: false, more: false }, row),
    ),
  )(
    "anchors history prepend (shared=$sharedGroup, manual=$manual, onlyGroup=$onlyGroup, more=$more, persisted=$persisted, touch=$activeTouch, momentum=$momentum)",
    async ({
      sharedGroup,
      manual,
      onlyGroup,
      more,
      persisted = true,
      activeTouch = false,
      momentum = false,
    }) => {
      const page = await newChatPage(suite, {
        locale: "en-US",
        serviceWorkers: "block",
        hasTouch: activeTouch,
        userAgent: activeTouch
          ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"
          : undefined,
        viewport: { height: 900, width: 1280 },
      });
      const detail = "History detail for the reader. ".repeat(8);
      const message = (seq: number) => ({
        __openclaw: { ...(persisted ? { id: `prepend-${seq}` } : {}), seq },
        role:
          sharedGroup && seq >= 995 && seq <= 1005 ? "assistant" : seq % 2 ? "user" : "assistant",
        content: [{ type: "text", text: `Transcript entry ${seq}. ${detail}` }],
        timestamp: 1_800_000_000_000 + seq,
      });
      const recent = Array.from({ length: 800 }, (_, index) => message(index + 1001));
      const older = Array.from({ length: onlyGroup ? 6 : 1000 }, (_, index) =>
        message(index + (onlyGroup ? 995 : 1)),
      );
      const loadedCount = recent.length + older.length;
      const totalMessages = loadedCount + (more ? 10 : 0);
      const history = (messages: typeof recent, hasMore: boolean, nextOffset: number) => ({
        messages,
        hasMore,
        nextOffset,
        totalMessages,
        sessionId: "prepend-session",
      });
      const gateway = await installMockGateway(page, {
        sessionKey: "agent:main:main",
        sessions: [{ key: "agent:main:main", sessionId: "prepend-session" }],
        methodResponses: {
          "chat.startup": history(recent, true, 800),
          "chat.history": history(older, more, loadedCount),
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const pane = page.locator(".chat-pane-cache__pane--active");
      const thread = pane.locator(".chat-thread");
      await thread.getByText(/^Transcript entry 1800\./).waitFor();
      await waitForChatScrollIdle(page);
      await gateway.deferNext("chat.history");
      await thread.hover();
      await page.mouse.wheel(0, -1_000_000);
      await waitForRequests(gateway, "chat.history", 1);
      if (manual) {
        // Failed auto-loading exposes retry without another upward gesture.
        await gateway.rejectDeferred("chat.history", {
          message: "History temporarily unavailable",
        });
        const showEarlier = thread.getByRole("button", { name: "Show earlier", exact: true });
        await expect.poll(() => showEarlier.isEnabled()).toBe(true);
        await gateway.deferNext("chat.history");
        await showEarlier.click();
        await waitForRequests(gateway, "chat.history", 2);
      }
      await waitForChatScrollIdle(page);
      const anchor = thread.locator(".chat-bubble").filter({ hasText: "Transcript entry 1001." });
      await anchor.waitFor();
      const before = await layoutBox(anchor);
      await page.evaluate(
        (messageKey) => {
          const frames: AnchorFrames = { frame: 0, positions: [], readerDelta: 0 };
          (window as AnchorWindow).prependFrames = frames;
          const sample = () => {
            const bubble = document.querySelector<HTMLElement>(
              `.chat-pane-cache__pane--active .chat-bubble[data-message-id="${CSS.escape(messageKey!)}"]`,
            );
            frames.positions.push(
              bubble ? bubble.getBoundingClientRect().top + frames.readerDelta : null,
            );
            frames.frame = requestAnimationFrame(sample);
          };
          sample();
        },
        await anchor.getAttribute("data-message-id"),
      );
      const scrollTop = () => thread.evaluate((element) => element.scrollTop);
      const heldOffset = await scrollTop();
      if (activeTouch) {
        await thread.evaluate(touchGesture, { start: true, momentum });
      }
      await gateway.resolveDeferred("chat.history");
      await expect
        .poll(() =>
          pane.evaluate(
            (element) =>
              (element as HTMLElement & { state: { chatMessages: unknown[] } }).state.chatMessages
                .length,
          ),
        )
        .toBe(loadedCount);
      if (activeTouch) {
        await twoFrames(page); // Let the projection commit before checking touch deferral.
        expect(
          await scrollTop(),
          "a history prepend must not write the scroll offset during an active touch",
        ).toBe(heldOffset + (momentum ? 20 : 0));
        await thread.evaluate(touchGesture, { start: false, momentum });
      }
      await waitForChatScrollIdle(page);
      // Require the fetched page to reach the viewport, not just pane state.
      await expect.poll(scrollTop).toBeGreaterThan(heldOffset + (momentum ? 40 : 0) + 100);
      const frames = await page.evaluate(() => {
        const probe = (window as AnchorWindow).prependFrames;
        cancelAnimationFrame(probe.frame);
        return probe.positions;
      });
      const after = await layoutBox(anchor);
      expect(
        Math.abs(after.y + (momentum ? 40 : 0) - before.y),
        "loading older history must not move the message being read",
      ).toBeLessThanOrEqual(2);
      expect(frames.length).toBeGreaterThan(1);
      expect(
        frames.every((top) => top !== null && Math.abs(top - before.y) <= 2),
        "the message must stay anchored at every animation frame, not just after settling",
      ).toBe(true);
      if (!more && !onlyGroup) {
        await thread.hover();
        await page.mouse.wheel(0, -1_000_000);
        await waitForChatScrollIdle(page);
        const first = thread.getByText(/^Transcript entry 1\./);
        await first.waitFor();
        const firstBox = await layoutBox(first);
        const viewport = await layoutBox(thread);
        expect(firstBox.y).toBeGreaterThanOrEqual(viewport.y - 2);
        expect(firstBox.y).toBeLessThan(viewport.y + viewport.height);
        await pane.locator(".chat-history-sentinel").waitFor({ state: "detached" });
        expect((await gateway.getRequests("chat.history")).length).toBe(manual ? 2 : 1);
      }
    },
  );
});
