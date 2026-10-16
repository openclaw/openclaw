// Full-app behavior uses the shared production bundle, not a cold Vite graph
// inside the layout suite's browser-readiness deadline.
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPlaybackMediaFixture,
  type PlaybackMediaFixtureFormat,
} from "../../../test/fixtures/media-playback.js";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import { finishElementAnimations } from "../test-helpers/animations.ts";
import { closeBrowserPage } from "../test-helpers/browser-page.ts";
import {
  captureControlUiE2eFailureDiagnostics,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat responsive app behavior" });

// The shared bundled server owns compilation before browser readiness.
const APP_FIRST_RENDER_TIMEOUT_MS = 30_000;
const FULL_APP_TEST_OPTIONS = {
  // Shared-page interactions mutate viewport, pointer, and composer state. Keep
  // each as a sequential barrier so they cannot overlap one another.
  concurrent: false,
  timeout: 60_000,
} as const;
let sharedAppPage: Page | null = null;
let sharedAppPagePromise: Promise<Page> | null = null;
const sharedAppPageErrors: string[] = [];

const SHARED_APP_CONTEXT_TEXT = "Context hover regression fixture.";
const SHARED_APP_SLASH_TEXT = "Short landscape slash command keyboard regression fixture.";
const SHARED_APP_IMAGE_URL = "https://cdn.example/render%2Epng?download=1";
const SHARED_APP_ATTACHMENT_OUTCOME_TEXT = "Mixed attachment outcome fixture.";
const SHARED_APP_TTS_TEXT = "Audio generated and delivered via native TTS.";
const SHARED_APP_PLAYBACK_MEDIA = [
  ["voice---a75c70c7-0112-4d07-8fb5-40c82c979ee8.mp3", "audio", "audio/mpeg", "native"],
  ["reply.ogg", "audio", "audio/ogg", "transcode"],
  ["reply.m4a", "audio", "audio/x-m4a", "native"],
  ["reply.flac", "audio", "audio/flac", "transcode"],
  ["reply.mp4", "video", "video/mp4", "native"],
  ["reply.webm", "video", "video/webm", "transcode"],
] as const;
const sharedAppPlaybackRequests: string[] = [];
const COMPOSER = ".agent-chat__composer-combobox > textarea";
const CARD = ".chat-assistant-attachment-card";
const DESKTOP_VIEWPORT = { width: 1366, height: 900 };

function assistantMessage(content: unknown, minute: number) {
  return { content, role: "assistant", timestamp: Date.UTC(2026, 6, 9, 10, minute) };
}

function documentAttachment(label: string, fields: Record<string, string>, failed = true) {
  return {
    type: failed ? "attachment_error" : "attachment",
    attachment: { kind: "document", label, ...fields },
  };
}

function attachmentLayout(card: Element) {
  const part = (name: string) =>
    card.querySelector<HTMLElement>(`.chat-assistant-attachment-card__status-${name}`)!;
  const badge = part("badge").getBoundingClientRect();
  const reason = part("reason");
  const reasonRect = reason.getBoundingClientRect();
  const separator = part("separator");
  const separatorRect = separator.getBoundingClientRect();
  return {
    leftGap: separatorRect.left - badge.right,
    rightGap: reasonRect.left - separatorRect.right,
    badgeBottom: badge.bottom,
    cardBottom: card.getBoundingClientRect().bottom,
    cardClientWidth: card.clientWidth,
    cardScrollWidth: card.scrollWidth,
    reasonBottom: reasonRect.bottom,
    reasonRight: reasonRect.right,
    reasonTop: reasonRect.top,
    separatorDisplay: getComputedStyle(separator).display,
    reasonWhiteSpace: getComputedStyle(reason).whiteSpace,
  };
}

function contextLayout(node: Element, includeOverlay = false) {
  const rect = (selector: string) => node.querySelector(selector)!.getBoundingClientRect();
  return {
    footerHeight: rect(".chat-group-footer").height,
    groupHeight: node.getBoundingClientRect().height,
    contextBottom: includeOverlay ? rect(".msg-meta__details").bottom : 0,
    summaryTop: includeOverlay ? rect(".msg-meta__summary").top : 0,
  };
}

function messageContextState(group: Element) {
  const footer = group.querySelector(".chat-group-footer")!;
  const summary = group.querySelector(".msg-meta__summary")!;
  const details = group.querySelector(".msg-meta__details")!;
  const popup = group
    .querySelector("openclaw-tooltip.msg-meta")!
    .shadowRoot?.querySelector(".tooltip-surface[popover]");
  const rect = details.getBoundingClientRect();
  const target = document.elementFromPoint(rect.left + 8, rect.top + rect.height / 2);
  const summaryStyle = getComputedStyle(summary);
  return {
    rowContainment: getComputedStyle(group.closest(".chat-virtual-row")!).contentVisibility,
    topLayer: popup?.matches(":popover-open") ?? false,
    painted: target !== null && details.contains(target),
    footerOpacity: getComputedStyle(footer).opacity,
    summaryOpacity: summaryStyle.opacity,
    pointerEvents: summaryStyle.pointerEvents,
    summaryFocused: document.activeElement === summary,
    hovered: group.matches(":hover"),
    focused: group.matches(":focus-within"),
  };
}

async function waitForComposerResize(page: Page, previous: number, direction: number) {
  await page.waitForFunction(
    ({ selector, previous: oldHeight, direction: sign }) => {
      const element = document.querySelector(selector);
      return element !== null && (element.getBoundingClientRect().height - oldHeight) * sign > 1;
    },
    { selector: COMPOSER, previous, direction },
  );
}

function getSharedAppPage(): Promise<Page> {
  return (sharedAppPagePromise ??= createSharedAppPage());
}

async function createSharedAppPage(): Promise<Page> {
  // The five app assertions use disjoint fixture messages and reset mutable
  // page state, so one lazy boot preserves coverage without five graph loads.
  const page = await suite.browser.newPage({ viewport: DESKTOP_VIEWPORT });
  try {
    page.on("pageerror", (error) => sharedAppPageErrors.push(error.message));
    await page.route("https://cdn.example/**", async (route) => {
      const request = route.request();
      // Chromium normalizes the escaped dot before sending the image request.
      if (decodeURI(request.url()) === decodeURI(SHARED_APP_IMAGE_URL)) {
        await route.fulfill({
          contentType: "image/png",
          body: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHElEQVR4nGP4z8DwnxLMMGrAsDCAQv2jBgwPAwAxtf4Q24P5oAAAAABJRU5ErkJggg==",
            "base64",
          ),
        });
        return;
      }
      const fileName = decodeURIComponent(new URL(request.url()).pathname.split("/").at(-1) ?? "");
      const media = SHARED_APP_PLAYBACK_MEDIA.find(([candidate]) => candidate === fileName);
      if (!media) {
        await route.abort();
        return;
      }
      const format = fileName.split(".").at(-1) as PlaybackMediaFixtureFormat;
      const body = createPlaybackMediaFixture(format);
      sharedAppPlaybackRequests.push(request.url());
      await route.fulfill({
        status: 200,
        contentType: media[2],
        body: request.method() === "HEAD" ? Buffer.alloc(0) : body,
      });
    });
    await installMockGateway(page, {
      agentModel: "openai/gpt-5.5",
      assistantName: "Claw",
      historyMessages: [
        {
          // Keep context geometry independent of the lazily loaded media fixtures.
          __openclaw: { runId: "context-fixture-run" },
          content: [{ text: SHARED_APP_CONTEXT_TEXT, type: "text" }],
          model: "openai/gpt-5.5",
          role: "assistant",
          timestamp: Date.UTC(2026, 6, 5, 9, 51),
          usage: { cacheRead: 2_400, input: 19_600, output: 126 },
        },
        assistantMessage(`MEDIA:${SHARED_APP_IMAGE_URL}`, 0),
        assistantMessage(
          [
            { text: SHARED_APP_TTS_TEXT, type: "text" },
            ...SHARED_APP_PLAYBACK_MEDIA.map(([fileName, type, mimeType, playback]) => ({
              fileName,
              mimeType,
              playback,
              type,
              url: `https://cdn.example/${fileName}`,
            })),
          ],
          1,
        ),
        assistantMessage([{ text: SHARED_APP_SLASH_TEXT, type: "text" }], 2),
        assistantMessage(
          [
            { text: SHARED_APP_ATTACHMENT_OUTCOME_TEXT, type: "text" },
            documentAttachment(
              "deploy.yaml",
              {
                url: "https://files.example/deploy.yaml",
                mimeType: "application/yaml",
              },
              false,
            ),
            ...["settings.toml", "schema.sql", "events.ndjson", "font.ttf", "font.woff2"].map(
              (label) => documentAttachment(label, { code: "unsupported-format" }),
            ),
            documentAttachment("bundle.7z", {
              code: "delivery-failed",
              mimeType: "application/x-7z-compressed",
            }),
          ],
          3,
        ),
      ],
    });
    await page.goto(`${suite.server.baseUrl}chat/main`, {
      waitUntil: "domcontentloaded",
      timeout: APP_FIRST_RENDER_TIMEOUT_MS,
    });
    await page.getByText(SHARED_APP_SLASH_TEXT).waitFor({ timeout: APP_FIRST_RENDER_TIMEOUT_MS });
    sharedAppPage = page;
    return page;
  } catch (error) {
    // Closing the page discards its diagnostic ring and browser state.
    await captureControlUiE2eFailureDiagnostics(page, {
      error: error instanceof Error ? error : new Error(String(error)),
      label: "chat-responsive.shared-app-startup",
      pageErrors: sharedAppPageErrors,
    });
    await closeBrowserPage(page);
    throw error;
  }
}

