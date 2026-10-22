import { readFile } from "node:fs/promises";
import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { createPlaybackMediaFixture } from "../../../test/fixtures/media-playback.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createMarginImage,
  marginCases,
  marginScenario,
  measureMargin,
  resizeMarginViewport,
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
  it.each(marginCases)(
    "preserves $id gutters across viewports and themes, restoring desktop geometry",
    (testCase) =>
      suite.withPage(
        { viewport: { width: 1440, height: 1200 }, colorScheme: "light", reducedMotion: "reduce" },
        async ({ page }) => {
          const measure = () => measureMargin(page, testCase);
          const imageSize = "imageSize" in testCase ? testCase.imageSize : undefined;
          const image = await createMarginImage(page, imageSize);
          const video = await readFile(new URL("./fixtures/video-poster.mp4", import.meta.url));
          await page.route("https://media.example/**", (route) => {
            const request = route.request();
            if (request.url().endsWith("png")) {
              return route.fulfill({ contentType: "image/png", body: image });
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
          await installMockGateway(page, marginScenario(testCase));
          await page.bringToFront();
          await page.goto(`${suite.server.baseUrl}chat/main`, { waitUntil: "domcontentloaded" });
          if (testCase.id === "clawhub") {
            await expectBrowser(page.locator(".chat-thread .chat-clawhub-card")).toHaveAttribute(
              "aria-busy",
              "false",
            );
          }
          for (const theme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme: theme });
            await expectBrowser(page.locator("html")).toHaveAttribute("data-theme-mode", theme);
            if (testCase.id === "user-video" || testCase.id === "user-mixed") {
              const poster = page.locator(".chat-video-preview img");
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
            if (testCase.id === "clawhub") {
              // Compare settled catalog content, not the transient loading card.
              await expectBrowser(page.locator(".chat-clawhub-card")).toHaveAttribute(
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
                const activity = page.locator(".chat-thread .chat-session-activity");
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
                await pollMargin((box) => box.open - box.columnWidth * 0.1).toBeGreaterThanOrEqual(
                  -1,
                );
                await pollMargin((box) => box.closed).toBeCloseTo(
                  testCase.id === "user-audio" ? 17 : 0,
                  0,
                );
                const mobile = await measure();
                if (imageSize) {
                  const expectedWidth = Math.min(imageSize.width, mobile.columnWidth * 0.9);
                  expect(mobile, label).toMatchObject({
                    width: expect.closeTo(expectedWidth, 1),
                    height: expect.closeTo((expectedWidth * imageSize.height) / imageSize.width, 1),
                  });
                }
                expectMediaInside(mobile, label);
                const toggle = page.locator(".chat-message-disclosure__toggle");
                if (await toggle.count()) {
                  await toggle.first().click();
                  const expanded = await measure();
                  expect(expanded.open, label).toBeGreaterThanOrEqual(
                    expanded.columnWidth * 0.1 - 1,
                  );
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
      ),
  );
});
