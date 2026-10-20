import type { Locator, Page } from "playwright";
import { expect as browserExpect } from "playwright/test";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  defaultControlUiFeatureMethods,
  createControlUiMockSameOriginGatewayScript,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  scrollChatThreadToTop,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const MIN_READER_HEIGHT = 360;
const checkpoint = (index: number) =>
  `Conversation checkpoint ${index + 1}: review the notes and confirm the next step.`;
const visibleRail = { currentVisible: true, messageInViewport: true, markerInViewport: true };
const railPage = (
  run: (page: Page) => Promise<void>,
  options: Parameters<typeof suite.withPage>[0] = {
    colorScheme: "dark",
    viewport: { width: 1440, height: 900 },
  },
) => suite.withPage(options, ({ page }) => run(page));

function railMessages(count: number, prefix: string, text: (index: number) => string) {
  return Array.from({ length: count }, (_, index) => ({
    __openclaw: { id: `${prefix}-${index}`, seq: index + 1 },
    role: index % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: text(index) }],
  }));
}
const scrollTop = (locator: Locator) => locator.evaluate((element) => element.scrollTop);
const boxHeight = async (locator: Locator) => (await locator.boundingBox())!.height;
const chat = (page: Page) => ({
  transcript: page.locator(".chat-thread"),
  track: page.locator(".chat-position-rail__track"),
  marks: page.locator(".chat-position-rail__marks"),
  composer: page.locator(".agent-chat__composer-shell"),
});
const markerFits = (marker: Locator, requireKeyboardFocus = false) =>
  marker.evaluate((element, keyboard) => {
    const rect = element.getBoundingClientRect();
    const scroller = element.closest(".chat-position-rail__marks")!;
    const viewport = scroller.getBoundingClientRect();
    // Scroll ranges round the local height before adding its fractional page position.
    return (
      rect.top >= viewport.top &&
      rect.bottom <= viewport.top + scroller.clientHeight &&
      (!keyboard ||
        (element === document.activeElement &&
          rect.bottom <
            document.querySelector(".agent-chat__composer-shell")!.getBoundingClientRect().top))
    );
  }, requireKeyboardFocus);

function readPositionRailGeometry(page: Page) {
  return page.locator(".chat-position-rail__marks").evaluate((element) => {
    const thread = element.closest(".chat-thread")!;
    const current = element.querySelector('[aria-current="true"]');
    const activeId = current?.getAttribute("data-position-marker-id") ?? null;
    const message = activeId
      ? thread.querySelector(`.chat-bubble[data-entry-id="${activeId}"]`)
      : null;
    const marker = current?.getBoundingClientRect();
    const viewport = element.getBoundingClientRect();
    const reader = thread.getBoundingClientRect();
    const bubble = message?.getBoundingClientRect();
    const distanceFromEnd = thread.scrollHeight - thread.clientHeight - thread.scrollTop;
    return {
      atEnd: Math.abs(distanceFromEnd) <= 1,
      currentVisible: current?.hasAttribute("data-visible") ?? false,
      messageInViewport: Boolean(
        bubble && bubble.bottom > reader.top && bubble.top < reader.bottom,
      ),
      markerInViewport: Boolean(
        marker &&
        marker.top >= viewport.top &&
        marker.bottom <= viewport.top + element.clientHeight,
      ),
    };
  });
}

async function expectPositionRailAtEnd(page: Page) {
  await expect
    .poll(() => readPositionRailGeometry(page))
    .toMatchObject({ ...visibleRail, atEnd: true });
}

async function resizeAndNavigate(page: Page, navigationFirst: boolean) {
  await installMockGateway(page, {
    historyMessages: railMessages(80, "resize-navigation", checkpoint),
  });
  await page.addInitScript(createControlUiMockSameOriginGatewayScript());
  await page.goto(`${suite.server.baseUrl}chat`);
  await page.locator(".chat-position-rail__track").waitFor();
  await waitForChatScrollIdle(page);
  await expectPositionRailAtEnd(page);
  const transcript = page.locator(".chat-thread");
  await transcript.hover();
  await page.mouse.wheel(0, -30000);
  await expect.poll(() => scrollTop(transcript)).toBe(0);
  await expect.poll(() => readPositionRailGeometry(page)).toMatchObject(visibleRail);
  await waitForChatScrollIdle(page);
  // Apply input and navigation in one frame, before observer delivery.
  await page.locator(".agent-chat__composer-combobox textarea").evaluate((element, first) => {
    const textarea = element as HTMLTextAreaElement;
    const thread = document.querySelector(".chat-thread")!;
    if (first) {
      thread.scrollTop = thread.scrollHeight;
    }
    textarea.value = "Keep the review notes available.\n".repeat(6);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    if (!first) {
      thread.scrollTop = thread.scrollHeight;
    }
  }, navigationFirst);
  await waitForChatScrollIdle(page);
  await expectPositionRailAtEnd(page);
}

