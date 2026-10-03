import type { CDPSession, Page } from "playwright";
import { expect, it } from "vitest";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

// Pages split some agent runs, so a landing page regroups the run it joins.
const PAGE_SIZE = 42;
const TOTAL_MESSAGES = 160;
// This older page stays in flight while the reader turns around.
const HELD_OFFSET = PAGE_SIZE * 2;
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";

type JumpSample = {
  frame: number;
  messageId: string;
  jump: number;
  scrollTop: number;
  scrollHeight: number;
  median: number;
  programmatic: number;
  rows: number;
};
type JumpProbe = { frame: number; samples: JumpSample[]; programmatic: number; stop: boolean };
type ProbeWindow = typeof window & { scrollbackProbe: JumpProbe };

/** One agent turn: question, tool run, and a markdown answer with code and sometimes an image. */
function turnMessages(turn: number) {
  const seq = turn * 4;
  const runId = `scrollback-run-${turn}`;
  const at = (offset: number) => Date.UTC(2026, 8, 1, 12, 0, 0) + (seq + offset) * 1000;
  const codeLines = Array.from(
    { length: 4 + (turn % 5) * 6 },
    (_, line) => `const value${line} = compute(${turn}, ${line});`,
  ).join("\n");
  return [
    {
      role: "user",
      content: `Turn ${turn} question. ${"Please look into this part of the project. ".repeat(1 + (turn % 3) * 3)}`,
      timestamp: at(0),
      __openclaw: { id: `scrollback-${seq}`, seq, idempotencyKey: `${runId}:user` },
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: `Turn ${turn}: checking the workspace first.` },
        {
          type: "toolCall",
          id: `call-${turn}`,
          name: "exec",
          arguments: { command: `ls -la src/turn-${turn}` },
        },
      ],
      timestamp: at(1),
      __openclaw: { id: `scrollback-${seq + 1}`, seq: seq + 1, runId },
    },
    {
      role: "toolResult",
      toolCallId: `call-${turn}`,
      toolName: "exec",
      content: [{ type: "text", text: `file-${turn}.ts\n`.repeat(3 + (turn % 4) * 5) }],
      timestamp: at(2),
      __openclaw: { id: `scrollback-${seq + 2}`, seq: seq + 2, runId },
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: [
            `## Turn ${turn} answer`,
            "",
            ...Array.from(
              { length: 2 + (turn % 4) },
              (_, item) => `- Finding ${item} for turn ${turn}.`,
            ),
            "",
            "```ts",
            codeLines,
            "```",
            "",
            `Done with turn ${turn}. ${"More detail follows here. ".repeat(turn % 6)}`,
          ].join("\n"),
        },
        ...(turn % 3 === 0
          ? [
              {
                type: "image",
                // Portrait images decode to a different box than the placeholder.
                url: `media://inbound/scrollback-${turn}${turn % 2 === 0 ? "-portrait" : ""}.svg`,
                alt: `Chart ${turn}`,
              },
            ]
          : []),
      ],
      timestamp: at(3),
      __openclaw: { id: `scrollback-${seq + 3}`, seq: seq + 3, runId },
    },
  ];
}

const allMessages = Array.from({ length: TOTAL_MESSAGES / 4 }, (_, turn) =>
  turnMessages(turn),
).flat();

function historyPage(offset: number) {
  const end = TOTAL_MESSAGES - offset;
  const start = Math.max(0, end - PAGE_SIZE);
  const nextOffset = offset + (end - start);
  return {
    messages: allMessages.slice(start, end),
    hasMore: start > 0,
    nextOffset,
    totalMessages: TOTAL_MESSAGES,
    sessionId: "scrollback-session",
  };
}

