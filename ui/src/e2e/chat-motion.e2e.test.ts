import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
const suite = createChatFlowE2eSuite();
const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR;
type MotionArrival = { text: string; opacity: string; transform: string };
type SendMotionFrame = { top: number; y: number | null; opacity: string | null; same: boolean };
// `jump` is the offset change applied synchronously by the call; `remaining` is
// the distance to the end when it was issued.
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
        top: thread.scrollTop,
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
    expect(
      scrolls.every((scroll) => Math.abs(scroll.jump) <= 1),
      JSON.stringify(scrolls),
    ).toBe(true);
    expect(
      visible.every((frame, index) => {
        const previous = visible[index - 1];
        return !previous || (frame.y !== null && previous.y !== null && frame.y <= previous.y + 1);
      }),
      JSON.stringify(visible),
    ).toBe(true);
    // Counting sampled offsets measures the runner's frame rate: under load the
    // browser finishes the time-based smooth scroll between two rAF samples.
    // Assert the page's side instead: a smooth scroll that starts away from the
    // end, with no instant command, carries the viewport to the end.
    expect(
      scrolls.some((scroll) => scroll.behavior === "smooth" && scroll.remaining > 8),
      JSON.stringify(scrolls),
    ).toBe(true);
    expect(endDistance).toBeLessThanOrEqual(8);
  }
}

declare global {
  interface Window {
    openclawMotionArrivals?: MotionArrival[];
    openclawSendMotion?: SendMotionProbe;
  }
}

suite.define(() => {
  it.each([
    {
      name: "desktop",
      width: 1280,
      height: 900,
      lines: 1,
      reducedMotion: "no-preference" as const,
    },
    {
      name: "multiline",
      width: 1280,
      height: 900,
      lines: 8,
      reducedMotion: "no-preference" as const,
    },
    { name: "mobile", width: 390, height: 844, lines: 8, reducedMotion: "no-preference" as const },
    {
      name: "reduced-motion",
      width: 1280,
      height: 900,
      lines: 8,
      reducedMotion: "reduce" as const,
    },
  ])(
    "animates new prompts without hiding streamed replies on $name",
    async ({ name, width, height, lines, reducedMotion }) => {
      const viewport = { width, height };
      const dir = createControlUiE2eArtifactDir(`chat-motion-${name}`, artifactDir);
      const context = await suite.newBrowserContext({
        viewport,
        reducedMotion,
        ...(dir ? { recordVideo: { dir, size: viewport } } : {}),
      });
      const page = await context.newPage();
      await page.addInitScript(() => {
        const arrivals: MotionArrival[] = [];
        window.openclawMotionArrivals = arrivals;
        document.addEventListener("animationstart", (event) => {
          if (
            event.animationName !== "chat-message-enter" ||
            !(event.target instanceof HTMLElement)
          ) {
            return;
          }
          const style = getComputedStyle(event.target);
          arrivals.push({
            text: event.target.dataset.messageText ?? "",
            opacity: style.opacity,
            transform: style.transform,
          });
        });
      });
      const gateway = await installMockGateway(page, {
        historyMessages: Array.from({ length: 40 }, (_, index) => ({
          role: index % 2 ? "assistant" : "user",
          content: [
            {
              type: "text",
              text:
                "Existing message " +
                index +
                "\nA retained conversation with enough detail to scroll.",
            },
          ],
          timestamp: Date.now() - (40 - index) * 60_000,
          __openclaw: { id: "old-" + index, seq: index + 1 },
        })),
      });
      try {
        await page.goto(suite.server.baseUrl + "chat");
        await page.getByText("Existing message 39", { exact: false }).waitFor();
        await waitForChatScrollIdle(page);
        expect(await page.evaluate(() => window.openclawMotionArrivals)).toHaveLength(0);
        if (dir) {
          await page.screenshot({ path: path.join(dir, "01-history.png") });
        }
        const prompt =
          "Make this feel fast and smooth" + "\nKeep every detail steady.".repeat(lines - 1);
        await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
        await waitForChatScrollIdle(page);
        await gateway.deferNext("chat.send");
        await observeSendMotion(page, prompt);
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const request = await gateway.waitForRequest("chat.send");
        const runId = requireString(requireRecord(request.params).idempotencyKey, "run id");
        const expected = reducedMotion === "reduce" ? 0 : 1;
        await gateway.resolveDeferred("chat.send");
        const sendBubble = page
          .locator(".chat-bubble")
          .filter({ hasText: "Make this feel fast and smooth" });
        await expect
          .poll(() => sendBubble.evaluate((el) => getComputedStyle(el).opacity))
          .toBe("1");
        await waitForChatScrollIdle(page);
        await finishSendMotion(page, reducedMotion);
        if (dir) {
          await page.screenshot({ path: path.join(dir, "02-prompt.png") });
        }
        let text = "A responsive reply, without a jump.";
        const emit = async () =>
          gateway.emitGatewayEvent("chat", {
            sessionKey: "main",
            runId,
            state: "delta",
            message: {
              role: "assistant",
              content: [{ type: "text", text }],
              timestamp: Date.now(),
            },
          });
        await emit();
        await page.locator(".chat-bubble").getByText(text, { exact: true }).waitFor();
        for (let index = 0; index < 3; index++) {
          text += " More streaming text.";
          await emit();
          await page.locator(".chat-bubble").getByText(text, { exact: true }).waitFor();
        }
        await waitForChatScrollIdle(page);
        if (dir) {
          await page.screenshot({ path: path.join(dir, "03-reply.png") });
        }
        expect(await page.evaluate(() => window.openclawMotionArrivals)).toHaveLength(expected);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
