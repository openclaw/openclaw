import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  createChatFlowE2eSuite,
  chatMessage,
  installMockGateway,
  newChatPage,
  requireRecord,
  requireString,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
const suite = createChatFlowE2eSuite();
type SendMotionFrame = {
  y: number | null;
  opacity: string | null;
  same: boolean;
  height: number | null;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  blockTop: number | null;
  blockHeight: number | null;
  transform: string | null;
};
type SendMotionScroll = { behavior?: ScrollBehavior; jump: number; remaining: number };
type SendMotionProbe = { frames: SendMotionFrame[]; scrolls: SendMotionScroll[]; stop: () => void };
type FirstWheelProbe = {
  frames: Array<{
    connected: boolean;
    top: number;
    offset: number;
    extent: number;
    endGap: number;
  }>;
  shifts: number[];
  wheelAt: number;
  done: boolean;
  trusted: boolean;
};

async function observeSendMotion(page: Page, prompt: string) {
  await page.evaluate((text) => {
    const thread = document.querySelector<HTMLElement>(".chat-thread")!;
    const scrollTo = thread.scrollTo.bind(thread);
    const probe: SendMotionProbe = { frames: [], scrolls: [], stop: () => {} };
    window.openclawSendMotion = probe;
    let firstBubble: HTMLElement | undefined;
    let frame = 0;
    // Native smooth scrolling moves asynchronously. An immediate offset change
    // exposes a competing instant command even if it happens between paints.
    thread.scrollTo = function (options?: ScrollToOptions | number, y?: number) {
      const before = this.scrollTop;
      const remaining = this.scrollHeight - before - this.clientHeight;
      if (typeof options === "number") {
        scrollTo(options, y ?? 0);
      } else {
        scrollTo(options);
      }
      probe.scrolls.push({
        behavior: typeof options === "number" ? undefined : options?.behavior,
        jump: this.scrollTop - before,
        remaining,
      });
    };
    const sample = () => {
      const bubble = [...thread.querySelectorAll<HTMLElement>(".chat-bubble")].find(
        (element) => element.dataset.messageText === text,
      );
      firstBubble ??= bubble;
      const block = bubble?.closest<HTMLElement>(".chat-virtual-block");
      const bounds = bubble?.getBoundingClientRect();
      const style = bubble ? getComputedStyle(bubble) : undefined;
      probe.frames.push({
        y: bounds?.top ?? null,
        opacity: style?.opacity ?? null,
        same: bubble === firstBubble,
        height: bounds?.height ?? null,
        scrollTop: thread.scrollTop,
        scrollHeight: thread.scrollHeight,
        clientHeight: thread.clientHeight,
        blockTop: block?.getBoundingClientRect().top ?? null,
        blockHeight: block?.getBoundingClientRect().height ?? null,
        transform: style?.transform ?? null,
      });
      frame = requestAnimationFrame(sample);
    };
    probe.stop = () => {
      cancelAnimationFrame(frame);
      thread.scrollTo = scrollTo;
    };
    sample();
  }, prompt);
}

async function finishSendMotion(page: Page, reducedMotion: string) {
  const { frames, scrolls, endDistance } = await page.evaluate(() => {
    const probe = window.openclawSendMotion!;
    probe.stop();
    const thread = document.querySelector<HTMLElement>(".chat-thread")!;
    return {
      frames: probe.frames,
      scrolls: probe.scrolls,
      endDistance: thread.scrollHeight - thread.scrollTop - thread.clientHeight,
    };
  });
  const visible = frames.slice(frames.findIndex((frame) => frame.y !== null));
  expect(visible.length).toBeGreaterThan(0);
  expect(visible.every((frame) => frame.y !== null && frame.opacity === "1" && frame.same)).toBe(
    true,
  );
  if (reducedMotion !== "reduce") {
    expect(
      {
        noInstantJump: scrolls.every((scroll) => Math.abs(scroll.jump) <= 1),
        monotonic: visible.every((frame, index) => {
          const previous = visible[index - 1];
          return (
            !previous || (frame.y !== null && previous.y !== null && frame.y <= previous.y + 1)
          );
        }),
        // Check commands rather than frame counts: a loaded browser may skip intermediate frames.
        smoothFromDistance: scrolls.some(
          (scroll) => scroll.behavior === "smooth" && scroll.remaining > 8,
        ),
      },
      JSON.stringify({
        scrolls,
        endDistance,
        frames,
        reversals: visible.flatMap((frame, index) => {
          const previous = visible[index - 1];
          return previous && frame.y !== null && previous.y !== null && frame.y > previous.y + 1
            ? [{ previous, frame }]
            : [];
        }),
      }),
    ).toEqual({ noInstantJump: true, monotonic: true, smoothFromDistance: true });
    expect(endDistance).toBeLessThanOrEqual(8);
  }
}

