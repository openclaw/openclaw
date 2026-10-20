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
type SendMotionFrame = { y: number | null; opacity: string | null; same: boolean };
type SendMotionScroll = { behavior?: ScrollBehavior; jump: number; remaining: number };
type SendMotionProbe = { frames: SendMotionFrame[]; scrolls: SendMotionScroll[]; stop: () => void };

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
      probe.frames.push({
        y: bubble?.getBoundingClientRect().top ?? null,
        opacity: bubble ? getComputedStyle(bubble).opacity : null,
        same: bubble === firstBubble,
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
    expect({
      noInstantJump: scrolls.every((scroll) => Math.abs(scroll.jump) <= 1),
      monotonic: visible.every((frame, index) => {
        const previous = visible[index - 1];
        return !previous || (frame.y !== null && previous.y !== null && frame.y <= previous.y + 1);
      }),
      // Check commands rather than frame counts: a loaded browser may skip intermediate frames.
      smoothFromDistance: scrolls.some(
        (scroll) => scroll.behavior === "smooth" && scroll.remaining > 8,
      ),
    }).toEqual({ noInstantJump: true, monotonic: true, smoothFromDistance: true });
    expect(endDistance).toBeLessThanOrEqual(8);
  }
}

declare global {
  interface Window {
    openclawMotionArrivals?: number;
    openclawSendMotion?: SendMotionProbe;
  }
}

suite.define(() => {
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
