import type { BrowserContextOptions, Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "session reading position" });
const sessions = ["reader-a", "reader-b", "reader-c", "reader-d"].map((name, index) => ({
  key: "agent:main:" + name,
  sessionId: name + ":backing",
  kind: "direct",
  label: "Reading session " + String.fromCharCode(65 + index),
  updatedAt: 100 - index,
}));
const first = sessions[0]!.key;
const second = sessions[1]!.key;
function history(key: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content:
      "Checkpoint " +
      index +
      ". " +
      "Reading position must remain stable. ".repeat(2 + (index % 9)) +
      "\n\n" +
      "Additional details and evidence.\n".repeat(index % 5),
    timestamp: 1_000 + index,
    __openclaw: { id: key + ":message:" + index, seq: index + 1 },
  }));
}
const thread = (page: Page) => page.locator(".chat-pane-cache__pane--active .chat-thread");
type SessionPositionSample = {
  readerTop: number | null;
  lastId: string | null;
  lastBottom: number | null;
  viewportBottom: number;
  endGap: number;
  viewportHeight: number;
};
declare global {
  interface Window {
    stopSessionPositionProbe?: () => SessionPositionSample[];
  }
}

async function selectSession(page: Page, key: string, reader?: { id: string; offset: number }) {
  if (await page.locator(".shell--mobile-nav:not(.shell--nav-drawer-open)").count()) {
    await page
      .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
      .first()
      .click();
    const drawer = page.locator(".shell--mobile-nav.shell--nav-drawer-open > .shell-nav");
    await drawer.waitFor({ state: "visible" });
    await drawer.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
  }
  // Observe the presentation boundary, not only the eventual settled offset.
  await page.evaluate(
    ({ key: sessionKey, readerId }) => {
      const frames: SessionPositionSample[] = [];
      const channel = new MessageChannel();
      let frame = 0;
      const sample = () => {
        const pane = document.querySelector<HTMLElement>(".chat-pane-cache__pane--visible");
        if (
          !pane ||
          Reflect.get(pane, "sessionKey") !== sessionKey ||
          getComputedStyle(pane).opacity === "0"
        ) {
          return;
        }
        const viewport = pane.querySelector<HTMLElement>(".chat-thread");
        if (!viewport?.querySelector(".chat-thread-inner--virtual")) {
          return;
        }
        const rect = viewport.getBoundingClientRect();
        if (!rect.height) {
          return;
        }
        const bubbles = [...viewport.querySelectorAll<HTMLElement>(".chat-bubble[data-entry-id]")];
        const anchor = bubbles.find((bubble) => bubble.dataset.entryId === readerId);
        const last = bubbles.at(-1);
        frames.push({
          readerTop: anchor ? anchor.getBoundingClientRect().top - rect.top : null,
          lastId: last?.dataset.entryId ?? null,
          lastBottom: last?.getBoundingClientRect().bottom ?? null,
          viewportBottom: rect.bottom,
          endGap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
          viewportHeight: rect.height,
        });
      };
      // These are DOM observations after queued layout work, not a compositor
      // frame trace. Busy main-thread intervals still require pixel verification.
      channel.port1.addEventListener("message", sample);
      channel.port1.start();
      const nextFrame = () => {
        channel.port2.postMessage(null);
        frame = requestAnimationFrame(nextFrame);
      };
      frame = requestAnimationFrame(nextFrame);
      window.stopSessionPositionProbe = () => {
        cancelAnimationFrame(frame);
        channel.port1.close();
        channel.port2.close();
        return frames;
      };
    },
    { key, readerId: reader?.id ?? null },
  );
  let frames: SessionPositionSample[];
  try {
    await page
      .locator(
        '.sidebar-recent-session[data-session-key="' + key + '"] a.sidebar-recent-session__link',
      )
      .click();
    await expect
      .poll(() =>
        page
          .locator(".chat-pane-cache__pane--active")
          .evaluate((pane: HTMLElement & { sessionKey: string }) => pane.sessionKey),
      )
      .toBe(key);
    await waitForChatScrollIdle(page);
  } finally {
    frames = await page.evaluate(() => {
      const captured = window.stopSessionPositionProbe?.() ?? [];
      delete window.stopSessionPositionProbe;
      return captured;
    });
  }
  expect
    .soft(frames.length, "recorded transition samples of the target transcript")
    .toBeGreaterThan(0);
  if (frames.length === 0) {
    return;
  }
  if (reader) {
    const drift = frames.map((frame) =>
      frame.readerTop === null
        ? Number.POSITIVE_INFINITY
        : Math.abs(frame.readerTop - reader.offset),
    );
    expect
      .soft(Math.max(...drift), "reader anchor stays fixed across observed transition states")
      .toBeLessThanOrEqual(2);
  } else {
    const settled = frames.at(-1)!;
    const lastId = key + ":message:" + (key === first ? 179 : 24);
    expect
      .soft(
        frames.every((frame) => frame.lastId === lastId),
        "sampled first-open states display the transcript end",
      )
      .toBe(true);
    expect
      .soft(
        Math.max(...frames.map((frame) => Math.abs(frame.endGap))),
        "sampled end positions stay at the native bottom",
      )
      .toBeLessThanOrEqual(2);
    expect
      .soft(
        Math.max(
          ...frames.map((frame) =>
            frame.lastBottom === null
              ? Number.POSITIVE_INFINITY
              : frame.lastBottom - frame.viewportBottom,
          ),
        ),
        "sampled last bubble is not clipped beyond the viewport",
      )
      .toBeLessThanOrEqual(2);
    const movement = frames.map((frame) =>
      frame.lastBottom === null || settled.lastBottom === null
        ? Number.POSITIVE_INFINITY
        : Math.abs(frame.lastBottom - settled.lastBottom),
    );
    expect
      .soft(Math.max(...movement), "end bubble stays fixed across transition samples")
      .toBeLessThanOrEqual(2);
    const viewportMovement = frames.map((frame) =>
      Math.abs(frame.viewportHeight - settled.viewportHeight),
    );
    expect
      .soft(Math.max(...viewportMovement), "empty progress loading does not resize the viewport")
      .toBeLessThanOrEqual(2);
  }
}
async function visibleReader(viewport: Locator) {
  return viewport.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const bubble = [...element.querySelectorAll<HTMLElement>(".chat-bubble[data-entry-id]")].find(
      (candidate) =>
        candidate.getBoundingClientRect().bottom > top &&
        candidate.getBoundingClientRect().top < element.getBoundingClientRect().bottom,
    );
    if (!bubble?.dataset.entryId) {
      throw new Error("Expected a visible persisted message");
    }
    return { id: bubble.dataset.entryId, offset: bubble.getBoundingClientRect().top - top };
  });
}
async function expectReader(viewport: Locator, reader: Awaited<ReturnType<typeof visibleReader>>) {
  const offset = await viewport.evaluate((element, id) => {
    const bubble = [...element.querySelectorAll<HTMLElement>(".chat-bubble[data-entry-id]")].find(
      (candidate) => candidate.dataset.entryId === id,
    );
    return bubble ? bubble.getBoundingClientRect().top - element.getBoundingClientRect().top : null;
  }, reader.id);
  expect(offset, "the same message stays mounted at the reading point").not.toBeNull();
  expect(
    Math.abs(offset! - reader.offset),
    "the same message retains its viewport offset",
  ).toBeLessThanOrEqual(2);
}
async function readHistory(page: Page, position: "middle" | "near-end") {
  const viewport = thread(page);
  const delta = await viewport.evaluate((element, where) => {
    const max = element.scrollHeight - element.clientHeight;
    return (where === "middle" ? max * 0.43 : max - 180) - element.scrollTop;
  }, position);
  await viewport.hover({ position: { x: 40, y: 120 } });
  await page.mouse.wheel(0, delta);
  await waitForChatScrollIdle(page);
  expect(
    await viewport.evaluate(
      (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
    ),
  ).toBeGreaterThan(8);
  return visibleReader(viewport);
}
async function withSessions(
  run: (page: Page, gateway: Awaited<ReturnType<typeof installMockGateway>>) => Promise<void>,
  contextOptions: BrowserContextOptions = {},
) {
  await suite.withPage(
    { ...createControlUiE2eContextOptions(), ...contextOptions },
    async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey: first,
        sessions,
        sessionTranscripts: Object.fromEntries(
          sessions.map(({ key }, index) => [
            key,
            {
              messages: history(key, index === 0 ? 180 : 25),
            },
          ]),
        ),
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, first));
      await page.getByText("Checkpoint 179.", { exact: false }).waitFor();
      await waitForChatScrollIdle(page);
      await run(page, gateway);
    },
  );
}

