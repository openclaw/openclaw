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
  type ControlUiMockGatewayScenario,
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

function installResponsiveChatGateway(page: Page, scenario: ControlUiMockGatewayScenario = {}) {
  return installMockGateway(page, {
    agentModel: "openai/gpt-5.5",
    ...scenario,
  });
}

function getSharedAppPage(): Promise<Page> {
  return (sharedAppPagePromise ??= createSharedAppPage());
}

async function createSharedAppPage(): Promise<Page> {
  // The five app assertions use disjoint fixture messages and reset mutable
  // page state, so one lazy boot preserves coverage without five graph loads.
  const page = await suite.browser.newPage({ viewport: { width: 1366, height: 900 } });
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
    await installResponsiveChatGateway(page, {
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
        {
          content: `MEDIA:${SHARED_APP_IMAGE_URL}`,
          role: "assistant",
          timestamp: Date.UTC(2026, 6, 9, 10, 0),
        },
        {
          content: [
            { text: SHARED_APP_TTS_TEXT, type: "text" },
            ...SHARED_APP_PLAYBACK_MEDIA.map(([fileName, type, mimeType, playback]) => ({
              fileName,
              mimeType,
              playback,
              type,
              url: `https://cdn.example/${fileName}`,
            })),
          ],
          role: "assistant",
          timestamp: Date.UTC(2026, 6, 9, 10, 1),
        },
        {
          content: [{ text: SHARED_APP_SLASH_TEXT, type: "text" }],
          role: "assistant",
          timestamp: Date.UTC(2026, 6, 9, 10, 2),
        },
        {
          content: [
            { text: SHARED_APP_ATTACHMENT_OUTCOME_TEXT, type: "text" },
            {
              type: "attachment",
              attachment: {
                url: "https://files.example/deploy.yaml",
                kind: "document",
                label: "deploy.yaml",
                mimeType: "application/yaml",
              },
            },
            ...["settings.toml", "schema.sql", "events.ndjson", "font.ttf", "font.woff2"].map(
              (label) => ({
                type: "attachment_error",
                attachment: {
                  code: "unsupported-format",
                  kind: "document",
                  label,
                },
              }),
            ),
            {
              type: "attachment_error",
              attachment: {
                code: "delivery-failed",
                kind: "document",
                label: "bundle.7z",
                mimeType: "application/x-7z-compressed",
              },
            },
          ],
          role: "assistant",
          timestamp: Date.UTC(2026, 6, 9, 10, 3),
        },
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
        const textarea = page.locator(".agent-chat__composer-combobox > textarea");
        await textarea.waitFor({ timeout: APP_FIRST_RENDER_TIMEOUT_MS });
        await textarea.fill(
          "Resize this populated draft across a narrow pane so its wrapped lines change height without waiting for another input event. ".repeat(
            2,
          ),
        );
        await waitForLayoutSettled(page, ".agent-chat__composer-combobox > textarea");
        const wideHeight = (await textarea.boundingBox())?.height ?? 0;

        await page.setViewportSize({ width: 430, height: 800 });
        await page.waitForFunction((previousHeight) => {
          const element = document.querySelector<HTMLTextAreaElement>(
            ".agent-chat__composer-combobox > textarea",
          );
          return element !== null && element.getBoundingClientRect().height > previousHeight + 1;
        }, wideHeight);
        const narrowHeight = (await textarea.boundingBox())?.height ?? 0;
        expect(narrowHeight).toBeGreaterThan(wideHeight + 1);

        await page.setViewportSize({ width: 900, height: 800 });
        await page.waitForFunction((previousHeight) => {
          const element = document.querySelector<HTMLTextAreaElement>(
            ".agent-chat__composer-combobox > textarea",
          );
          return element !== null && element.getBoundingClientRect().height < previousHeight - 1;
        }, narrowHeight);
        expect(
          sharedAppPageErrors
            .slice(errorStart)
            .filter((message) => message.includes("ResizeObserver loop")),
        ).toEqual([]);
      } finally {
        await page.locator(".agent-chat__composer-combobox > textarea").fill("");
        await page.setViewportSize({ width: 1366, height: 900 });
      }
    },
  );

  it(
    "reveals, pins, and dismisses shared message context above virtual-row containment",
    FULL_APP_TEST_OPTIONS,
    async () => {
      const page = await getSharedAppPage();
      try {
        await page.setViewportSize({ width: 1366, height: 900 });
        const group = page.locator(".chat-group").filter({ hasText: SHARED_APP_CONTEXT_TEXT });
        const tooltip = group.locator("openclaw-tooltip.msg-meta");
        const context = tooltip.locator(".msg-meta__details");
        const summary = tooltip.locator(".msg-meta__summary");
        const messageText = group.locator(".chat-text").first();
        await messageText.waitFor({ timeout: APP_FIRST_RENDER_TIMEOUT_MS });
        expect(await context.isVisible()).toBe(false);

        await messageText.hover();
        await waitForLayoutSettled(page, ".chat-group");
        const initialLayout = await group.evaluate((node) => {
          const footer = node.querySelector<HTMLElement>(".chat-group-footer")!;
          return {
            footerHeight: footer.getBoundingClientRect().height,
            groupHeight: (node as HTMLElement).getBoundingClientRect().height,
          };
        });
        await summary.hover();
        await context.waitFor({ state: "visible", timeout: 10_000 });
        const hoverLayout = await group.evaluate((node) => {
          const footer = node.querySelector<HTMLElement>(".chat-group-footer")!;
          const summaryNode = node.querySelector<HTMLElement>(".msg-meta__summary")!;
          const detailsOverlay = node.querySelector<HTMLElement>(".msg-meta__details")!;
          return {
            contextBottom: detailsOverlay.getBoundingClientRect().bottom,
            footerHeight: footer.getBoundingClientRect().height,
            groupHeight: (node as HTMLElement).getBoundingClientRect().height,
            summaryTop: summaryNode.getBoundingClientRect().top,
          };
        });
        expect(hoverLayout.footerHeight).toBeCloseTo(initialLayout.footerHeight, 2);
        expect(hoverLayout.groupHeight).toBeCloseTo(initialLayout.groupHeight, 2);
        expect(hoverLayout.contextBottom).toBeLessThanOrEqual(hoverLayout.summaryTop + 4);

        // Real top-layer placement replaces the old per-row containment escape.
        // Hit-test rendered content, not just the popup's open flag.
        await expect
          .poll(() =>
            context.evaluate((node) => {
              const row = node.closest<HTMLElement>(".chat-virtual-row")!;
              const tooltipNode = node.closest("openclaw-tooltip")!;
              const popup = tooltipNode.shadowRoot?.querySelector<HTMLElement>(
                ".tooltip-surface[popover]",
              );
              const rect = node.getBoundingClientRect();
              const target = document.elementFromPoint(rect.left + 8, rect.top + rect.height / 2);
              return {
                rowContainment: getComputedStyle(row).contentVisibility,
                topLayer: popup?.matches(":popover-open") ?? false,
                painted: target !== null && node.contains(target),
              };
            }),
          )
          .toEqual({ rowContainment: "auto", topLayer: true, painted: true });

        await page.mouse.move(0, 0);
        await context.waitFor({ state: "hidden", timeout: 10_000 });

        // Keyboard discovery must reveal the timestamp itself, not just its tip.
        await page.keyboard.press("Tab");
        await summary.focus();
        await context.waitFor({ state: "visible", timeout: 10_000 });
        // Settle the footer reveal independently of the headless compositor clock.
        await group.locator(".chat-group-footer").evaluate(finishElementAnimations);
        await expect
          .poll(() =>
            summary.evaluate((node) => {
              const footer = node.closest<HTMLElement>(".chat-group-footer")!;
              return {
                footerOpacity: getComputedStyle(footer).opacity,
                summaryOpacity: getComputedStyle(node).opacity,
                pointerEvents: getComputedStyle(node).pointerEvents,
                focused: document.activeElement === node,
              };
            }),
          )
          .toEqual({
            footerOpacity: "1",
            summaryOpacity: "1",
            pointerEvents: "auto",
            focused: true,
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
          .poll(() =>
            group.evaluate((node) => ({
              hovered: node.matches(":hover"),
              focused: node.matches(":focus-within"),
              footerOpacity: getComputedStyle(
                node.querySelector<HTMLElement>(".chat-group-footer")!,
              ).opacity,
            })),
          )
          .toEqual({ hovered: false, focused: false, footerOpacity: "1" });
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
      const card = player.locator(".chat-assistant-attachment-card");
      await card.waitFor({ state: "visible", timeout: 10_000 });
      await player.evaluate((element) => {
        element
          .querySelector(".chat-assistant-attachment-card")!
          .scrollIntoView({ block: "center" });
      });
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
          sharedAppPlaybackRequests.some((url) => {
            if (!url.includes(fileName)) {
              return false;
            }
            return playback === "native" || new URL(url).searchParams.get("playback") === "1";
          }),
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
      const cards = bubble.locator(".chat-assistant-attachment-card");
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
        await cards.filter({ hasText: "settings.toml" }).scrollIntoViewIfNeeded();
        const desktopStatusSpacing = await cards
          .filter({ hasText: "settings.toml" })
          .evaluate((card) => {
            const badge = card.querySelector<HTMLElement>(
              ".chat-assistant-attachment-card__status-badge",
            )!;
            const reason = card.querySelector<HTMLElement>(
              ".chat-assistant-attachment-card__status-reason",
            )!;
            const separator = card.querySelector<HTMLElement>(
              ".chat-assistant-attachment-card__status-separator",
            )!;
            const badgeRect = badge.getBoundingClientRect();
            const reasonRect = reason.getBoundingClientRect();
            const separatorRect = separator.getBoundingClientRect();
            return {
              leftGap: separatorRect.left - badgeRect.right,
              rightGap: reasonRect.left - separatorRect.right,
            };
          });
        expect(desktopStatusSpacing.leftGap).toBeGreaterThan(4);
        expect(desktopStatusSpacing.rightGap).toBeGreaterThan(4);
        expect(Math.abs(desktopStatusSpacing.leftGap - desktopStatusSpacing.rightGap)).toBeLessThan(
          0.25,
        );

        for (const width of [320, 560]) {
          await page.setViewportSize({ width, height: 852 });
          const failedCard = cards.filter({ hasText: "settings.toml" });
          // The viewport ACK does not settle the retained pane's responsive geometry.
          await failedCard.scrollIntoViewIfNeeded();
          await waitForLayoutSettled(
            page,
            ".chat-main__conversation, .chat-assistant-attachment-card, .chat-assistant-attachment-card__status-reason",
          );
          const mobileStatusLayout = await failedCard.evaluate((card) => {
            const badge = card.querySelector<HTMLElement>(
              ".chat-assistant-attachment-card__status-badge",
            )!;
            const reason = card.querySelector<HTMLElement>(
              ".chat-assistant-attachment-card__status-reason",
            )!;
            const separator = card.querySelector<HTMLElement>(
              ".chat-assistant-attachment-card__status-separator",
            )!;
            const cardRect = card.getBoundingClientRect();
            const reasonRect = reason.getBoundingClientRect();
            return {
              badgeBottom: badge.getBoundingClientRect().bottom,
              cardBottom: cardRect.bottom,
              cardClientWidth: card.clientWidth,
              cardScrollWidth: card.scrollWidth,
              reasonBottom: reasonRect.bottom,
              reasonRight: reasonRect.right,
              reasonTop: reasonRect.top,
              separatorDisplay: getComputedStyle(separator).display,
              reasonWhiteSpace: getComputedStyle(reason).whiteSpace,
            };
          });
          expect(mobileStatusLayout.separatorDisplay).toBe("none");
          expect(mobileStatusLayout.reasonWhiteSpace).toBe("normal");
          expect(mobileStatusLayout.reasonTop).toBeGreaterThanOrEqual(
            mobileStatusLayout.badgeBottom,
          );
          expect(mobileStatusLayout.reasonBottom).toBeLessThanOrEqual(
            mobileStatusLayout.cardBottom,
          );
          expect(mobileStatusLayout.reasonRight).toBeLessThanOrEqual(width);
          expect(mobileStatusLayout.cardScrollWidth).toBeLessThanOrEqual(
            mobileStatusLayout.cardClientWidth,
          );
          await expectNoHorizontalOverflow(page);
        }
      } finally {
        await page.setViewportSize({ width: 1366, height: 900 });
      }
    },
  );

  describe("slash command keyboard navigation", () => {
    let page: Page;

    beforeAll(async () => {
      page = await getSharedAppPage();
      await page.setViewportSize({ width: 568, height: 320 });
      await page.getByText(SHARED_APP_SLASH_TEXT).waitFor({ timeout: APP_FIRST_RENDER_TIMEOUT_MS });
      const textarea = page.locator(".agent-chat__composer-combobox > textarea");
      await textarea.fill("/");
      await textarea.focus();
    });

    afterAll(async () => {
      if (!page) {
        return;
      }
      await page.locator(".agent-chat__composer-combobox > textarea").fill("");
      await page.setViewportSize({ width: 1366, height: 900 });
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
      await page.waitForFunction((expectedId) => {
        const input = document.querySelector<HTMLTextAreaElement>(
          ".agent-chat__composer-combobox > textarea",
        );
        return input?.getAttribute("aria-activedescendant") === expectedId;
      }, initiallyHidden.id);
      await page.waitForFunction((expectedId) => {
        const active = document.getElementById(expectedId);
        const scrollRegion = active?.closest<HTMLElement>(".slash-menu__scroll");
        if (!active || !scrollRegion) {
          return false;
        }
        const menuRect = scrollRegion.getBoundingClientRect();
        const activeRect = active.getBoundingClientRect();
        return activeRect.top >= menuRect.top - 1 && activeRect.bottom <= menuRect.bottom + 1;
      }, initiallyHidden.id);

      const result = await page.evaluate(() => {
        const input = document.querySelector<HTMLTextAreaElement>(
          ".agent-chat__composer-combobox > textarea",
        );
        const scrollRegion = document.querySelector<HTMLElement>(".slash-menu__scroll");
        const active = document.querySelector<HTMLElement>(".slash-menu-item--active");
        if (!input || !scrollRegion || !active) {
          throw new Error("Expected active slash option after keyboard navigation");
        }
        const menuRect = scrollRegion.getBoundingClientRect();
        const activeRect = active.getBoundingClientRect();
        return {
          activeDescendant: input.getAttribute("aria-activedescendant"),
          focusedTag: document.activeElement?.tagName,
          scrollTop: scrollRegion.scrollTop,
          visible: activeRect.top >= menuRect.top - 1 && activeRect.bottom <= menuRect.bottom + 1,
        };
      });

      expect(result.focusedTag).toBe("TEXTAREA");
      expect(result.activeDescendant).toBe(initiallyHidden.id);
      expect(result.scrollTop).toBeGreaterThan(0);
      expect(result.visible).toBe(true);
    });
  });
});
