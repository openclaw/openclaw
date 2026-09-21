import { readFile } from "node:fs/promises";
import { expect as expectBrowser } from "playwright/test";
import { expect, it, onTestFailed } from "vitest";
import { createPlaybackMediaFixture } from "../../../test/fixtures/media-playback.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createMarginImage,
  marginCases,
  marginScenario,
  measureMargin,
} from "./chat-mobile-bubble-margin.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Mobile transcript bubble gutters",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it.each(marginCases)(
    "preserves $id gutters at 390 and 430 px in both themes and restores desktop geometry",
    async (testCase) => {
      let phase = "acquire-page";
      let currentTheme = "light";
      let currentWidth = 1440;
      // A renderer read may be unavailable after a timeout closes the page.
      // Keep the last awaited owner in the test process; do not add another wait.
      onTestFailed(() => {
        console.error("[mobile-gutter-phase]", {
          caseId: testCase.id,
          phase,
          theme: currentTheme,
          requestedWidth: currentWidth,
        });
      });
      const markPhase = (value: string) => {
        phase = value;
      };
      await suite.withPage(
        { viewport: { width: 1440, height: 1200 }, colorScheme: "light", reducedMotion: "reduce" },
        async ({ page }) => {
          const imageSize = "imageSize" in testCase ? testCase.imageSize : undefined;
          markPhase("create-image");
          const image = await createMarginImage(page, imageSize);
          markPhase("read-video-fixture");
          const video = await readFile(new URL("./fixtures/video-poster.mp4", import.meta.url));
          markPhase("install-media-route");
          await page.route("https://media.example/**", (route) => {
            if (route.request().url().endsWith("png")) {
              return route.fulfill({ contentType: "image/png", body: image });
            }
            const isVideo = route.request().url().endsWith("mp4");
            const start = Number(
              route
                .request()
                .headers()
                .range?.match(/bytes=(\d+)/)?.[1] ?? 0,
            );
            return route.fulfill({
              status: isVideo ? 206 : 200,
              contentType: isVideo ? "video/mp4" : "audio/mpeg",
              headers: {
                "access-control-allow-origin": "*",
                ...(isVideo
                  ? {
                      "accept-ranges": "bytes",
                      "content-range": `bytes ${start}-${video.length - 1}/${video.length}`,
                    }
                  : {}),
              },
              body: isVideo ? video.subarray(start) : createPlaybackMediaFixture("mp3"),
            });
          });
          markPhase("install-gateway");
          await installMockGateway(page, marginScenario(testCase));
          markPhase("bring-to-front");
          await page.bringToFront();
          markPhase("navigate");
          await page.goto(`${suite.server.baseUrl}chat/main`, { waitUntil: "domcontentloaded" });
          // Reuse the rendered transcript; each theme starts with its own desktop baseline.
          for (const theme of ["light", "dark"] as const) {
            currentTheme = theme;
            markPhase("emulate-theme");
            await page.emulateMedia({ colorScheme: theme });
            markPhase("theme-attribute");
            await expectBrowser(page.locator("html")).toHaveAttribute("data-theme-mode", theme);
            if (testCase.id === "user-video" || testCase.id === "user-mixed") {
              markPhase("video-preview-visible");
              await expectBrowser(page.locator(".chat-video-preview img")).toBeVisible();
              markPhase("video-preview-decoded");
              await expect
                .poll(() =>
                  page
                    .locator(".chat-video-preview img")
                    .evaluate(
                      (element) =>
                        element instanceof HTMLImageElement &&
                        element.complete &&
                        element.naturalWidth > 0,
                    ),
                )
                .toBe(true);
            }
            const desktop = await measureMargin(page, testCase, markPhase);
            // Each width starts from the verified desktop geometry in the same fixture.
            for (const width of [390, 430]) {
              const label = `${testCase.id} at ${width} px in ${theme}`;
              currentWidth = width;
              markPhase("mobile-viewport");
              await page.setViewportSize({ width, height: 1200 });
              if (!("excluded" in testCase)) {
                await expect
                  .poll(
                    async () => {
                      const box = await measureMargin(page, testCase, markPhase);
                      return box.open - box.columnWidth * 0.1;
                    },
                    { message: label },
                  )
                  .toBeGreaterThanOrEqual(-1);
                await expect
                  .poll(async () => (await measureMargin(page, testCase, markPhase)).closed, {
                    message: `${label} closed edge`,
                  })
                  .toBeCloseTo(testCase.id === "user-audio" ? 17 : 0, 0);
                const mobile = await measureMargin(page, testCase, markPhase);
                if (imageSize) {
                  const expectedWidth = Math.min(imageSize.width, mobile.columnWidth * 0.9);
                  expect(mobile.width, `${label} fits the column once`).toBeCloseTo(
                    expectedWidth,
                    1,
                  );
                  expect(mobile.height, `${label} preserves its aspect ratio`).toBeCloseTo(
                    expectedWidth * (imageSize.height / imageSize.width),
                    1,
                  );
                }
                for (const media of mobile.media.filter((item) => item.width > 0)) {
                  expect(
                    Math.min(media.left, media.right),
                    `${label} media stays inside its surface`,
                  ).toBeGreaterThanOrEqual(-1);
                }
                const toggle = page.locator(".chat-message-disclosure__toggle");
                if (testCase.id === "forwarded-short") {
                  await expectBrowser(toggle, label).toBeHidden();
                } else if (await toggle.count()) {
                  markPhase("expand-disclosure");
                  await toggle.first().click();
                  const expanded = await measureMargin(page, testCase, markPhase);
                  expect(expanded.open, `${label} expanded`).toBeGreaterThanOrEqual(
                    expanded.columnWidth * 0.1 - 1,
                  );
                  markPhase("collapse-disclosure");
                  await toggle.first().click();
                }
              }
              currentWidth = 1440;
              markPhase("restore-desktop-viewport");
              await page.setViewportSize({ width: 1440, height: 1200 });
              await expect
                .poll(
                  async () => {
                    const restored = await measureMargin(page, testCase, markPhase);
                    return Math.max(
                      ...(["x", "y", "width", "height"] as const).map((key) =>
                        Math.abs(restored[key] - desktop[key]),
                      ),
                    );
                  },
                  { message: `${label} desktop geometry` },
                )
                .toBeLessThanOrEqual(0.5);
            }
          }
          markPhase("close-page");
        },
      );
      markPhase("complete");
    },
  );
});