suite.define(() => {
  // Fixed scrollHeight mocks cannot exercise fresh virtual row estimates after eviction.
  for (const [position, compact] of [
    ["middle", false],
    ["near-end", false],
    ["middle", true],
  ] as const) {
    it(
      "preserves the reader after an evicted pane is rebuilt: " +
        position +
        (compact ? " compact/reduced motion" : ""),
      async () => {
        await withSessions(
          async (page) => {
            const viewport = thread(page);
            const original = await viewport.elementHandle();
            const reader = await readHistory(page, position);
            for (const session of sessions.slice(1)) {
              await selectSession(page, session.key);
            }
            expect(await original!.evaluate((element) => element.isConnected)).toBe(false);
            await selectSession(page, first, reader);
            await expectReader(viewport, reader);

            // A new reader gesture must replace the restored bookmark, not replay it.
            await viewport.hover({ position: { x: 40, y: 120 } });
            await page.mouse.wheel(0, -300);
            await waitForChatScrollIdle(page);
            const movedReader = await visibleReader(viewport);
            expect(movedReader).not.toEqual(reader);
            await selectSession(page, second);
            await selectSession(page, first, movedReader);
            await expectReader(viewport, movedReader);
          },
          compact ? { viewport: { width: 560, height: 900 }, reducedMotion: "reduce" } : {},
        );
      },
    );
  }

  it("preserves a reader above the end while a hidden progress card changes the viewport", async () => {
    await withSessions(async (page, gateway) => {
      await gateway.setMethodResponse("progressCard.get", {
        cases: [
          {
            match: { sessionKey: first },
            response: {
              card: {
                sessionKey: first,
                revision: 1,
                updatedAt: 1_000,
                markdown:
                  "Reviewing the session.\n\n" +
                  "- Verify another result and its evidence.\n".repeat(25),
                steps: [{ step: "Verify reading position", status: "in_progress" }],
              },
            },
          },
          { match: { sessionKey: second }, response: { card: null } },
        ],
      });
      await gateway.emitGatewayEvent("progressCard.changed", { sessionKey: first, revision: 1 });
      const card = page.locator(
        '.chat-pane-cache__pane--active [data-progress-card-placement="composer"]',
      );
      await card.waitFor();
      if ((await card.getAttribute("open")) === null) {
        await card.locator("summary").click();
      }
      await card.locator(".session-progress-card__body").waitFor({ state: "visible" });
      await waitForChatScrollIdle(page);
      const viewport = thread(page);
      const original = await viewport.elementHandle();
      const reader = await readHistory(page, "near-end");
      expect(await card.getAttribute("open")).not.toBeNull();
      await selectSession(page, second);
      expect(await original!.evaluate((element) => element.isConnected)).toBe(true);
      await selectSession(page, first, reader);
      expect(await card.getAttribute("open")).not.toBeNull();
      await expectReader(viewport, reader);

      // Choosing latest still changes intent; it must not restore the earlier reader.
      await page.getByRole("button", { name: "Scroll to latest" }).click();
      await waitForChatScrollIdle(page);
      await selectSession(page, second);
      await selectSession(page, first);
      expect(
        await viewport.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      ).toBeLessThanOrEqual(8);
    });
  });
});
