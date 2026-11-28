import { webkit, type Browser, type BrowserContext } from "playwright";
import { expect, it } from "vitest";
import { controlUiE2eWaitTimeoutMs, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { chatMessage } from "./chat-flow.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

let webkitBrowser: Browser;
const suite = createControlUiE2eSuite({
  name: "Chat history reading stability",
  resources: {
    async run() {
      webkitBrowser = await webkit.launch({ headless: true });
    },
    async close() {
      await webkitBrowser?.close();
    },
  },
});

// Virtual-core holds scroll corrections for iOS touch and momentum scrolling by user agent.
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const LOADED = 190;

// Real answers range from one line to several screens; uniform rows hide estimate errors.
function answer(seq: number): string {
  const parts = [`Answer ${seq}.`];
  for (let index = 0; index < 1 + ((seq * 7) % 9); index++) {
    parts.push(
      `Paragraph ${index} of answer ${seq}. ${"The reader keeps this sentence in view. ".repeat(2 + ((seq + index) % 6))}`,
    );
    if ((seq + index) % 5 === 0) {
      parts.push("```ts\n" + "const value = compute(input);\n".repeat(4 + (index % 6)) + "```");
    }
  }
  return parts.join("\n\n");
}

function message(seq: number) {
  const user = seq % 2 === 1;
  return {
    __openclaw: { id: `reading-${seq}`, seq },
    role: user ? "user" : "assistant",
    content: [{ type: "text", text: user ? `Question ${seq}?` : answer(seq) }],
    timestamp: 1_800_000_000_000 + seq * 1000,
  };
}

suite.define(() => {
  it("does not select or paint the gap between turns in WebKit", async () => {
    const first = "Select this message without painting its image or surrounding space.";
    const last = "Selection ends here, with only the conversation text highlighted.";
    const context = await webkitBrowser.newContext(createControlUiE2eContextOptions());
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      await installMockGateway(page, {
        historyMessages: [chatMessage("user", first), chatMessage("assistant", last)],
      });
      await page.goto(suite.server.baseUrl + "chat");
      const prompt = page.getByText(first, { exact: true });
      const reply = page.getByText(last, { exact: true });
      await reply.waitFor();
      const gap = await prompt.evaluate((element) => {
        const group = element.closest(".chat-group")!.getBoundingClientRect();
        const row = element.closest(".chat-virtual-row")!.getBoundingClientRect();
        return {
          x: Math.floor(row.left + row.width / 2),
          y: Math.floor((group.bottom + row.bottom) / 2),
        };
      });
      const gapPixels = () => page.screenshot({ clip: { ...gap, width: 8, height: 2 } });
      await page.mouse.move(gap.x, gap.y);
      const neutral = await gapPixels();
      await page.mouse.dblclick(gap.x, gap.y);
      expect(await page.evaluate(() => document.getSelection()?.isCollapsed)).toBe(true);

      // A real text drag may cross this same gap without tinting it.
      const from = (await prompt.boundingBox())!;
      const to = (await reply.boundingBox())!;
      await page.mouse.move(from.x + 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + 20, to.y + to.height / 2, { steps: 8 });
      await page.mouse.up();
      const selected = await page.evaluate(() => document.getSelection()?.toString());
      expect(selected).toContain(first.slice(2));
      expect(selected).toContain(last.slice(0, 2));
      expect(await gapPixels()).toEqual(neutral);
      await page.mouse.click(gap.x, gap.y);
      expect(await page.evaluate(() => document.getSelection()?.isCollapsed)).toBe(true);

      // A drag can also start in the blank margin and extend back into text.
      expect(
        await page.evaluate(
          ({ x, y }) => document.elementFromPoint(x, y)?.matches(".chat-virtual-row, .chat-group"),
          gap,
        ),
      ).toBe(true);
      await page.mouse.move(gap.x, gap.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 2, from.y + from.height / 2, { steps: 8 });
      await page.mouse.up();
      expect(await page.evaluate(() => document.getSelection()?.toString().trim())).toContain(
        "this message without painting",
      );
    } finally {
      await context.close();
    }
  });

  it("selects list text without selecting or painting the space between items in WebKit", async () => {
    const context = await webkitBrowser.newContext(createControlUiE2eContextOptions());
    try {
      const page = await context.newPage();
      await installMockGateway(page, {
        historyMessages: [chatMessage("assistant", "- **First** item.\n- **Second** item.")],
      });
      await page.goto(suite.server.baseUrl + "chat");
      const items = page.locator(".chat-text li");
      await items.last().waitFor();
      const first = (await items.first().boundingBox())!;
      const second = (await items.last().boundingBox())!;
      const x = first.x + 12;
      const y = Math.floor(second.y - 1);
      const selection = () => page.evaluate(() => document.getSelection()?.toString());
      await page.mouse.dblclick(x, y);
      expect.soft(await selection(), "blank spacing is not a word").toBe("");
      await page.mouse.click(x, first.y + first.height / 2);
      await page.keyboard.press("Escape");

      // Include the edges of both line boxes: WebKit can paint thin full-width
      // stripes there even when the middle of the margin stays transparent.
      const clip = {
        x: Math.floor(first.x + first.width - 8),
        y: Math.floor(first.y + first.height - 2),
        width: 6,
        height: Math.ceil(second.y + 2) - Math.floor(first.y + first.height - 2),
      };
      const neutral = await page.screenshot({ clip });
      await page.mouse.move(first.x + 1, first.y + first.height / 2);
      await page.mouse.down();
      await page.mouse.move(second.x + second.width - 1, second.y + second.height / 2, {
        steps: 6,
      });
      expect(await selection()).toBe("First item.\nSecond item.");
      expect(await page.screenshot({ clip })).toEqual(neutral);
      await page.mouse.up();
    } finally {
      await context.close();
    }
  });

  it.each([
    { engine: "chromium", width: 390 },
    { engine: "webkit", width: 390 },
    { engine: "chromium", width: 1280 },
  ] as const)(
    "keeps loaded older history still while reading upward ($engine, $width px)",
    async ({ engine, width }) => {
      const phone = width < 600;
      const options = {
        viewport: { width, height: phone ? 844 : 900 },
        isMobile: phone && engine === "chromium",
        hasTouch: phone,
        userAgent: phone ? IPHONE_UA : undefined,
        locale: "en-US",
        serviceWorkers: "block" as const,
      };
      const context: BrowserContext =
        engine === "chromium"
          ? await suite.newBrowserContext(options)
          : await webkitBrowser.newContext(options);
      try {
        const page = await context.newPage();
        const history = (first: number, count: number, hasMore: boolean) => ({
          messages: Array.from({ length: count }, (_, index) => message(first + index)),
          hasMore,
          nextOffset: hasMore ? count : LOADED,
          ...(hasMore ? { olderCursor: "older-reading" } : {}),
          totalMessages: LOADED,
          sessionId: "reading-session",
        });
        await installMockGateway(page, {
          sessionKey: "agent:main:main",
          sessions: [{ key: "agent:main:main", sessionId: "reading-session" }],
          methodResponses: {
            "chat.startup": history(161, 30, true),
            "chat.history": history(1, 160, false),
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
        await thread.getByText(/^Answer 190\./).waitFor();
        // A mounted last row does not prove that the initial end placement has landed.
        await expect
          .poll(() =>
            thread.evaluate((element) => {
              const inner = element.querySelector(".chat-thread-inner");
              return (
                element.clientHeight > 0 &&
                element.scrollHeight > element.clientHeight &&
                Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 2 &&
                inner !== null &&
                getComputedStyle(inner).visibility === "visible"
              );
            }),
          )
          .toBe(true);
        // Native input retires end-follow ownership. WebKit uses the explicit
        // edge action rather than relying on a wheel animation through measured rows.
        if (engine === "webkit") {
          await thread.press("Home");
        } else {
          await thread.hover();
          await page.mouse.wheel(0, -(await thread.evaluate((element) => element.scrollHeight)));
        }
        await expect
          .poll(() =>
            thread.evaluate((element) => {
              const pane = element.closest(".chat-pane-cache__pane--active") as HTMLElement & {
                state: { chatMessages: unknown[] };
              };
              // State can contain the prefix while active scrolling still holds the old
              // rendered window. Wait for retained rows to acquire their prepended indexes.
              const prefixCommitted = [
                ...element.querySelectorAll<HTMLElement>(".chat-bubble[data-message-id]"),
              ].some((bubble) => {
                const match = /(?:Question|Answer) (\d+)[?.]/.exec(bubble.textContent ?? "");
                const sequence = match ? Number(match[1]) : 0;
                return (
                  sequence >= 161 &&
                  Number(bubble.closest<HTMLElement>(".chat-virtual-row")?.dataset.index) ===
                    sequence - 1
                );
              });
              return {
                messageCount: pane.state.chatMessages.length,
                prefixCommitted,
                readingRunwayReady: element.scrollTop > 240 * 24,
              };
            }),
          )
          .toEqual({ messageCount: LOADED, prefixCommitted: true, readingRunwayReady: true });
        // Programmatic steps now sample reading through the loaded history.
        const frames = await thread.evaluate(async (element) => {
          const pane = element.closest(".chat-pane-cache__pane--active") as HTMLElement & {
            state: { chatMessages: unknown[] };
          };
          const nextFrame = () => new Promise(requestAnimationFrame);
          const wait = (ms: number) =>
            new Promise<void>((resolve) => {
              setTimeout(resolve, ms);
            });
          const numeric = (raw: string | null | undefined) => {
            const parsed = Number.parseFloat(raw ?? "");
            return Number.isFinite(parsed) ? parsed : null;
          };
          const layout = (node: HTMLElement | null) => {
            if (!node) {
              return null;
            }
            const style = getComputedStyle(node);
            let translation: { x: number; y: number } | null = null;
            try {
              const matrix = new DOMMatrixReadOnly(
                style.transform === "none" ? "" : style.transform,
              );
              translation = { x: matrix.m41, y: matrix.m42 };
            } catch {
              // A missing transform remains unobserved.
            }
            return {
              height: node.getBoundingClientRect().height,
              inlineMarginTop: numeric(node.style.marginTop),
              marginTop: numeric(style.marginTop),
              top: numeric(style.top),
              translation,
            };
          };
          const snapshot = () => {
            const inner = element.querySelector<HTMLElement>(".chat-thread-inner");
            return {
              time: performance.now(),
              count: pane.state.chatMessages.length,
              scrollTop: element.scrollTop,
              clientHeight: element.clientHeight,
              scrollHeight: element.scrollHeight,
              maximumOffset: Math.max(0, element.scrollHeight - element.clientHeight),
              measuringAttributePresent: inner?.hasAttribute("data-measuring-rows") ?? null,
              measuringRowCount: numeric(inner?.getAttribute("data-measuring-rows")),
              innerVisible: inner ? getComputedStyle(inner).visibility === "visible" : null,
              inner: layout(inner),
              sizer: layout(element.querySelector<HTMLElement>(".chat-virtual-sizer")),
              block: layout(element.querySelector<HTMLElement>(".chat-virtual-block")),
              mountedRows: element.querySelectorAll(".chat-virtual-row").length,
              mountedBubbles: element.querySelectorAll(".chat-bubble[data-message-id]").length,
              fonts: document.fonts.status,
            };
          };
          const boundaries = [{ stage: "measurement-entry", geometry: snapshot() }];
          const tops = () =>
            new Map(
              [...element.querySelectorAll<HTMLElement>(".chat-bubble[data-message-id]")].map(
                (bubble) => [bubble.dataset.messageId!, bubble.getBoundingClientRect().top],
              ),
            );
          const readerTop = element.getBoundingClientRect().top;
          const residuals: number[] = [];
          const samples = [];
          let previous = tops();
          for (let frame = 0; frame < 240 && element.scrollTop > 0; frame++) {
            const before = element.scrollTop;
            const requested = before - 24;
            element.scrollTop -= 24;
            const immediate = element.scrollTop;
            const readerDelta = before - element.scrollTop;
            // Resize delivery corrects layout after animation callbacks; read the painted frame.
            await nextFrame();
            await wait(0);
            const current = tops();
            // Follow the first message whose top was visible in the previous frame.
            const watched = [...previous]
              .filter(([id, top]) => top >= readerTop && current.has(id))
              .toSorted((left, right) => left[1] - right[1])[0];
            residuals.push(
              watched ? Math.abs(current.get(watched[0])! - watched[1] - readerDelta) : 0,
            );
            const watchedBubble = watched
              ? [...element.querySelectorAll<HTMLElement>(".chat-bubble[data-message-id]")].find(
                  (bubble) => bubble.dataset.messageId === watched[0],
                )
              : undefined;
            const fixtureIndex = /(?:Question|Answer) (\d+)[?.]/.exec(
              watchedBubble?.textContent ?? "",
            );
            samples.push({
              frame,
              before,
              requested,
              immediate,
              painted: element.scrollTop,
              readerDelta,
              watchedPreviousTop: watched?.[1] ?? null,
              watchedPaintedTop: watched ? current.get(watched[0])! : null,
              residual: residuals.at(-1)!,
              watchedFixtureIndex: fixtureIndex ? Number(fixtureIndex[1]) : null,
              watchedVirtualRowIndex: numeric(
                watchedBubble?.closest<HTMLElement>(".chat-virtual-row")?.dataset.index,
              ),
              geometry: snapshot(),
            });
            previous = current;
          }
          return {
            count: pane.state.chatMessages.length,
            residuals,
            diagnostic: { boundaries, samples },
          };
        });
        console.info(
          "history-reading-geometry",
          JSON.stringify({ engine, width, ...frames.diagnostic }),
        );
        expect(frames.count).toBe(LOADED);
        expect(frames.residuals.length).toBeGreaterThan(200);
        expect(
          frames.residuals.filter((residual) => residual > 2),
          "visible messages must only move with the reader",
        ).toEqual([]);
      } finally {
        await (engine === "chromium" ? suite.closeBrowserContext(context) : context.close());
      }
    },
  );
});