async function keepRailAnchored(page: Page, count: number, direction: string) {
  const sessionKey = "agent:main:main";
  const runId = "stable-rail-run";
  const sessionInfo = { key: sessionKey, hasActiveRun: true, activeRunIds: [runId] };
  const gateway = await installMockGateway(page, {
    sessionKey,
    sessionInfo,
    sessions: [sessionInfo],
    inFlightRun: { runId, startedAt: Date.now() },
    historyMessages: railMessages(
      count,
      "stable-rail",
      (index) =>
        `${direction === "rtl" ? "راجع الملاحظات. " : ""}${checkpoint(index)}${count <= 8 && index === count - 1 ? "\n\nSupporting context keeps this small set of turns scrollable while testing the rail anchor.".repeat(16) : ""}`,
    ),
    featureMethods: [...defaultControlUiFeatureMethods, "progressCard.get"],
    methodResponses: {
      "progressCard.get": {
        card: {
          sessionKey,
          runId,
          revision: 1,
          updatedAt: Date.now(),
          markdown: "Review the conversation and verify navigation.",
          steps: [
            { step: "Read the conversation", status: "completed" },
            { step: "Verify navigation controls", status: "in_progress" },
            { step: "Check the final evidence", status: "pending" },
          ],
        },
      },
    },
  });
  await page.addInitScript(createControlUiMockSameOriginGatewayScript());
  if (direction === "rtl") {
    await page.addInitScript(() => localStorage.setItem("openclaw.i18n.locale", "ar"));
  }
  await page.goto(`${suite.server.baseUrl}chat`);
  await page.locator(`.chat-text[dir="${direction}"]`).first().waitFor();
  if (count === 1 || count === 5) {
    // These fixtures end with a clamped user message; expose its scrollable content.
    await page.getByRole("button", { name: "Show more", exact: true }).click();
    await waitForChatScrollIdle(page);
    // Expanding a message preserves the reader position, so establish the baseline explicitly.
    await page.locator(".chat-thread").focus();
    await page.keyboard.press("End");
    await waitForChatScrollIdle(page);
  }
  const card = page.locator('[data-progress-card-placement="details"]');
  await card.waitFor({ state: "attached" });
  expect(await card.isVisible()).toBe(false);
  const detailsToggle = page.locator(".chat-details-toggle");
  await detailsToggle.click();
  const details = page.locator('.chat-details[role="dialog"]');
  await details.waitFor();
  await card.waitFor();
  await waitForChatScrollIdle(page);
  const summary = card.locator("summary");
  if ((await card.getAttribute("open")) !== null) {
    await summary.click();
  }
  await expect
    .poll(() =>
      card.evaluate((element) => getComputedStyle(element, "::details-content").blockSize),
    )
    .toBe("0px");
  const { transcript, track, marks, composer } = chat(page);
  await track.waitFor();
  const markers = marks.locator(".chat-position-rail__marker");
  const markerForIndex = (index: number) =>
    marks.locator(`[data-position-marker-id="stable-rail-${index}"]`);
  await expectPositionRailAtEnd(page);
  const bounds = () => track.evaluate((element) => element.getBoundingClientRect().toJSON());
  const collapsed = await bounds();
  const transcriptBounds = (await transcript.boundingBox())!;
  expect(collapsed.left).toBeGreaterThanOrEqual(transcriptBounds.x);
  expect(collapsed.right).toBeLessThanOrEqual(transcriptBounds.x + transcriptBounds.width);
  const collapsedComposer = (await composer.boundingBox())!;
  if (count === 80 && direction === "ltr") {
    await transcript.hover();
    await page.mouse.wheel(0, -4);
    await expect
      .poll(() =>
        transcript.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBe(4);
  }
  const anchorIndex = await markers.evaluateAll((elements) => {
    const viewport = elements[0]!.closest(".chat-position-rail__marks")!.getBoundingClientRect();
    return Math.max(
      0,
      elements.findIndex((element) => {
        const marker = element.getBoundingClientRect();
        return marker.top >= viewport.top + 60 && marker.bottom <= viewport.bottom - 60;
      }),
    );
  });
  const anchorTick = markers.nth(anchorIndex).locator(".chat-position-rail__tick");
  const tickTop = (await anchorTick.boundingBox())!.y;
  const probe = await track.evaluateHandle((element, index) => {
    const reader = element.closest<HTMLElement>(".chat-thread")!;
    const tick = element.querySelectorAll(".chat-position-rail__tick")[index]!;
    const frame = () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    const contentHeight = () => {
      const style = getComputedStyle(reader);
      const insets = [
        style.paddingTop,
        style.paddingBottom,
        style.borderTopWidth,
        style.borderBottomWidth,
      ];
      return (
        reader.getBoundingClientRect().height -
        insets.reduce((sum, inset) => sum + Number.parseFloat(inset), 0)
      );
    };
    const anchor = () => ({
      track: element.getBoundingClientRect().top,
      tick: tick.getBoundingClientRect().top,
    });
    return {
      contentHeight,
      async afterResize() {
        await new Promise<void>((resolve) => {
          const observer = new ResizeObserver(() => {
            observer.disconnect();
            resolve();
          });
          observer.observe(element.closest(".chat-main__conversation")!);
        });
        await frame();
        return anchor();
      },
      async sample() {
        const positions = [];
        for (let frameIndex = 0; frameIndex < 30; frameIndex++) {
          positions.push({
            ...anchor(),
            connected: element.isConnected,
            display: getComputedStyle(element.closest(".chat-position-rail")!).display,
            contentHeight: contentHeight(),
          });
          await frame();
        }
        return positions;
      },
    };
  }, anchorIndex);
  const sampleAnchor = () => probe.evaluate((state) => state.sample());
  const assertAnchor = async (
    samples: ReturnType<typeof sampleAnchor>,
    allowShortTranscript = false,
    anchor = { track: collapsed.top, tick: tickTop },
  ) => {
    for (const position of await samples) {
      if (allowShortTranscript && position.contentHeight <= MIN_READER_HEIGHT) {
        expect(position).toMatchObject({ connected: true, display: "none" });
        continue;
      }
      expect(position).toMatchObject({ connected: true, display: "block", ...anchor });
    }
  };
  for (const open of [true, false, true, false, true]) {
    const samples = sampleAnchor();
    await summary.click();
    await expect
      .poll(() => card.evaluate((element) => (element as HTMLDetailsElement).open))
      .toBe(open);
    await expect.poll(() => boxHeight(composer)).toBe(collapsedComposer.height);
    await assertAnchor(samples);
    expect((await bounds()).top).toBe(collapsed.top);
    expect((await anchorTick.boundingBox())!.y).toBe(tickTop);
  }
  await detailsToggle.click();
  await details.waitFor({ state: "hidden" });
  const expandedHeight = await boxHeight(marks);
  const textarea = page.locator(".agent-chat__composer-combobox textarea");
  const beforeDraft = await textarea.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
  }));
  const beforeDraftComposer = await boxHeight(composer);
  const expandedDraft = "Review note: keep navigation visible.\n".repeat(5) + "Review note.";
  const textareaSamples = sampleAnchor();
  await textarea.fill(expandedDraft);
  await expect
    .poll(() => boxHeight(textarea))
    .toBeGreaterThanOrEqual(beforeDraft.height + beforeDraft.lineHeight * 4);
  await expect.poll(() => boxHeight(composer)).toBeGreaterThan(beforeDraftComposer);
  await assertAnchor(textareaSamples);
  expect((await bounds()).top).toBe(collapsed.top);
  expect((await anchorTick.boundingBox())!.y).toBe(tickTop);
  if (count === 80) {
    expect(await boxHeight(marks)).toBeLessThan(expandedHeight);
    expect(await marks.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );
  }
  if (count === 80 && direction === "ltr") {
    for (const coalesced of [false, true]) {
      if (coalesced) {
        const expansionSamples = sampleAnchor();
        await textarea.fill(expandedDraft);
        await assertAnchor(expansionSamples);
      }
      const goalSamples = sampleAnchor();
      if (coalesced) {
        // Both composer resizes can precede the next transcript observation.
        await textarea.evaluate((element) => {
          const input = element as HTMLTextAreaElement;
          input.value = "/goal";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Enter",
              bubbles: true,
              cancelable: true,
            }),
          );
        });
      } else {
        await textarea.fill("/goal");
        await textarea.press("Enter");
      }
      await page.locator(".agent-chat__goal-mode").waitFor();
      await assertAnchor(goalSamples);
      await expect.poll(() => readPositionRailGeometry(page)).toMatchObject({ atEnd: true });
      await expect
        .poll(() => page.locator(".chat-scroll-to-bottom").getAttribute("data-visible"))
        .toBe("false");
      const cancelSamples = sampleAnchor();
      await textarea.press("Escape");
      await page.locator(".agent-chat__goal-mode").waitFor({ state: "hidden" });
      await assertAnchor(cancelSamples);
    }
    await gateway.setOnline(false);
    await gateway.closeLatest();
    await page.locator(".agent-chat__input--offline").waitFor();
    const queuedTexts = ["Review the next checkpoint", "Check the supporting notes"];
    for (const text of queuedTexts) {
      const queueSamples = sampleAnchor();
      await textarea.fill(text);
      await textarea.press("Enter");
      await page.locator(".chat-queue__item", { hasText: text }).waitFor();
      await assertAnchor(queueSamples, true);
    }
    // Without docked progress, use a shorter window to reach the same rail cutoff.
    await page.setViewportSize({ width: 1440, height: 600 });
    // Window resizing moves the rail; only subsequent composer changes retain its anchor.
    const resizedAnchor = await probe.evaluate((state) => state.afterResize());
    const shortTranscriptSamples = sampleAnchor();
    await textarea.fill("Keep the complete review draft available.\n".repeat(12));
    await track.waitFor({ state: "hidden" });
    await assertAnchor(shortTranscriptSamples, true, resizedAnchor);
    const transcriptContentHeight = () => probe.evaluate((state) => state.contentHeight());
    expect(await transcriptContentHeight()).toBeLessThanOrEqual(MIN_READER_HEIGHT);
    await textarea.fill("");
    for (const text of queuedTexts) {
      await page
        .locator(".chat-queue__item", { hasText: text })
        .locator(".chat-queue__remove")
        .click();
    }
    await expect.poll(() => page.locator(".chat-queue__item").count()).toBe(0);
    await page.setViewportSize({ width: 1440, height: 900 });
    await track.waitFor({ state: "visible" });
    await expect.poll(transcriptContentHeight).toBeGreaterThan(MIN_READER_HEIGHT);
    await expect.poll(async () => (await bounds()).top).toBe(collapsed.top);
  }
  await expect
    .poll(() =>
      marks.evaluate(async (element) => {
        const height = element.getBoundingClientRect().height;
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        return height === element.getBoundingClientRect().height;
      }),
    )
    .toBe(true);
  expect(
    await marks.evaluate(
      (element) =>
        element.getBoundingClientRect().height >=
        element.querySelector(".chat-position-rail__marker")!.getBoundingClientRect().height,
    ),
  ).toBe(true);
  await transcript.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Home");
  for (let index = 0; index < count; index++) {
    if (index > 0) {
      await page.keyboard.press("ArrowDown");
    }
    await expect.poll(() => markerFits(markerForIndex(index), true)).toBe(true);
  }
  const preview = page.locator(".chat-position-rail__preview");
  const previewClearsComposer = () =>
    preview.evaluate(
      (element) =>
        element.getBoundingClientRect().bottom <=
        document.querySelector(".agent-chat__composer-shell")!.getBoundingClientRect().top,
    );
  await expect.poll(() => preview.textContent()).toContain(`checkpoint ${count}:`);
  await expect.poll(previewClearsComposer).toBe(true);
  const previewBounds = (await preview.boundingBox())!;
  expect(previewBounds.x).toBeGreaterThanOrEqual(transcriptBounds.x);
  expect(previewBounds.x + previewBounds.width).toBeLessThanOrEqual(
    transcriptBounds.x + transcriptBounds.width,
  );
  await markers.last().press("Escape");
  // The button is already visible; avoid locator hover's extra scrollIntoView.
  const point = await markers.last().evaluate((element) => {
    const markerBounds = element.getBoundingClientRect();
    const x = markerBounds.x + markerBounds.width / 2;
    const y = markerBounds.y + markerBounds.height / 2;
    return { x, y, hitsMarker: element.contains(document.elementFromPoint(x, y)) };
  });
  expect(point.hitsMarker).toBe(true);
  await page.mouse.move(point.x, point.y);
  await expect.poll(() => preview.textContent()).toContain(`checkpoint ${count}:`);
  await expect.poll(previewClearsComposer).toBe(true);
  await page.mouse.move(900, 20);
  await markers.last().press("Home");
  await browserExpect(markers.first()).toBeFocused();
  await markers.first().press("End");
  await browserExpect(markers.last()).toBeFocused();
  await markers.last().press("Escape");
  if (count === 80 && direction === "ltr") {
    await transcript.focus();
    await page.keyboard.press("ControlOrMeta+f");
    await page.locator(".agent-chat__search-bar input").fill("Conversation checkpoint 80:");
    await expect.poll(() => markers.count()).toBe(1);
    await expect.poll(() => markerFits(markers.first())).toBe(true);
    await page.locator(".agent-chat__search-bar button").click();
    await expect.poll(() => markers.first().getAttribute("aria-label")).toContain(`of ${count}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await track.waitFor({ state: "hidden" });
  if (count === 80 && direction === "ltr") {
    await waitForChatScrollIdle(page);
    await scrollChatThreadToTop(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await track.waitFor();
    await expect.poll(() => markerFits(marks.locator('[aria-current="true"]'))).toBe(true);
  }
}

async function readBottomDock(page: Page) {
  const sessionKey = "agent:main:main";
  await installMockGateway(page, {
    sessionKey,
    historyMessages: railMessages(
      80,
      "docked-rail",
      (index) => `Review checkpoint ${index + 1} and its supporting notes.`,
    ),
  });
  await page.addInitScript(createControlUiMockSameOriginGatewayScript());
  const settings = {
    sessionKey,
    sidebarSessionLayouts: {
      [sessionKey]: {
        columns: [
          {
            id: "side-panel-column",
            side: "right",
            panels: [{ id: "workspace", slot: "workspace" }],
            activePanelId: "workspace",
            height: 700,
            width: 480,
          },
        ],
        dock: "bottom",
        open: true,
        expanded: false,
      },
    },
  };
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
    value: settings,
  });
  await page.goto(`${suite.server.baseUrl}chat`);
  await page.locator(".sidebar-region--bottom.sidebar-region--open").waitFor();
  const { transcript, track, marks } = chat(page);
  const first = marks.locator(".chat-position-rail__marker").first();
  await first.waitFor();
  await waitForChatScrollIdle(page);
  await expectPositionRailAtEnd(page);
  await transcript.hover();
  await page.mouse.wheel(0, -30000);
  await expect.poll(() => scrollTop(transcript)).toBe(0);
  await waitForChatScrollIdle(page);
  const top = (await track.boundingBox())!.y;
  await transcript.evaluate((element) => {
    element.scrollTop = 200;
  });
  await expect.poll(() => scrollTop(transcript)).toBe(200);
  expect((await track.boundingBox())!.y).toBe(top);
  await marks.evaluate((element) => {
    element.scrollTop = 0;
  });
  const preview = page.locator(".chat-position-rail__preview");
  for (const keyboard of [false, true]) {
    if (keyboard) {
      await page.mouse.move(900, 20);
      await transcript.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Home");
      await browserExpect(first).toBeFocused();
    } else {
      await first.hover();
    }
    await preview.waitFor();
    expect((await preview.boundingBox())!.y).toBeGreaterThanOrEqual(
      (await transcript.boundingBox())!.y,
    );
  }
}

suite.define(() => {
  it.each([false, true])(
    "reveals the current marker when navigation and composer resize share a frame (navigation first: %s)",
    (navigationFirst) => railPage((page) => resizeAndNavigate(page, navigationFirst)),
  );

  it.each([
    { count: 1, direction: "ltr" },
    { count: 2, direction: "ltr" },
    { count: 5, direction: "ltr" },
    { count: 8, direction: "ltr" },
    { count: 80, direction: "ltr" },
    { count: 80, direction: "rtl" },
  ])(
    "keeps the rail anchored as Details progress toggles and the composer grows ($count, $direction messages)",
    ({ count, direction }) => railPage((page) => keepRailAnchored(page, count, direction)),
  );
  it("keeps the rail and its first preview clear in a bottom-docked chat pane", () =>
    railPage(readBottomDock, { viewport: { width: 1440, height: 1440 }, reducedMotion: "reduce" }));
});
