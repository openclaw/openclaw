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
  const distance = 240;
  const before = await thread.evaluate((element) => element.scrollTop);
  const scroll = await thread.evaluateHandle((element) => {
    const offsets = [
      { time: performance.timeOrigin + performance.now(), offset: element.scrollTop },
    ];
    const record = (event: Event) =>
      offsets.push({
        time: performance.timeOrigin + event.timeStamp,
        offset: element.scrollTop,
      });
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    element.addEventListener("scroll", record, { passive: true });
    element.addEventListener("scrollend", finish, { once: true });
    return {
      offsets,
      done,
      dispose: () => {
        element.removeEventListener("scroll", record);
        element.removeEventListener("scrollend", finish);
      },
    };
  });
  // Touch does not bubble across sandbox documents. Observe release in each frame
  // so the drag offset cannot accidentally include the ensuing native fling.
  const releases = await Promise.all(
    page.frames().map((frame) =>
      frame.evaluateHandle(() => {
        const state = { time: null as number | null };
        const record = (event: TouchEvent) => {
          state.time = performance.timeOrigin + event.timeStamp;
        };
        window.addEventListener("touchend", record, { capture: true, once: true, passive: true });
        return {
          state,
          dispose: () => window.removeEventListener("touchend", record, { capture: true }),
        };
      }),
    ),
  );
  try {
    // Chromium owns gesture timing; per-event CDP round trips can stall under load.
    await cdp.send("Input.synthesizeScrollGesture", {
      ...point,
      yDistance: direction * distance,
      speed: 1_250,
      gestureSourceType: "touch",
      preventFling: false,
    });
    const releaseTimes = await Promise.all(
      releases.map((release) => release.evaluate(({ state }) => state.time)),
    );
    const releasedAt = releaseTimes.find((time) => time !== null);
    if (releasedAt === undefined) {
      throw new Error("Native touch gesture did not release in the page or its frames");
    }
    const { moves, released } = await scroll.evaluate(({ offsets }, time) => {
      const beforeRelease = offsets
        .filter((entry) => entry.time <= time)
        .map((entry) => entry.offset);
      return { moves: beforeRelease, released: beforeRelease.at(-1) ?? offsets[0]!.offset };
    }, releasedAt);
    const dragDistance = direction * (before - released);
    let dragFailureDetails: string | undefined;
    if (!(dragDistance > 120)) {
      // Preserve the failed sample while recording whether native scrolling continued.
      const [recordedOffsets, current, frameClocks] = await Promise.allSettled([
        scroll.evaluate(({ offsets }) => offsets),
        thread.evaluate((element, coordinates) => {
          const hit = document.elementFromPoint(coordinates.x, coordinates.y);
          return {
            scrollTop: element.scrollTop,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
            timeOrigin: performance.timeOrigin,
            now: performance.timeOrigin + performance.now(),
            hit: hit ? { tag: hit.tagName, classes: hit.getAttribute("class") } : null,
          };
        }, point),
        Promise.all(
          releases.map((release) =>
            release.evaluate(({ state }) => ({
              releaseTime: state.time,
              timeOrigin: performance.timeOrigin,
            })),
          ),
        ),
      ]);
      dragFailureDetails = JSON.stringify({
        point,
        direction,
        before,
        released,
        releasedAt,
        releaseTimes,
        moves,
        offsets: recordedOffsets,
        current,
        frameClocks,
      });
    }
    expect(dragDistance, dragFailureDetails).toBeGreaterThan(120);
    // A quiet timer window can occur during native inertia; wait for its actual end.
    const completed = await page.waitForFunction(
      async ({ done }) => {
        await done;
        return true;
      },
      scroll,
      { timeout: 10_000 },
    );
    await completed.dispose();
    await waitForChatScrollIdle(page);
    const settled = await thread.evaluate((element) => element.scrollTop);
    // The final drag scroll may arrive after touchend. Require motion beyond the
    // entire requested drag so queued drag updates cannot masquerade as inertia.
    expect(direction * (before - settled)).toBeGreaterThan(distance + 20);
    return { before, moves, released, settled };
  } finally {
    await Promise.all(
      releases.map(async (release) => {
        try {
          await release.evaluate(({ dispose }) => dispose());
        } finally {
          await release.dispose();
        }
      }),
    );
    try {
      await scroll.evaluate(({ dispose }) => dispose());
    } finally {
      await scroll.dispose();
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
