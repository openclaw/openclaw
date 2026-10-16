import type { CDPSession, Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { useCanvasSandboxFixture } from "./canvas-sandbox.test-support.ts";
import { scrollChatThreadToTop, waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI mobile widget scrolling",
  startServerBeforeBrowser: true,
});

async function swipe(
  page: Page,
  cdp: CDPSession,
  thread: Locator,
  point: { x: number; y: number },
  direction: -1 | 1,
) {
  const before = await thread.evaluate((element) => element.scrollTop);
  const timestamp = Date.now() / 1000;
  const moves: number[] = [];
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ ...point, id: 1 }],
    timestamp,
  });
  const scrollEnd = await thread.evaluateHandle((element) => {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = () => resolve();
    });
    element.addEventListener("scrollend", finish, { once: true });
    return { done, dispose: () => element.removeEventListener("scrollend", finish) };
  });
  try {
    for (let step = 1; step <= 8; step++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ ...point, y: point.y + direction * step * 20, id: 1 }],
        // Preserve physical gesture velocity independently of CDP round-trip latency.
        timestamp: timestamp + step * 0.016,
      });
      // CDP acknowledgment can precede the renderer's scroll offset update.
      moves.push(
        await thread.evaluate(
          (element) =>
            new Promise<number>((resolve) => {
              requestAnimationFrame(() => resolve(element.scrollTop));
            }),
        ),
      );
    }
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
      timestamp: timestamp + 0.13,
    });
    const released = await thread.evaluate((element) => element.scrollTop);
    // A quiet timer window can occur during native inertia; wait for its actual end.
    const completed = await page.waitForFunction(
      async ({ done }) => {
        await done;
        return true;
      },
      scrollEnd,
      { timeout: 10_000 },
    );
    await completed.dispose();
    await waitForChatScrollIdle(page);
    return {
      before,
      moves,
      released,
      settled: await thread.evaluate((element) => element.scrollTop),
    };
  } finally {
    try {
      await scrollEnd.evaluate(({ dispose }) => dispose());
    } finally {
      await scrollEnd.dispose();
    }
  }
}

suite.define(() => {
  const canvasView = useCanvasSandboxFixture();
  it("keeps touch flings continuous through widgets and preserves the reader during streaming", async () => {
    await suite.withPage(
      { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
      async ({ page, context }) => {
        const sessionKey = "agent:main:main";
        const runId = "widget-scroll-run";
        const gateway = await installMockGateway(page, {
          sessionKey,
          sessionInfo: { key: sessionKey, hasActiveRun: true, activeRunIds: [runId] },
          inFlightRun: { runId, text: "Inspecting the visualization." },
          methodResponses: {
            "canvas.document.view": canvasView(
              buildWidgetDocument(
                "Synthetic visualization",
                '<main style="height:2200px;background:linear-gradient(#20394d,#315c77);color:white;padding:24px">' +
                  "<h2>Synthetic visualization</h2>" +
                  Array.from(
                    { length: 30 },
                    (_, index) => "<p>Chart row " + (index + 1) + "</p>",
                  ).join("") +
                  "</main>",
              ),
            ),
          },
          historyMessages: [
            {
              role: "assistant",
              content:
                "### Native scroll control\n\n" +
                "Ordinary transcript text is the native scroll control.\n\n".repeat(50),
              timestamp: 100,
            },
            {
              role: "assistant",
              content: '[embed ref="cv_scroll_proof" title="Synthetic visualization" /]',
              timestamp: 200,
            },
          ],
        });
        await page.goto(suite.server.baseUrl + "chat");
        const thread = page.locator(".chat-thread");
        const frame = page.locator(".chat-tool-card__preview-frame");
        await expect
          .poll(async () => (await frame.boundingBox())?.height ?? 0)
          .toBeGreaterThan(2000);
        const widget = frame.contentFrame().frameLocator("iframe");
        await widget
          .getByRole("heading", { name: "Synthetic visualization" })
          .waitFor({ state: "attached" });
        const cdp = await context.newCDPSession(page);
        const samples = [];
        await scrollChatThreadToTop(page);
        await waitForChatScrollIdle(page);
        for (const target of ["text", "widget"]) {
          const anchor =
            target === "text"
              ? page.getByRole("heading", { name: "Native scroll control" })
              : frame;
          const anchorBox = await anchor.boundingBox();
          const threadBox = await thread.boundingBox();
          if (!anchorBox || !threadBox) {
            throw new Error("Scroll fixture is not visible");
          }
          await thread.evaluate(
            (element, delta) => {
              element.scrollTop += delta;
            },
            anchorBox.y - threadBox.y + 250,
          );
          await waitForChatScrollIdle(page);
          const sample = await swipe(
            page,
            cdp,
            thread,
            {
              x: threadBox.x + threadBox.width / 2,
              y: threadBox.y + threadBox.height * 0.7,
            },
            -1,
          );
          samples.push({ target, ...sample });
          console.info("Mobile widget native scroll proof", JSON.stringify(samples));
          // A finger moving in one direction must never drive the transcript backward.
          let previous = sample.before;
          for (const offset of sample.moves) {
            expect(offset).toBeGreaterThanOrEqual(previous - 1);
            previous = offset;
          }
          expect(
            sample.released - sample.before,
            JSON.stringify({ target, ...sample }),
          ).toBeGreaterThan(120);
          expect(sample.settled - sample.released).toBeGreaterThan(20);
        }

        // Begin at the live end, then read upward through the iframe. Native touch
        // events do not bubble across documents; native offsets must still release follow.
        await page.getByRole("button", { name: "Scroll to latest" }).click();
        await expect
          .poll(() =>
            thread.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBe(0);
        await waitForChatScrollIdle(page);
        const threadBox = await thread.boundingBox();
        if (!threadBox) {
          throw new Error("Transcript disappeared before the return gesture");
        }
        const upward = await swipe(
          page,
          cdp,
          thread,
          {
            x: threadBox.x + threadBox.width / 2,
            y: threadBox.y + 100,
          },
          1,
        );
        const upwardProof = JSON.stringify(upward);
        expect(upward.before - upward.released, upwardProof).toBeGreaterThan(120);
        expect(upward.released - upward.settled, upwardProof).toBeGreaterThan(20);
        await gateway.emitGatewayEvent("chat", {
          sessionKey,
          runId,
          state: "delta",
          message: { role: "assistant", content: "More visualization detail.\n\n".repeat(30) },
        });
        await expect.poll(() => thread.textContent()).toContain("More visualization detail.");
        await waitForChatScrollIdle(page);
        expect(await thread.evaluate((element) => element.scrollTop)).toBe(upward.settled);
      },
    );
  });
});
