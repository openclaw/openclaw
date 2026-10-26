import { readFile } from "node:fs/promises";
import type { BrowserContext, Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createPlaybackMediaFixture } from "../../../test/fixtures/media-playback.js";
import { captureControlUiE2eFailureDiagnostics } from "../test-helpers/control-ui-e2e-diagnostics.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  createMarginImage,
  marginCases,
  marginScenario,
  measureMargin,
  resizeMarginViewport,
  type MarginCase,
} from "./chat-mobile-bubble-margin.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Mobile transcript bubble gutters",
  startServerBeforeBrowser: true,
});

type Margin = Awaited<ReturnType<typeof measureMargin>>;
function expectMediaInside({ media }: Margin, label: string) {
  expect(
    media.filter((item) => item.width > 0 && !(Math.min(item.left, item.right) >= -1)),
    `${label} media stays inside its surface`,
  ).toEqual([]);
}
function expectActivityEdges(margin: Margin, label: string) {
  expect(margin, label).toMatchObject({ closed: expect.closeTo(0, 0), open: expect.closeTo(0, 0) });
}

suite.define(() => {
  // Retain four-case media isolation while sharing each app boot within the batch.
  const casesPerPage = 4;
  let context: BrowserContext;
  let page: Page;
  let pageBatch = -1;
  let images: Map<number, Buffer>;
  let video: Buffer;
  const sessionKey = (testCase: MarginCase) => `agent:main:margin-${testCase.id}`;

  beforeAll(async () => {
    context = await suite.newBrowserContext({
      viewport: { width: 1440, height: 1200 },
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    page = await context.newPage();
    images = new Map([
      [320, await createMarginImage(page, { width: 320, height: 180 })],
      [960, await createMarginImage(page)],
    ]);
    video = await readFile(new URL("./fixtures/video-poster.mp4", import.meta.url));
  });

  afterAll(async () => {
    if (context) {
      await suite.closeBrowserContext(context);
    }
  });

  afterEach(async ({ task, signal }) => {
    // Capture before the next case can navigate or recycle the shared page.
    const failure: unknown = signal.aborted ? signal.reason : task.result?.errors?.[0];
    if (failure !== undefined && page) {
      await captureControlUiE2eFailureDiagnostics(page, {
        error: failure instanceof Error ? failure : Object.assign(new Error(task.name), failure),
        label: task.name,
      });
    }
  });

  it.each(marginCases)(
    "preserves $id gutters across viewports and themes, restoring desktop geometry",
    async (testCase) => {
      const batch = Math.floor(marginCases.indexOf(testCase) / casesPerPage);
      await page.setViewportSize({ width: 1440, height: 1200 });
      await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
      if (batch !== pageBatch) {
        if (pageBatch !== -1) {
          await page.close();
          page = await context.newPage();
        }
        pageBatch = batch;
        const cases = marginCases.slice(batch * casesPerPage, (batch + 1) * casesPerPage);
        await installMockGateway(page, {
          ...marginScenario(testCase),
          sessions: cases.map((entry) => createControlUiSessionRow(sessionKey(entry), entry.id, 1)),
          sessionTranscripts: Object.fromEntries(
            cases.map((entry) => [sessionKey(entry), { messages: [...entry.messages] }]),
          ),
          sessionKey: sessionKey(testCase),
        });
        await page.route("https://media.example/**", (route) => {
          const request = route.request();
          if (request.url().endsWith("png")) {
            const width = request.url().endsWith("preview-320.png") ? 320 : 960;
            return route.fulfill({ contentType: "image/png", body: images.get(width)! });
          }
          if (!request.url().endsWith("mp4")) {
            return route.fulfill({
              contentType: "audio/mpeg",
              headers: { "access-control-allow-origin": "*" },
              body: createPlaybackMediaFixture("mp3"),
            });
          }
          const start = Number(request.headers().range?.match(/bytes=(\d+)/)?.[1] ?? 0);
          return route.fulfill({
            status: 206,
            contentType: "video/mp4",
            headers: {
              "access-control-allow-origin": "*",
              "accept-ranges": "bytes",
              "content-range": `bytes ${start}-${video.length - 1}/${video.length}`,
            },
            body: video.subarray(start),
          });
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey(testCase)), {
          waitUntil: "domcontentloaded",
        });
      } else {
        await navigateToControlUiSession(page, sessionKey(testCase));
      }
      await page.mouse.move(0, 0);
      const activePane = page.locator(".chat-pane-cache__pane--active");
      await expectBrowser(activePane).toHaveJSProperty("sessionKey", sessionKey(testCase));
      const measure = () => measureMargin(page, testCase);
      const imageSize = "imageSize" in testCase ? testCase.imageSize : undefined;
      await page.bringToFront();
      if (testCase.id === "clawhub") {
        await expectBrowser(activePane.locator(".chat-thread .chat-clawhub-card")).toHaveAttribute(
          "aria-busy",
          "false",
        );
      }
      for (const theme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: theme });
        await expectBrowser(page.locator("html")).toHaveAttribute("data-theme-mode", theme);
        if (testCase.id === "user-video" || testCase.id === "user-mixed") {
          const poster = activePane.locator(".chat-video-preview img");
          await expectBrowser(poster).toBeVisible();
          await expect
            .poll(() =>
              poster.evaluate(
                (element) =>
                  element instanceof HTMLImageElement &&
                  element.complete &&
                  element.naturalWidth > 0,
              ),
            )
            .toBe(true);
        }
        if (testCase.id === "assistant-video") {
          // Metadata replaces the video's initial 150px height with its intrinsic ratio.
          const videoElement = activePane.locator(".chat-assistant-video-frame video");
          await expectBrowser(videoElement).toBeVisible();
          await expect
            .poll(() =>
              videoElement.evaluate(
                (element) =>
                  element instanceof HTMLVideoElement &&
                  element.readyState >= HTMLMediaElement.HAVE_METADATA &&
                  element.videoWidth > 0 &&
                  element.videoHeight > 0,
              ),
            )
            .toBe(true);
        }
        if (testCase.id === "clawhub") {
          // Compare settled catalog content, not the transient loading card.
          await expectBrowser(activePane.locator(".chat-clawhub-card")).toHaveAttribute(
            "aria-busy",
            "false",
          );
        }
        const desktop = await measure();
        for (const width of [390, 430]) {
          const label = `${testCase.id} at ${width} px in ${theme}`;
          const pollMargin = <T>(project: (margin: Margin) => T) =>
            expect.poll(async () => project(await measure()), { message: label });
          await resizeMarginViewport(page, width);
          if (testCase.selector === ".chat-session-activity") {
            const activity = activePane.locator(".chat-thread .chat-session-activity");
            const chevron = activity.locator("summary .chat-session-activity__chevron");
            await expectBrowser(activity.locator("summary"), label).toBeVisible();
            await expectBrowser(activity.locator(".chat-bubble"), label).toHaveCount(0);
            const collapsed = await measure();
            expectActivityEdges(collapsed, label);
            await chevron.click();
            await expectBrowser(activity.locator(".chat-bubble"), label).toBeVisible();
            await expectBrowser(
              activity.locator(".chat-message-disclosure__toggle"),
              label,
            ).toHaveCount(0);
            const expanded = await measure();
            expectActivityEdges(expanded, label);
            expect(expanded.height, label).toBeGreaterThan(collapsed.height);
            expect(expanded.overflow, label).toBe(0);
            expectMediaInside(expanded, label);
            await chevron.click();
            await expectBrowser(activity, label).toHaveJSProperty("open", false);
            await expectBrowser(activity.locator(".chat-bubble"), label).toHaveCount(0);
          } else if (!("excluded" in testCase)) {
            const mobile = await vi.waitFor(
              async () => {
                const box = await measure();
                expect(box.open - box.columnWidth * 0.1, label).toBeGreaterThanOrEqual(-1);
                expect(box.closed, label).toBeCloseTo(testCase.id === "user-audio" ? 17 : 0, 0);
                return box;
              },
              { interval: 100, timeout: 15_000 },
            );
            if (imageSize) {
              const expectedWidth = Math.min(imageSize.width, mobile.columnWidth * 0.9);
              expect(mobile, label).toMatchObject({
                width: expect.closeTo(expectedWidth, 1),
                height: expect.closeTo((expectedWidth * imageSize.height) / imageSize.width, 1),
              });
            }
            expectMediaInside(mobile, label);
            const toggle = activePane.locator(".chat-message-disclosure__toggle");
            if (await toggle.count()) {
              await toggle.first().click();
              const expanded = await measure();
              expect(expanded.open, label).toBeGreaterThanOrEqual(expanded.columnWidth * 0.1 - 1);
              await toggle.first().click();
            }
          }
          await resizeMarginViewport(page, 1440);
          await pollMargin((restored) =>
            Math.max(
              ...(["x", "y", "width", "height"] as const).map((key) =>
                Math.abs(restored[key] - desktop[key]),
              ),
            ),
          ).toBeLessThanOrEqual(0.5);
        }
      }
    },
  );
});