async function expectNoHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    html: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(metrics.html).toBeLessThanOrEqual(metrics.viewport + 1);
  expect(metrics.body).toBeLessThanOrEqual(metrics.viewport + 1);
}

suite.define(() => {
  afterAll(async () => {
    await sharedAppPage?.close();
    sharedAppPage = null;
    sharedAppPagePromise = null;
  });

  it(
    "remeasures a populated composer when the viewport width changes",
    FULL_APP_TEST_OPTIONS,
    async () => {
      const page = await getSharedAppPage();
      const errorStart = sharedAppPageErrors.length;
      try {
        await page.setViewportSize({ width: 900, height: 800 });
        const textarea = page.locator(COMPOSER);
        await textarea.waitFor({ timeout: APP_FIRST_RENDER_TIMEOUT_MS });
        await textarea.fill(
          "Resize this populated draft across a narrow pane so its wrapped lines change height without waiting for another input event. ".repeat(
            2,
          ),
        );
        await waitForLayoutSettled(page, COMPOSER);
        const wideHeight = (await textarea.boundingBox())?.height ?? 0;

        await page.setViewportSize({ width: 430, height: 800 });
        await waitForComposerResize(page, wideHeight, 1);
        const narrowHeight = (await textarea.boundingBox())?.height ?? 0;
        expect(narrowHeight).toBeGreaterThan(wideHeight + 1);

        await page.setViewportSize({ width: 900, height: 800 });
        await waitForComposerResize(page, narrowHeight, -1);
        expect(
          sharedAppPageErrors
            .slice(errorStart)
            .filter((message) => message.includes("ResizeObserver loop")),
        ).toEqual([]);
      } finally {
        await page.locator(COMPOSER).fill("");
        await page.setViewportSize(DESKTOP_VIEWPORT);
      }
    },
  );

  it(
    "reveals, pins, and dismisses shared message context above virtual-row containment",
    FULL_APP_TEST_OPTIONS,
    async () => {
      const page = await getSharedAppPage();
      try {
        await page.setViewportSize(DESKTOP_VIEWPORT);
        const group = page.locator(".chat-group").filter({ hasText: SHARED_APP_CONTEXT_TEXT });
        const tooltip = group.locator("openclaw-tooltip.msg-meta");
        const context = tooltip.locator(".msg-meta__details");
        const summary = tooltip.locator(".msg-meta__summary");
        const messageText = group.locator(".chat-text").first();
        await messageText.waitFor({ timeout: APP_FIRST_RENDER_TIMEOUT_MS });
        expect(await context.isVisible()).toBe(false);

        await messageText.hover();
        await waitForLayoutSettled(page, ".chat-group");
        const initialLayout = await group.evaluate(contextLayout, false);
        await summary.hover();
        await context.waitFor({ state: "visible", timeout: 10_000 });
        const hoverLayout = await group.evaluate(contextLayout, true);
        expect(hoverLayout.footerHeight).toBeCloseTo(initialLayout.footerHeight, 2);
        expect(hoverLayout.groupHeight).toBeCloseTo(initialLayout.groupHeight, 2);
        expect(hoverLayout.contextBottom).toBeLessThanOrEqual(hoverLayout.summaryTop + 4);

        // Real top-layer placement replaces the old per-row containment escape.
        // Hit-test rendered content, not just the popup's open flag.
        await expect
          .poll(() => group.evaluate(messageContextState))
          .toMatchObject({ rowContainment: "auto", topLayer: true, painted: true });

        await page.mouse.move(0, 0);
        await context.waitFor({ state: "hidden", timeout: 10_000 });

        // Keyboard discovery must reveal the timestamp itself, not just its tip.
        await page.keyboard.press("Tab");
        await summary.focus();
        await context.waitFor({ state: "visible", timeout: 10_000 });
        // Settle the footer reveal independently of the headless compositor clock.
        await group.locator(".chat-group-footer").evaluate(finishElementAnimations);
        await expect
          .poll(() => group.evaluate(messageContextState))
          .toMatchObject({
            footerOpacity: "1",
            summaryOpacity: "1",
            pointerEvents: "auto",
            summaryFocused: true,
          });
        await page.keyboard.press("Escape");
        await context.waitFor({ state: "hidden", timeout: 10_000 });
        expect(await tooltip.getAttribute("open")).toBeNull();

        await summary.press("Enter");
        await context.waitFor({ state: "visible", timeout: 10_000 });
        // Remove focus without focusing an outside control: only the pin should
        // retain this disclosure, even in browsers that do not focus on click.
        await summary.evaluate((node) => (node as HTMLElement).blur());
        await expect
          .poll(() => group.evaluate(messageContextState))
          .toMatchObject({ hovered: false, focused: false, footerOpacity: "1" });
        expect(await tooltip.getAttribute("open")).toBe("");
        expect(await context.isVisible()).toBe(true);

        await page.mouse.click(0, 0);
        await context.waitFor({ state: "hidden", timeout: 10_000 });
        expect(await tooltip.getAttribute("open")).toBeNull();

        await messageText.hover();
        await summary.click();
        await context.waitFor({ state: "visible", timeout: 10_000 });
        await page.keyboard.press("Escape");
        await context.waitFor({ state: "hidden", timeout: 10_000 });
        expect(await tooltip.getAttribute("open")).toBeNull();
      } finally {
        await page.keyboard.press("Escape");
        await page.mouse.move(0, 0);
      }
    },
  );

  it("renders delivered playback media inline", FULL_APP_TEST_OPTIONS, async () => {
    const page = await getSharedAppPage();
    const image = page.locator(`img.chat-message-image[src="${SHARED_APP_IMAGE_URL}"]`);
    await image.waitFor({ timeout: APP_FIRST_RENDER_TIMEOUT_MS });
    expect(await image.getAttribute("src")).toBe(SHARED_APP_IMAGE_URL);
    await image.evaluate((element: HTMLImageElement) => element.decode());
    expect(await page.getByText(SHARED_APP_TTS_TEXT, { exact: true }).count()).toBe(1);
    expect(await page.getByText(/MEDIA:/u).count()).toBe(0);
    for (const [fileName, type, , playback] of SHARED_APP_PLAYBACK_MEDIA) {
      const player = page
        .locator(type === "audio" ? "openclaw-chat-audio-player" : "openclaw-chat-video-player")
        .filter({ hasText: fileName });
      await player.waitFor({ state: "attached", timeout: 10_000 });
      expect(await player.evaluate((element) => (element as { playback?: unknown }).playback)).toBe(
        playback,
      );
      const card = player.locator(CARD);
      await card.waitFor({ state: "visible", timeout: 10_000 });
      await card.evaluate((element) => element.scrollIntoView({ block: "center" }));
      const requireMetadata = fileName !== "reply.m4a" && fileName !== "reply.mp4";
      // Read the stable player: an error replaces its media child and card.
      // Only AAC/H.264 fixtures may fall back; other codecs must actually load.
      await expect
        .poll(
          () =>
            player.evaluate(
              (element, { type: mediaType, requireMetadata: needsMetadata }) => {
                const media = element.querySelector<HTMLMediaElement>(mediaType);
                return (
                  (!needsMetadata &&
                    element.querySelector(".chat-assistant-attachment-card--compact") !== null) ||
                  (media !== null && media.readyState >= 1)
                );
              },
              { type, requireMetadata },
            ),
          { timeout: 10_000 },
        )
        .toBe(true);
      const compactFallback =
        (await player.locator(".chat-assistant-attachment-card--compact").count()) > 0;
      if (!compactFallback) {
        expect(
          sharedAppPlaybackRequests.some(
            (url) =>
              url.includes(fileName) &&
              (playback === "native" || new URL(url).searchParams.get("playback") === "1"),
          ),
        ).toBe(true);
      }
    }
    expect(await page.getByText(/can't play this format/iu).count()).toBe(0);
  });

  it(
    "renders one named card for every success and failure in a mixed attachment batch",
    FULL_APP_TEST_OPTIONS,
    async () => {
      const page = await getSharedAppPage();
      const bubble = page
        .locator(".chat-bubble")
        .filter({ hasText: SHARED_APP_ATTACHMENT_OUTCOME_TEXT });
      const cards = bubble.locator(CARD);
      await expect.poll(() => cards.count()).toBe(7);
      expect(
        await cards.locator(".chat-assistant-attachment-card__title").allTextContents(),
      ).toEqual([
        "deploy.yaml",
        "settings.toml",
        "schema.sql",
        "events.ndjson",
        "font.ttf",
        "font.woff2",
        "bundle.7z",
      ]);
      expect(await bubble.locator(".chat-assistant-attachment-card--compact").count()).toBe(1);
      expect(await bubble.locator(".chat-assistant-attachment-card--definitive").count()).toBe(6);
      expect(
        await bubble
          .getByText(
            "Not sent · Rejected by the local attachment allowlist. Send a supported file type.",
          )
          .count(),
      ).toBe(5);
      expect(
        await bubble.getByText("Not sent · Delivery failed. Try sending this file again.").count(),
      ).toBe(1);
      expect(await bubble.getByText("Media failed").count()).toBe(0);

      try {
        const failedCard = cards.filter({ hasText: "settings.toml" });
        await failedCard.scrollIntoViewIfNeeded();
        const { leftGap, rightGap } = await failedCard.evaluate(attachmentLayout);
        expect(leftGap).toBeGreaterThan(4);
        expect(rightGap).toBeGreaterThan(4);
        expect(Math.abs(leftGap - rightGap)).toBeLessThan(0.25);

        for (const width of [320, 560]) {
          await page.setViewportSize({ width, height: 852 });
          // The viewport ACK does not settle the retained pane's responsive geometry.
          await failedCard.scrollIntoViewIfNeeded();
          await waitForLayoutSettled(
            page,
            ".chat-main__conversation, .chat-assistant-attachment-card, .chat-assistant-attachment-card__status-reason",
          );
          const layout = await failedCard.evaluate(attachmentLayout);
          expect(layout).toMatchObject({ separatorDisplay: "none", reasonWhiteSpace: "normal" });
          expect(layout.reasonTop).toBeGreaterThanOrEqual(layout.badgeBottom);
          expect(layout.reasonBottom).toBeLessThanOrEqual(layout.cardBottom);
          expect(layout.reasonRight).toBeLessThanOrEqual(width);
          expect(layout.cardScrollWidth).toBeLessThanOrEqual(layout.cardClientWidth);
          await expectNoHorizontalOverflow(page);
        }
      } finally {
        await page.setViewportSize(DESKTOP_VIEWPORT);
      }
    },
  );

  describe("slash command keyboard navigation", () => {
    let page: Page;

    beforeAll(async () => {
      page = await getSharedAppPage();
      await page.setViewportSize({ width: 568, height: 320 });
      await page.getByText(SHARED_APP_SLASH_TEXT).waitFor({ timeout: APP_FIRST_RENDER_TIMEOUT_MS });
      const textarea = page.locator(COMPOSER);
      await textarea.fill("/");
      await textarea.focus();
    });

    afterAll(async () => {
      if (!page) {
        return;
      }
      await page.locator(COMPOSER).fill("");
      await page.setViewportSize(DESKTOP_VIEWPORT);
    });

    it("scrolls the keyboard-active slash option into view in short landscape", async () => {
      const initiallyHidden = await page.evaluate(() => {
        const scrollRegion = document.querySelector<HTMLElement>(".slash-menu__scroll");
        const options = Array.from(
          document.querySelectorAll<HTMLElement>(".slash-menu-item[role='option']"),
        );
        const hiddenOption = options.find((option) => {
          const menuRect = scrollRegion?.getBoundingClientRect();
          const optionRect = option.getBoundingClientRect();
          return Boolean(menuRect && optionRect.bottom > menuRect.bottom + 1);
        });
        if (!scrollRegion || !hiddenOption) {
          throw new Error("Expected an initially hidden slash option");
        }
        scrollRegion.scrollTop = 0;
        const menuRect = scrollRegion.getBoundingClientRect();
        const itemRect = hiddenOption.getBoundingClientRect();
        return {
          id: hiddenOption.id,
          index: options.indexOf(hiddenOption),
          visible: itemRect.top >= menuRect.top - 1 && itemRect.bottom <= menuRect.bottom + 1,
        };
      });
      expect(initiallyHidden.visible).toBe(false);

      for (let index = 0; index < initiallyHidden.index; index += 1) {
        await page.keyboard.press("ArrowDown");
      }
      const state = await page.waitForFunction(
        ({ expectedId, composer }) => {
          const input = document.querySelector(composer);
          const target = document.getElementById(expectedId);
          const menu = target?.closest<HTMLElement>(".slash-menu__scroll");
          const active = document.querySelector(".slash-menu-item--active");
          if (
            !input ||
            !target ||
            !menu ||
            !active ||
            input.getAttribute("aria-activedescendant") !== expectedId
          ) {
            return null;
          }
          const menuRect = menu.getBoundingClientRect();
          const targetRect = target.getBoundingClientRect();
          if (targetRect.top < menuRect.top - 1 || targetRect.bottom > menuRect.bottom + 1) {
            return null;
          }
          const activeRect = active.getBoundingClientRect();
          return {
            activeDescendant: input.getAttribute("aria-activedescendant"),
            focusedTag: document.activeElement?.tagName,
            scrollTop: menu.scrollTop,
            visible: activeRect.top >= menuRect.top - 1 && activeRect.bottom <= menuRect.bottom + 1,
          };
        },
        { expectedId: initiallyHidden.id, composer: COMPOSER },
      );
      const result = (await state.jsonValue())!;
      expect(result).toMatchObject({
        focusedTag: "TEXTAREA",
        activeDescendant: initiallyHidden.id,
        visible: true,
      });
      expect(result.scrollTop).toBeGreaterThan(0);
    });
  });
});
