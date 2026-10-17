import type { Locator, Page } from "playwright";
import { expect as browserExpect } from "playwright/test";
import { expect, it } from "vitest";
import { SIDEBAR_GEOMETRY_COMMIT_EVENT } from "../pages/chat/sidebar-layout.ts";
import {
  controlUiBundledSettingsStorageKey,
  createControlUiMockSameOriginGatewayScript,
} from "../test-helpers/control-ui-e2e.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

const scrollTop = (locator: Locator) => locator.evaluate((element) => element.scrollTop);
const readStyle = (locator: Locator, property: string) =>
  locator.evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property);
const readStyles = (locator: Locator, properties: string[]) =>
  locator.evaluateAll(
    (elements, names) =>
      elements.map((element) => {
        const css = getComputedStyle(element);
        return names.map((name) => css.getPropertyValue(name));
      }),
    properties,
  );
async function press(target: Page["keyboard"] | Locator, ...keys: string[]) {
  for (const key of keys) {
    await target.press(key);
  }
}
const railCount = (rail: Locator) =>
  rail.evaluate((element) =>
    Number((element as HTMLElement).style.getPropertyValue("--chat-position-rail-count")),
  );
const relativeBounds = (locator: Locator, parent: string) =>
  locator.evaluate((element, ancestor) => {
    const rect = element.getBoundingClientRect();
    const container = element.closest(ancestor)!;
    const viewport = container.getBoundingClientRect();
    return {
      top: rect.top - viewport.top,
      bottom: rect.bottom - viewport.top,
      height: viewport.height,
      clientHeight: container.clientHeight,
    };
  }, parent);
const fits = async (locator: Locator, parent: string, clientHeight = false) => {
  const bounds = await relativeBounds(locator, parent);
  return bounds.top >= 0 && bounds.bottom <= (clientHeight ? bounds.clientHeight : bounds.height);
};
const setScrollTop = (locator: Locator, offset: number) =>
  locator.evaluate((element, top) => {
    element.scrollTop = top;
  }, offset);
const setStyle = (locator: Locator, name: string, value = "") =>
  locator.evaluate((element, style) => element.style.setProperty(style.name, style.value), {
    name,
    value,
  });
async function prepareRailPage(page: Page, colorScheme: "dark" | "light") {
  await page.addInitScript(createControlUiMockSameOriginGatewayScript());
  await page.addInitScript(
    ({ key, mode }) => {
      const settings = JSON.parse(localStorage.getItem(key) ?? "{}");
      settings.theme = settings.themeMode = mode;
      localStorage.setItem(key, JSON.stringify(settings));
    },
    { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), mode: colorScheme },
  );
  await page.goto(`${suite.server.baseUrl}chat`);
}