declare global {
  interface Window {
    openclawMotionArrivals?: number;
    openclawSendMotion?: SendMotionProbe;
    openclawFirstWheel?: FirstWheelProbe;
  }
}

suite.define(() => {
  it("keeps visible transcript rows steady when the first wheel admits earlier rows", async () => {
    const page = await newChatPage(suite, {
      viewport: { width: 1719, height: 1179 },
      reducedMotion: "reduce",
    });
    const now = Date.now();
    await installMockGateway(page, {
      historyMessages: Array.from({ length: 240 }, (_, index) =>
        chatMessage(
          index % 2 ? "assistant" : "user",
          `### Geometry message ${index + 1}\n\n${"Keep the visible conversation steady while earlier rows are measured. ".repeat(5)}`,
          {
            timestamp: now - (240 - index) * 60_000,
            __openclaw: { id: "geometry-" + index, seq: index + 1 },
          },
        ),
      ),
    });
    await page.goto(suite.server.baseUrl + "chat");
    const lastMessage = page
      .locator(".chat-pane-cache__pane--active .chat-virtual-row")
      .getByText("Geometry message 240", {
        exact: true,
      });
    await lastMessage.waitFor();
    await waitForChatScrollIdle(page);
    await page.locator('aside.sidebar[data-snapshot-saved="true"]').waitFor();
    await page.reload();
    await lastMessage.waitFor();
    await waitForChatScrollIdle(page);
    const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
    await thread.hover();
    await thread.evaluate((element) => {
      const viewport = element.getBoundingClientRect();
      const anchor = [...element.querySelectorAll<HTMLElement>(".chat-virtual-row")].find((row) => {
        const bounds = row.getBoundingClientRect();
        return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
      });
      if (!anchor) {
        throw new Error("No visible transcript row to retain");
      }
      const probe: FirstWheelProbe = {
        frames: [],
        shifts: [],
        wheelAt: 0,
        done: false,
        trusted: false,
      };
      window.openclawFirstWheel = probe;
      const sample = () => {
        probe.frames.push({
          connected: element.contains(anchor),
          top: anchor.getBoundingClientRect().top - viewport.top,
          offset: element.scrollTop,
          extent: element.scrollHeight,
          endGap: element.scrollHeight - element.clientHeight - element.scrollTop,
        });
      };
      const collectShifts = (entries: PerformanceEntryList) => {
        probe.shifts.push(
          ...entries
            .filter((entry) => probe.wheelAt > 0 && entry.startTime >= probe.wheelAt)
            .map((entry) => entry.startTime),
        );
      };
      const observer = new PerformanceObserver((entries) => collectShifts(entries.getEntries()));
      observer.observe({ type: "layout-shift" });
      sample();
      element.addEventListener(
        "wheel",
        (event) => {
          probe.trusted = event.isTrusted;
          probe.wheelAt = performance.now();
          sample();
          let frames = 0;
          const nextFrame = () => {
            sample();
            if (++frames < 12) {
              requestAnimationFrame(nextFrame);
            } else {
              collectShifts(observer.takeRecords());
              observer.disconnect();
              probe.done = true;
            }
          };
          requestAnimationFrame(nextFrame);
        },
        { once: true, capture: true },
      );
    });
    await page.mouse.wheel(0, 40);
    await page.waitForFunction(() => window.openclawFirstWheel?.done === true);
    const observed = await page.evaluate(() => window.openclawFirstWheel!);
    const before = observed.frames[0]!;
    expect(observed.trusted).toBe(true);
    // A frame can compensate after a painted shift; include recent-input entries too.
    expect(observed.shifts).toEqual([]);
    expect(
      observed.frames.every(
        (frame) =>
          frame.connected &&
          Math.abs(frame.top - before.top) <= 1.5 &&
          Math.abs(frame.endGap) <= 1.5 &&
          Math.abs(frame.offset - before.offset - (frame.extent - before.extent)) <= 1.5,
      ),
      JSON.stringify(observed.frames),
    ).toBe(true);
  });

  it.each<{
    name: string;
    lines?: number;
    width?: number;
    height?: number;
    reducedMotion?: "reduce" | "no-preference";
  }>([
    { name: "desktop", lines: 1 },
    { name: "multiline" },
    { name: "mobile", width: 390, height: 844 },
    { name: "reduced-motion", reducedMotion: "reduce" as const },
  ])(
    "animates new prompts without hiding streamed replies on $name",
    async ({ width = 1280, height = 900, lines = 8, reducedMotion = "no-preference" }) => {
      const page = await newChatPage(suite, {
        viewport: { width, height },
        reducedMotion,
      });
      await page.addInitScript(() => {
        window.openclawMotionArrivals = 0;
        document.addEventListener("animationstart", (event) => {
          if (
            event.animationName !== "chat-message-enter" ||
            !(event.target instanceof HTMLElement)
          ) {
            return;
          }
          window.openclawMotionArrivals!++;
        });
      });
      const gateway = await installMockGateway(page, {
        historyMessages: Array.from({ length: 40 }, (_, index) =>
          chatMessage(
            index % 2 ? "assistant" : "user",
            `Existing message ${index}\nA retained conversation with enough detail to scroll.`,
            {
              timestamp: Date.now() - (40 - index) * 60_000,
              __openclaw: { id: "old-" + index, seq: index + 1 },
            },
          ),
        ),
      });
      await page.goto(suite.server.baseUrl + "chat");
      await page.getByText("Existing message 39", { exact: false }).waitFor();
      await waitForChatScrollIdle(page);
      expect(await page.evaluate(() => window.openclawMotionArrivals)).toBe(0);
      const prompt =
        "Make this feel fast and smooth" + "\nKeep every detail steady.".repeat(lines - 1);
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await waitForChatScrollIdle(page);
      await gateway.deferNext("chat.send");
      await observeSendMotion(page, prompt);
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      const request = await gateway.waitForRequest("chat.send");
      const runId = requireString(requireRecord(request.params).idempotencyKey, "run id");
      await gateway.resolveDeferred("chat.send");
      const sendBubble = page
        .locator(".chat-bubble")
        .filter({ hasText: "Make this feel fast and smooth" });
      await expect.poll(() => sendBubble.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
      await waitForChatScrollIdle(page);
      await finishSendMotion(page, reducedMotion);
      let text = "A responsive reply, without a jump.";
      const emit = async () =>
        gateway.emitGatewayEvent("chat", {
          sessionKey: "main",
          runId,
          state: "delta",
          message: chatMessage("assistant", text, { timestamp: Date.now() }),
        });
      for (let index = 0; index < 4; index++) {
        if (index > 0) {
          text += " More streaming text.";
        }
        await emit();
        await page.locator(".chat-bubble").getByText(text, { exact: true }).waitFor();
      }
      await waitForChatScrollIdle(page);
      expect(await page.evaluate(() => window.openclawMotionArrivals)).toBe(
        reducedMotion === "reduce" ? 0 : 1,
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    },
  );
});