async function installJumpProbe(page: Page): Promise<void> {
  await page.locator(".chat-pane-cache__pane--active .chat-thread").evaluate((element) => {
    const thread = element as HTMLElement;
    const probe: JumpProbe = { frame: 0, samples: [], programmatic: 0, stop: false };
    (window as ProbeWindow).scrollbackProbe = probe;
    // Native reader input moves scrollTop without these calls. Everything the
    // page writes itself is compensation and must match the layout shift.
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
    const record = (write: () => void) => {
      const before = descriptor.get!.call(thread) as number;
      write();
      probe.programmatic += (descriptor.get!.call(thread) as number) - before;
    };
    Object.defineProperty(thread, "scrollTop", {
      configurable: true,
      get: () => descriptor.get!.call(thread),
      set: (value: number) => record(() => descriptor.set!.call(thread, value)),
    });
    for (const name of ["scrollTo", "scroll", "scrollBy"] as const) {
      const original = Element.prototype[name];
      thread[name] = ((...args: Parameters<typeof original>) =>
        record(() => original.apply(thread, args))) as typeof original;
    }
    // The reader looks at the first message or text block starting in view.
    // Media below it may grow in place; nothing above it may move it.
    const readable =
      ".chat-bubble[data-message-id], .chat-bubble :is(p, pre, li, h1, h2, h3, h4, h5, h6, table, blockquote)";
    let previous = new Map<Element, number>();
    let firstVisible: Element | null = null;
    const sample = () => {
      if (probe.stop) {
        return;
      }
      const view = thread.getBoundingClientRect();
      const scrollTop = thread.scrollTop;
      const offsets = new Map<Element, number>();
      let nextFirst: Element | null = null;
      for (const block of thread.querySelectorAll(readable)) {
        const rect = block.getBoundingClientRect();
        if (rect.bottom > view.top && rect.top < view.bottom) {
          // Position in scroll-content coordinates.
          offsets.set(block, rect.top - view.top + scrollTop);
          if (nextFirst === null && rect.top >= view.top - 1) {
            nextFirst = block;
          }
        }
      }
      if (firstVisible !== null && previous.has(firstVisible) && offsets.has(firstVisible)) {
        const shift = offsets.get(firstVisible)! - previous.get(firstVisible)!;
        const shifts = [...offsets]
          .filter(([block]) => previous.has(block))
          .map(([block, top]) => top - previous.get(block)! - probe.programmatic)
          .toSorted((a, b) => a - b);
        const bubble = firstVisible.closest<HTMLElement>(".chat-bubble[data-message-id]");
        probe.samples.push({
          frame: probe.frame,
          messageId: `${bubble?.dataset.messageId} ${firstVisible.tagName.toLowerCase()}`,
          jump: shift - probe.programmatic,
          scrollTop,
          scrollHeight: thread.scrollHeight,
          median: shifts[Math.floor(shifts.length / 2)] ?? 0,
          programmatic: probe.programmatic,
          rows: thread.querySelectorAll(".chat-virtual-row").length,
        });
      }
      probe.programmatic = 0;
      previous = offsets;
      firstVisible = nextFirst;
      probe.frame += 1;
    };
    // Sample after the frame's ResizeObserver compensation, i.e. what the
    // reader actually sees painted, not the transient layout before it.
    const ticker = document.createElement("div");
    ticker.style.cssText = "position: fixed; top: 0; left: 0; height: 1px; pointer-events: none";
    document.body.append(ticker);
    new ResizeObserver(sample).observe(ticker);
    const tick = () => {
      if (probe.stop) {
        ticker.remove();
        return;
      }
      ticker.style.width = probe.frame % 2 ? "1px" : "2px";
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function readJumps(page: Page) {
  const samples = await page.evaluate(() => {
    const probe = (window as ProbeWindow).scrollbackProbe;
    probe.stop = true;
    return probe.samples;
  });
  const jumps = samples.filter((sample) => Math.abs(sample.jump) > 2);
  return {
    frames: samples.length,
    jumpFrames: jumps.length,
    maxJump: Math.max(0, ...samples.map((sample) => Math.abs(sample.jump))),
    totalJump: Math.round(jumps.reduce((sum, sample) => sum + Math.abs(sample.jump), 0)),
    worst: jumps.toSorted((left, right) => Math.abs(right.jump) - Math.abs(left.jump)).slice(0, 8),
  };
}

async function loadedMessages(page: Page): Promise<number> {
  return page
    .locator(".chat-pane-cache__pane--active")
    .evaluate(
      (element) =>
        (element as HTMLElement & { state: { chatMessages: unknown[] } }).state.chatMessages.length,
    );
}

async function nextFrames(page: Page, count: number): Promise<void> {
  await page.evaluate(
    (frames) =>
      new Promise<void>((resolve) => {
        let left = frames;
        const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    count,
  );
}

type Box = { x: number; y: number; width: number; height: number };

/** A quick drag that releases while moving, so the browser continues it as a fling. */
async function touchFling(cdp: CDPSession, box: Box, direction: "older" | "newer"): Promise<void> {
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height * (direction === "older" ? 0.15 : 0.85));
  const step = direction === "older" ? 60 : -60;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let move = 1; move <= 8; move += 1) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: y + move * step }],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

suite.define(() => {
  it.each([
    { name: "desktop wheel", mobile: false },
    { name: "iPhone touch flings", mobile: true },
    { name: "iPhone touch flings, iOS 26 and older", mobile: true, oldIos: true },
  ])(
    "keeps the message being read still while scrolling up through older pages ($name)",
    async ({ mobile, oldIos }) => {
      const options = {
        locale: "en-US",
        serviceWorkers: "block" as const,
        ...(mobile
          ? {
              hasTouch: true,
              isMobile: true,
              userAgent: IPHONE_UA,
              viewport: { width: 390, height: 844 },
            }
          : { viewport: { width: 1280, height: 900 } }),
      };
      await suite.withPage(options, async ({ context, page }) => {
        if (oldIos) {
          // Safari before 27 has no overflow-anchor, which selects the path
          // where scroll writes would stop a momentum fling.
          await page.addInitScript(() => {
            const supports = CSS.supports.bind(CSS);
            CSS.supports = ((...args: [string, string?]) =>
              args[0] === "overflow-anchor"
                ? false
                : supports(...(args as [string, string]))) as typeof CSS.supports;
          });
        }
        // Images arrive after their rows mount, like a real network: each
        // request is held until the next scroll step releases it.
        const heldImages: Array<() => Promise<void>> = [];
        const releaseImages = async () => {
          await Promise.all(heldImages.splice(0).map((release) => release()));
        };
        await page.route("**/__openclaw__/assistant-media?**", async (route) => {
          const url = new URL(route.request().url());
          if (url.searchParams.get("meta") === "1") {
            await route.fulfill({
              json: {
                available: true,
                mediaTicket: "scrollback-ticket",
                mediaTicketExpiresAt: new Date(Date.now() + 300_000).toISOString(),
              },
            });
            return;
          }
          const [width, height] = url.href.includes("portrait") ? [320, 480] : [480, 320];
          heldImages.push(() =>
            route.fulfill({
              contentType: "image/svg+xml",
              body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#4a7"/></svg>`,
            }),
          );
        });
        const gateway = await installMockGateway(page, {
          sessionKey: "agent:main:main",
          sessions: [{ key: "agent:main:main", sessionId: "scrollback-session" }],
          methodResponses: {
            "chat.startup": historyPage(0),
            "chat.history": {
              cases: Array.from({ length: Math.ceil(TOTAL_MESSAGES / PAGE_SIZE) }, (_, index) => ({
                match: { offset: index * PAGE_SIZE },
                response: historyPage(index * PAGE_SIZE),
              })),
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
        await thread.getByText(`Done with turn ${TOTAL_MESSAGES / 4 - 1}.`).waitFor();
        await releaseImages();
        await waitForChatScrollIdle(page);
        await installJumpProbe(page);
        const box = (await thread.boundingBox())!;
        const cdp = mobile ? await context.newCDPSession(page) : null;
        const scroll = async (direction: "older" | "newer") => {
          await releaseImages();
          if (cdp) {
            await touchFling(cdp, box, direction);
          } else {
            await thread.hover();
            await page.mouse.wheel(0, direction === "older" ? -240 : 240);
          }
          await nextFrames(page, 2);
        };
        await gateway.deferNext("chat.history", { offset: HELD_OFFSET });
        let reversed = false;
        for (let step = 0; step < 240; step += 1) {
          if (
            (await loadedMessages(page)) >= TOTAL_MESSAGES &&
            (await thread.evaluate((element) => element.scrollTop)) <= 0
          ) {
            break;
          }
          if (
            !reversed &&
            (await gateway.getRequests("chat.history", { offset: HELD_OFFSET })).length > 0
          ) {
            // Turn around while the older page is in flight, then let it land.
            for (let back = 0; back < 3; back += 1) {
              await scroll("newer");
            }
            await gateway.resolveDeferred("chat.history", historyPage(HELD_OFFSET));
            await nextFrames(page, 10);
            reversed = true;
          }
          await scroll("older");
        }
        await releaseImages();
        await waitForChatScrollIdle(page);
        await nextFrames(page, 30);
        const result = await readJumps(page);
        expect(reversed).toBe(true);
        expect(await loadedMessages(page)).toBe(TOTAL_MESSAGES);
        expect(result.frames).toBeGreaterThan(50);
        expect(result.worst, "the message being read must not jump while pages land").toEqual([]);
      });
    },
  );
});