async function trackReader(page: Page, colorScheme: "dark" | "light") {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const messages = Array.from({ length: 240 }, (_, index) => ({
    __openclaw: { id: `position-rail-${index}`, seq: index + 1 },
    content:
      index === 0
        ? [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII=",
              },
            },
          ]
        : [
            {
              type: "text",
              text:
                index === 1
                  ? "![Preview](data:image/gif;base64,R0lGODlhAAQABIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7)"
                  : `Transcript **checkpoint ${index}** with \`code\` and *emphasis*.`,
            },
          ],
    role: index % 2 === 0 ? "user" : "assistant",
    timestamp: Date.UTC(2026, 8, 4, 12, index),
  }));
  const gateway = await installMockGateway(page, { historyMessages: messages });
  await prepareRailPage(page, colorScheme);
  const transcript = page.locator(".chat-thread");
  await transcript
    .locator(".chat-virtual-row")
    .getByText("Transcript checkpoint 239 with code and emphasis.", { exact: true })
    .waitFor();

  const rail = page.locator(".chat-position-rail");
  const markers = rail.locator(".chat-position-rail__marker");
  const markerForIndex = (index: number) =>
    rail.locator(`[data-position-marker-id="position-rail-${index}"]`);
  const logicalCount = () => railCount(rail);
  const showMarker = async (index: number) => {
    await setScrollTop(rail.locator(".chat-position-rail__marks"), index * 12);
    await markerForIndex(index).waitFor();
  };
  const preview = rail.locator(".chat-position-rail__preview-copy");
  await markers.first().waitFor();
  await expect.poll(logicalCount).toBe(240);
  expect(await markers.count()).toBeLessThan(100);
  const track = rail.locator(".chat-position-rail__track");
  const trackBounds = (await track.boundingBox())!;
  const transcriptBounds = (await transcript.boundingBox())!;
  const contentBounds = (await transcript.locator(".chat-thread-inner").boundingBox())!;
  const conversationBounds = (await page.locator(".chat-main__conversation").boundingBox())!;
  expect(trackBounds.x).toBeGreaterThanOrEqual(transcriptBounds.x);
  expect(trackBounds.x + trackBounds.width).toBeLessThan(contentBounds.x);
  expect(trackBounds.height).toBeCloseTo(900 * 0.45, 2);
  const centerY = ({ y, height }: { y: number; height: number }) => y + height / 2;
  expect(Math.abs(centerY(trackBounds) - centerY(conversationBounds))).toBeLessThan(2);
  const markBounds = await markers.evaluateAll((items) =>
    items.map((item) => ({
      ...item.getBoundingClientRect().toJSON(),
      index: Number(item.getAttribute("data-position-marker-id")!.split("-").at(-1)),
    })),
  );
  expect(Math.min(...markBounds.map((bounds) => bounds.width))).toBeGreaterThanOrEqual(44);
  for (let index = 1; index < markBounds.length; index++) {
    expect(markBounds[index]!.y - markBounds[index - 1]!.y).toBeCloseTo(
      (markBounds[index]!.index - markBounds[index - 1]!.index) * 12,
      2,
    );
  }
  expect(await markers.first().getAttribute("aria-label")).toContain(
    `${markBounds[0]!.index + 1} of 240`,
  );
  expect(await markerForIndex(239).getAttribute("aria-label")).toContain("240 of 240");
  expect(await preview.count()).toBe(0);
  expect(await rail.locator('[role="status"]').count()).toBe(0);

  // Exercise the composite through real Tab navigation, including reentry.
  const focusedMarkerId = () =>
    page.evaluate(() => document.activeElement?.getAttribute("data-position-marker-id"));
  const currentMarkerId = () =>
    rail.locator('[aria-current="true"]').getAttribute("data-position-marker-id");
  const tabIntoCurrentPosition = async () => {
    // Layout can publish a new reader position between host-side browser calls.
    const entry = await rail.evaluateHandle((element) => {
      const ids = (selector: string) =>
        [...element.querySelectorAll(selector)].map((marker) =>
          marker.getAttribute("data-position-marker-id"),
        );
      let currentIds: Array<string | null> = [],
        tabStopIds: Array<string | null> = [];
      const captureEntry = (event: KeyboardEvent) => {
        if (event.key !== "Tab" || event.shiftKey) {
          return;
        }
        currentIds = ids('[aria-current="true"]');
        tabStopIds = ids('[tabindex="0"]');
      };
      element.ownerDocument.addEventListener("keydown", captureEntry, true);
      return {
        read: () => ({ currentIds, tabStopIds }),
        dispose: () => element.ownerDocument.removeEventListener("keydown", captureEntry, true),
      };
    });
    try {
      await page.keyboard.press("Tab");
      const { currentIds, tabStopIds } = await entry.evaluate((probe) => probe.read());
      expect(currentIds).toHaveLength(1);
      expect(currentIds[0]).not.toBeNull();
      expect(tabStopIds).toEqual(currentIds);
      await expect.poll(focusedMarkerId).toBe(currentIds[0]);
    } finally {
      await entry.evaluate((probe) => probe.dispose());
      await entry.dispose();
    }
  };
  await expect.poll(() => rail.locator('[aria-current="true"]').count()).toBe(1);
  await transcript.focus();
  await tabIntoCurrentPosition();
  await press(page.keyboard, "Home", "ArrowDown");
  await expect.poll(focusedMarkerId).toBe("position-rail-1");
  await expect.poll(() => preview.count()).toBe(1);
  await page.keyboard.press("ArrowUp");
  await expect.poll(focusedMarkerId).toBe("position-rail-0");
  await expect.poll(() => rail.locator('[tabindex="0"]').count()).toBe(1);
  await page.keyboard.press("Tab");
  expect(await focusedMarkerId()).toBeNull();
  await transcript.focus();
  await tabIntoCurrentPosition();
  await page.keyboard.press("Shift+Tab");
  await browserExpect(transcript).toBeFocused();
  await press(page.keyboard, "Tab", "Home", "Enter");
  await expect.poll(() => scrollTop(transcript)).toBe(0);
  await page.keyboard.press("Escape");
  await browserExpect(transcript).toBeFocused();
  await expect.poll(() => preview.count()).toBe(0);
  await press(page.keyboard, "Tab", "End", " ");
  await expect.poll(currentMarkerId).toBe("position-rail-239");
  await page.keyboard.press("Escape");

  const currentMarkerIndex = async () => Number((await currentMarkerId())!.split("-").at(-1));
  const scroller = rail.locator(".chat-position-rail__marks");
  const fades = () =>
    scroller.evaluate((element) => ({
      top: element.hasAttribute("data-overflow-top"),
      bottom: element.hasAttribute("data-overflow-bottom"),
    }));
  const currentIsVisible = () =>
    fits(scroller.locator('[aria-current="true"]'), ".chat-position-rail__marks");
  const ticks = markers.locator(".chat-position-rail__tick");
  const strokeSizes = async () => [
    ...new Set((await readStyles(ticks, ["width", "height"])).map((size) => size.join(" × "))),
  ];
  await page.mouse.move(700, 80);
  await expect.poll(strokeSizes).toEqual(["8px × 2px"]);
  const colors = await rail.evaluate((element) => {
    const probe = document.createElement("span");
    element.append(probe);
    probe.style.color = "var(--muted)";
    const muted = getComputedStyle(probe).color;
    probe.style.color = "var(--text)";
    const text = getComputedStyle(probe).color;
    probe.remove();
    return { muted, text };
  });
  const tick = (index: number) => markerForIndex(index).locator(".chat-position-rail__tick");
  const strokeColor = (index: number) => readStyle(tick(index), "background-color");
  const visibilityMatchesViewport = () =>
    transcript.evaluate((element) => {
      const viewport = element.getBoundingClientRect();
      const marks = [...element.querySelectorAll<HTMLElement>(".chat-position-rail__marker")];
      const ids = new Set(marks.map((mark) => mark.dataset.positionMarkerId));
      const expected = [...element.querySelectorAll<HTMLElement>(".chat-bubble[data-entry-id]")]
        .filter((bubble) => {
          const rect = bubble.getBoundingClientRect();
          return (
            ids.has(bubble.dataset.entryId) &&
            rect.height > 0 &&
            rect.bottom > viewport.top &&
            rect.top < viewport.bottom
          );
        })
        .map((bubble) => bubble.dataset.entryId);
      const actual = new Set(
        [...element.querySelectorAll<HTMLElement>(".chat-position-rail__marker[data-visible]")].map(
          (mark) => mark.dataset.positionMarkerId,
        ),
      );
      return (
        expected.length > 1 &&
        expected.length === actual.size &&
        expected.every((id) => actual.has(id))
      );
    });
  await expect.poll(visibilityMatchesViewport).toBe(true);
  await expect.poll(currentMarkerIndex).toBe(239);
  const invisibleTick = rail
    .locator(".chat-position-rail__marker:not([data-visible]) .chat-position-rail__tick")
    .first();
  expect(await readStyle(invisibleTick, "background-color")).toMatch(/\/ 0\.4\)$/);
  expect(await strokeColor(239)).toBe(colors.muted);
  await expect.poll(fades).toEqual({ top: true, bottom: false });
  await expect.poll(currentIsVisible).toBe(true);
  await transcript.evaluate((element) => {
    element.scrollTop = Math.round((element.scrollHeight - element.clientHeight) / 2);
  });
  await expect.poll(currentMarkerIndex).toBeGreaterThan(50);
  await expect.poll(currentMarkerIndex).toBeLessThan(200);
  await expect.poll(fades).toEqual({ top: true, bottom: true });
  await expect.poll(visibilityMatchesViewport).toBe(true);
  await expect.poll(currentIsVisible).toBe(true);

  // Crossing the midpoint can change the anchor while the visible cohort stays fixed.
  const crossingOffset = await transcript.evaluate((element) => {
    const row = element
      .querySelector('[data-entry-id="position-rail-121"]')!
      .closest(".chat-virtual-row")!;
    return (
      element.scrollTop +
      row.getBoundingClientRect().top -
      element.getBoundingClientRect().top -
      element.clientHeight / 2
    );
  });
  const visibleMarkerIds = () =>
    markers.evaluateAll((items) =>
      items
        .filter((item) => item.hasAttribute("data-visible"))
        .map((item) => item.getAttribute("data-position-marker-id")),
    );
  await setScrollTop(transcript, crossingOffset - 2);
  await expect.poll(currentMarkerIndex).toBe(120);
  await expect.poll(visibilityMatchesViewport).toBe(true);
  const cohort = await visibleMarkerIds();
  await setScrollTop(transcript, crossingOffset + 2);
  await expect.poll(currentMarkerIndex).toBe(121);
  expect(await visibleMarkerIds()).toEqual(cohort);
  await setScrollTop(transcript, crossingOffset - 2);
  await expect.poll(currentMarkerIndex).toBe(120);
  expect(await visibleMarkerIds()).toEqual(cohort);

  // Wheel exploration stays within the rail and does not snap back to the active mark.
  const readerOffset = await scrollTop(transcript);
  await scroller.hover();
  await page.mouse.wheel(0, -6000);
  await expect.poll(() => scrollTop(scroller)).toBe(0);
  await expect.poll(fades).toEqual({ top: false, bottom: true });
  await markerForIndex(1).hover();
  const previewImage = preview.locator("img");
  await expect
    .poll(() => previewImage.evaluate((image: HTMLImageElement) => image.naturalHeight))
    .toBe(1024);
  expect(
    await preview.evaluate(
      (element) =>
        element.getBoundingClientRect().height /
        Number.parseFloat(getComputedStyle(element).lineHeight),
    ),
  ).toBeLessThanOrEqual(3.01);
  await page.mouse.move(600, 100);

  await markerForIndex(4).hover();
  await expect.poll(() => preview.textContent()).toContain("Transcript checkpoint 4");
  expect(await preview.locator("strong, code, em").allTextContents()).toEqual([
    "checkpoint 4",
    "code",
    "emphasis",
  ]);
  expect(await scrollTop(transcript)).toBe(readerOffset);
  expect(await scrollTop(scroller)).toBe(0);
  // Pointer focus must not move an edge mark before its click completes.
  await showMarker(60);
  const edgeBounds = (await markerForIndex(60).boundingBox())!;
  await page.mouse.move(edgeBounds.x + 5, edgeBounds.y + edgeBounds.height / 2);
  await page.mouse.down();
  const pressedBounds = (await markerForIndex(60).boundingBox())!;
  await page.mouse.up();
  expect(pressedBounds.y).toBeCloseTo(edgeBounds.y, 2);
  const edgeTarget = transcript.locator('.chat-bubble[data-entry-id="position-rail-60"]');
  await expect.poll(() => fits(edgeTarget, ".chat-thread")).toBe(true);
  await page.mouse.move(700, 80);
  await setScrollTop(transcript, 0);
  await expect.poll(currentMarkerIndex).toBeLessThan(10);
  await expect.poll(currentIsVisible).toBe(true);

  const composer = page.locator(".agent-chat__composer-combobox textarea");
  await composer.focus();
  await expect.poll(visibilityMatchesViewport).toBe(true);
  const strokeColors = async () => (await readStyles(ticks, ["background-color"])).flat();
  // The tick animates its background after visibility changes. Capture
  // each marker's target color, not a transient animation frame.
  const restingColors = await markers.evaluateAll((items) =>
    items.map((item) => getComputedStyle(item).color),
  );
  await markerForIndex(4).hover();
  await expect.poll(() => preview.textContent()).toContain("Transcript checkpoint 4");
  const waveWidths = async () =>
    (await readStyles(ticks, ["width"])).slice(0, 9).map(([width]) => Number.parseFloat(width!));
  const expectedWave = [8, 12, 16, 24, 32, 24, 16, 12, 8];
  const expectWave = async () => {
    await expect.poll(waveWidths).toEqual(expectedWave);
    await expect
      .poll(strokeColors)
      .toEqual(restingColors.map((color, index) => (index === 4 ? colors.text : color)));
  };
  await expectWave();

  const previewBounds = await preview.boundingBox();
  expect(previewBounds).not.toBeNull();
  await page.mouse.move(
    previewBounds!.x + previewBounds!.width / 2,
    previewBounds!.y + previewBounds!.height / 2,
    { steps: 20 },
  );
  expect(await preview.textContent()).toContain("Transcript checkpoint 4");
  await expectWave();
  await page.keyboard.press("Escape");
  await expect.poll(() => preview.count()).toBe(0);
  await expect.poll(strokeSizes).toEqual(["8px × 2px"]);
  await browserExpect(composer).toBeFocused();

  await page.mouse.move(600, 100);
  await markerForIndex(4).hover();
  await expect.poll(() => preview.textContent()).toContain("Transcript checkpoint 4");
  await page.mouse.move(600, 100);
  await expect.poll(() => preview.count()).toBe(0);
  await expect.poll(strokeSizes).toEqual(["8px × 2px"]);
  await expect.poll(visibilityMatchesViewport).toBe(true);
  await markers.first().hover();
  await expect.poll(async () => (await preview.textContent())?.trim()).toBe("Preview unavailable");
  expect(await preview.boundingBox()).not.toBeNull();
  await page.mouse.move(600, 100);
  await markerForIndex(5).focus();
  await expect.poll(() => preview.textContent()).toContain("Transcript checkpoint 5");
  await markerForIndex(5).press("ArrowDown");
  await expect.poll(focusedMarkerId).toBe("position-rail-6");
  await expect.poll(() => preview.textContent()).toContain("Transcript checkpoint 6");
  expect(await readStyle(tick(6), "width")).toBe("8px");
  await showMarker(120);
  await markerForIndex(120).focus();
  await expect.poll(() => preview.textContent()).toContain("Transcript checkpoint 120");
  expect(await scrollTop(transcript)).toBe(0);
  const focusedBounds = await relativeBounds(markerForIndex(120), ".chat-position-rail__marks");
  expect(focusedBounds.top).toBeGreaterThan(60);
  expect(focusedBounds.bottom).toBeLessThan(focusedBounds.height - 60);
  const flashPaint = (index: number) =>
    transcript
      .locator(`.chat-bubble[data-entry-id="position-rail-${index}"]`)
      .evaluate((element) => {
        const overlay = getComputedStyle(element, "::after");
        return overlay.content !== "none" && Number.parseFloat(overlay.opacity) > 0;
      });
  const clickAndObserveFlash = async (index: number, animated: boolean) => {
    // Retain the transient paint in the renderer before a delayed host can miss it.
    const observation = await transcript.evaluateHandle((element: HTMLElement, position) => {
      const id = `position-rail-${position}`;
      let clicked = false;
      let animationStarted = false;
      let paint: { visible: boolean; animated: boolean; outline: string } | null = null;
      const sample = () => {
        const bubble = clicked && element.querySelector(`.chat-bubble[data-entry-id="${id}"]`);
        if (!bubble) {
          return;
        }
        const overlay = getComputedStyle(bubble, "::after");
        const rect = bubble.getBoundingClientRect();
        const viewport = element.getBoundingClientRect();
        if (
          overlay.content !== "none" &&
          Number.parseFloat(overlay.opacity) > 0 &&
          (overlay.animationName === "none" || animationStarted) &&
          rect.top >= viewport.top &&
          rect.bottom <= viewport.bottom
        ) {
          paint = {
            visible: true,
            animated: overlay.animationName !== "none",
            outline: getComputedStyle(bubble).outlineStyle,
          };
        }
      };
      const onEvent = (event: Event) => {
        const target = event.target;
        if (
          event.type === "click" &&
          target instanceof Element &&
          target.closest("[data-position-marker-id]")?.getAttribute("data-position-marker-id") ===
            id
        ) {
          clicked = true;
        }
        const ownAnimation =
          clicked &&
          event instanceof AnimationEvent &&
          target instanceof Element &&
          target.getAttribute("data-entry-id") === id &&
          event.pseudoElement === "::after";
        if (ownAnimation) {
          animationStarted = true;
        }
        if (ownAnimation || event.type === "scroll") {
          sample();
        }
      };
      const mutations = new MutationObserver(sample);
      mutations.observe(element, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["class"],
      });
      const events = ["click", "animationstart", "scroll"];
      events.forEach((type) => element.addEventListener(type, onEvent, true));
      return {
        read: () => paint,
        disconnect: () => {
          mutations.disconnect();
          events.forEach((type) => element.removeEventListener(type, onEvent, true));
        },
      };
    }, index);
    try {
      await markerForIndex(index).click();
      await expect
        .poll(() => observation.evaluate((entry) => entry.read()))
        .toEqual({ visible: true, animated, outline: "none" });
      await expect.poll(() => flashPaint(index)).toBe(false);
    } finally {
      try {
        await observation.evaluate((entry) => entry.disconnect());
      } finally {
        await observation.dispose();
      }
    }
  };
  for (const index of [120, 121]) {
    await clickAndObserveFlash(index, true);
  }
  await markerForIndex(120).press("Escape");
  await expect.poll(() => preview.count()).toBe(0);
  await markerForIndex(120).press("Home");
  await browserExpect(markerForIndex(0)).toBeFocused();
  await markerForIndex(0).press(" ");
  await expect.poll(() => scrollTop(transcript)).toBe(0);
  await markerForIndex(0).press("End");
  await markerForIndex(239).press("Enter");
  await expect.poll(currentMarkerIndex).toBe(239);

  // Pane-local width matters even inside an otherwise wide desktop.
  await setStyle(transcript, "width", "800px");
  await markers.first().waitFor({ state: "hidden" });
  await setStyle(transcript, "width");
  await markers.first().waitFor({ state: "visible" });

  await page.setViewportSize({ height: 900, width: 900 });
  await markers.first().waitFor({ state: "hidden" });
  await page.setViewportSize({ height: 844, width: 390 });
  await markers.first().waitFor({ state: "hidden" });
  await page.setViewportSize({ height: 900, width: 1440 });
  await markers.first().waitFor({ state: "visible" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  // Global reduced-motion policy uses 0.01ms.
  expect(
    Number.parseFloat(
      await readStyle(markers.first().locator(".chat-position-rail__tick"), "transition-duration"),
    ),
  ).toBeLessThanOrEqual(0.00001);

  await showMarker(239);
  await clickAndObserveFlash(239, false);

  // Saved widths can consume the gutter even in a wide desktop pane.
  for (const width of ["100%", "none", "95%", "48rem"]) {
    await page.goto(`${suite.server.baseUrl}settings/appearance#settings-appearance-chat`);
    const widthInput = page.locator("[data-settings-chat-message-width]");
    await widthInput.fill(width);
    await widthInput.press("Tab");
    await expect
      .poll(() =>
        page.evaluate(
          (key) => JSON.parse(localStorage.getItem(key) ?? "{}").chatMessageMaxWidth,
          controlUiBundledSettingsStorageKey(suite.server.baseUrl),
        ),
      )
      .toBe(width);
    await page.goto(`${suite.server.baseUrl}chat`);
    await transcript.locator('.chat-bubble[data-entry-id="position-rail-239"]').waitFor();
    await expect
      .poll(() =>
        transcript.evaluate((element) =>
          getComputedStyle(element).getPropertyValue("--chat-thread-max-width").trim(),
        ),
      )
      .toBe(width);
    await markers.first().waitFor({ state: width === "48rem" ? "visible" : "hidden" });
    if (width === "48rem") {
      const inner = await transcript.locator(".chat-thread-inner").boundingBox();
      const marker = await markers.first().boundingBox();
      expect(inner!.x - (marker!.x + marker!.width)).toBeGreaterThanOrEqual(10);
    }
  }
  // A foreign-host commit can change the inner column while the pane's
  // own dimensions stay fixed. Exercise that existing event boundary.
  for (const width of ["95%", "48rem"]) {
    await transcript.evaluate(
      (element, { columnWidth, eventName }) => {
        element.style.setProperty("--chat-thread-max-width", columnWidth);
        element.dispatchEvent(
          new CustomEvent(eventName, {
            bubbles: true,
            detail: { widthChanged: false },
          }),
        );
      },
      { columnWidth: width, eventName: SIDEBAR_GEOMETRY_COMMIT_EVENT },
    );
    await markers.first().waitFor({ state: width === "48rem" ? "visible" : "hidden" });
  }
  await setStyle(transcript, "--chat-thread-max-width");
  await transcript.hover();
  await page.mouse.wheel(0, -100000);
  await expect.poll(() => scrollTop(transcript)).toBe(0);
  await transcript.focus();
  await press(page.keyboard, "Tab", "End");
  const exploredMarker = markerForIndex(239);
  await expect.poll(focusedMarkerId).toBe("position-rail-239");
  const exploredTop = (await exploredMarker.boundingBox())!.y;
  await gateway.setHistoryMessages([
    ...messages,
    {
      role: "assistant",
      content: [{ type: "text", text: "A new checkpoint arrived." }],
      __openclaw: { id: "incoming-checkpoint", seq: 241, runId: "incoming-rail-run" },
    },
  ]);
  await gateway.emitChatFinal({
    runId: "incoming-rail-run",
    text: "A new checkpoint arrived.",
  });
  await expect.poll(logicalCount).toBe(241);
  expect(await focusedMarkerId()).toBe("position-rail-239");
  expect((await exploredMarker.boundingBox())!.y).toBe(exploredTop);
  expect(await preview.isVisible()).toBe(true);
  expect(await preview.textContent()).toContain("checkpoint 239");
  expect(await scrollTop(transcript)).toBe(0);
  expect(pageErrors).toEqual([]);
}

async function trackContinuation(page: Page, colorScheme: "dark" | "light") {
  const message = (id: string, role: string, content: unknown, seq: number, runId?: string) => ({
    role,
    content,
    timestamp: (seq + 80) * 1_000,
    __openclaw: { id, seq: seq + 80, ...(runId ? { runId } : {}) },
  });
  const longReply =
    "The review preserves the request, explains the evidence, and records the decision. Each participant can check the source and understand the next step.\n\n".repeat(
      22,
    );
  await installMockGateway(page, {
    historyMessages: [
      ...Array.from({ length: 80 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `Earlier checkpoint ${index + 1}.` }],
        timestamp: (index + 1) * 1_000,
        __openclaw: { id: `earlier-${index}`, seq: index + 1 },
      })),
      message("question", "user", "Review the shared design", 1),
      message("first", "assistant", "I will inspect the design", 2, "review-run"),
      message(
        "call",
        "assistant",
        [
          {
            type: "toolCall",
            id: "read-1",
            name: "read",
            arguments: { path: "design.md" },
          },
        ],
        3,
        "review-run",
      ),
      {
        ...message("result", "toolResult", "The design was loaded", 4, "review-run"),
        toolName: "read",
        toolCallId: "read-1",
      },
      message("continuation", "assistant", longReply, 5, "review-run"),
      message("final", "assistant", "The shared design is ready", 6, "review-run"),
      message("next-question", "user", "Continue with the next review", 7),
      message("next-answer", "assistant", "Ready for the next review", 8, "next-run"),
    ],
  });
  await prepareRailPage(page, colorScheme);
  const thread = page.locator(".chat-thread");
  const marks = thread.locator(".chat-position-rail__marker");
  await expect.poll(() => railCount(thread.locator(".chat-position-rail"))).toBe(84);
  expect(await marks.count()).toBeLessThan(84);
  const runMarker = thread.locator('[data-position-marker-id="run:review-run"]');
  await thread.locator('.chat-position-rail__marker[tabindex="0"]').focus();
  await press(page.keyboard, "End", "ArrowUp", "ArrowUp");
  await browserExpect(runMarker).toBeFocused();
  await runMarker.press("Enter");
  const first = thread.locator('.chat-bubble[data-entry-id="first"]');
  await browserExpect(first).toHaveClass(/\bchat-bubble--reply-target\b/);
  await expect
    .poll(async () =>
      (await thread.locator(".chat-position-rail__preview-copy").textContent())?.trim(),
    )
    .toBe("The shared design is ready");
  const continuation = thread.locator('.chat-bubble[data-entry-id="continuation"]');
  await thread.hover();
  const bounds = await relativeBounds(continuation, ".chat-thread");
  await page.mouse.wheel(0, (bounds.top + bounds.bottom - bounds.clientHeight) / 2);
  await expect
    .poll(async () => {
      const rect = await relativeBounds(continuation, ".chat-thread");
      return rect.top < 0 && rect.bottom > rect.height;
    })
    .toBe(true);
  await browserExpect(runMarker).toHaveAttribute("aria-current", "true");
  await browserExpect(runMarker).toHaveAttribute("data-visible", "");
  expect(await thread.locator('.chat-position-rail__marker[aria-current="true"]').count()).toBe(1);
  expect((await relativeBounds(first, ".chat-thread")).bottom).toBeLessThan(0);
  const composerInput = page.locator(".agent-chat__composer-combobox textarea");
  const markerFits = () => fits(runMarker, ".chat-position-rail__marks", true);
  const markerBottomClearance = async () => {
    const rect = await relativeBounds(runMarker, ".chat-position-rail__marks");
    return rect.clientHeight - rect.bottom;
  };
  // Resize preserves the reader's rail offset; make its clipping precondition explicit.
  await composerInput.focus();
  await thread.locator(".chat-position-rail__marks").hover();
  await page.mouse.wheel(0, 1 - (await markerBottomClearance()));
  await expect
    .poll(async () => Math.abs((await markerBottomClearance()) - 1))
    .toBeLessThanOrEqual(1);
  await expect.poll(markerFits).toBe(true);
  await composerInput.fill(
    Array.from({ length: 6 }, (_, index) => `Review note ${index + 1}`).join("\n"),
  );
  await expect.poll(markerFits).toBe(false);
  const readerOffset = await scrollTop(thread);
  await thread.hover();
  await page.mouse.wheel(0, 120);
  await expect.poll(() => scrollTop(thread)).toBeGreaterThan(readerOffset);
  await expect.poll(() => runMarker.getAttribute("aria-current")).toBe("true");
  await expect.poll(markerFits).toBe(true);
  await composerInput.fill("");
  await runMarker.press("Enter");
  await expect.poll(() => fits(first, ".chat-thread")).toBe(true);
}

suite.define(() => {
  it.each(["dark", "light"] as const)(
    "tracks reader position and keyboard jumps in %s mode",
    async (colorScheme) => {
      await suite.withPage(
        {
          colorScheme,
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width: 1440 },
        },
        ({ page }) => trackReader(page, colorScheme),
      );
    },
  );
  it.each(["dark", "light"] as const)(
    "keeps one run current while reading its long continuation in %s mode",
    async (colorScheme) => {
      await suite.withPage({ colorScheme, viewport: { width: 1440, height: 900 } }, ({ page }) =>
        trackContinuation(page, colorScheme),
      );
    },
  );
});
