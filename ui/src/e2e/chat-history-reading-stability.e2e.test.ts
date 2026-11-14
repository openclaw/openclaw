import { webkit, type Browser, type BrowserContext } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

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
        // Read up to the boundary until the older page lands, then read on through it.
        // Programmatic scrollTop steps stand in for touch and momentum movement.
        const frames = await thread.evaluate(async (element, loaded) => {
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
          const boundaries = [{ stage: "before-loading", geometry: snapshot() }];
          for (let round = 0; round < 20 && pane.state.chatMessages.length < loaded; round++) {
            for (
              let step = 0;
              step < 400 && element.scrollTop > 0 && pane.state.chatMessages.length < loaded;
              step++
            ) {
              element.scrollTop -= 400;
              await nextFrame();
            }
            await wait(400);
          }
          boundaries.push({ stage: "model-loaded", geometry: snapshot() });
          await wait(600);
          boundaries.push({ stage: "measurement-entry", geometry: snapshot() });
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
        }, LOADED);
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
