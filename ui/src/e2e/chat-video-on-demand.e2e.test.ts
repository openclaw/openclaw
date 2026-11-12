import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Chat video on demand",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:video-on-demand";
const otherKey = "agent:main:other-video-session";

suite.define(() => {
  it.each(["converted", "native-gallery"] as const)(
    "plays %s only after activation and releases it on navigation",
    async (scenario) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, colorScheme: "light", reducedMotion: "reduce" },
        async ({ page }) => {
          const label = scenario === "converted" ? "Screen Recording.mov" : "Screen Recording.mp4";
          const video = await readFile(new URL("./fixtures/video-poster.mp4", import.meta.url));
          const mediaRequests: string[] = [];
          await installMockGateway(page, {
            sessionKey,
            agentModel: "openai/gpt-4o",
            models: [{ id: "gpt-4o", name: "GPT-4o", provider: "openai" }],
            sessions: [
              createControlUiSessionRow(sessionKey, "Review screen recording", 1, {
                model: "gpt-4o",
              }),
              createControlUiSessionRow(otherKey, "Other conversation", 1, { model: "gpt-4o" }),
            ],
            sessionTranscripts: {
              [sessionKey]: {
                messages: [
                  {
                    role: "user",
                    timestamp: 1_800_000_000_000,
                    content: [
                      ...(scenario === "native-gallery"
                        ? [
                            {
                              type: "image",
                              url: "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22200%22%3E%3Crect width=%22200%22 height=%22200%22 fill=%22teal%22/%3E%3C/svg%3E",
                            },
                          ]
                        : []),
                      {
                        type: "attachment",
                        attachment: {
                          kind: "video",
                          label,
                          mimeType: scenario === "converted" ? "video/quicktime" : "video/mp4",
                          url: "https://media.example/" + label,
                          playback: scenario === "converted" ? "transcode" : "native",
                          sizeBytes: video.length,
                          durationMs: 1000,
                          width: 320,
                          height: 180,
                        },
                      },
                      {
                        type: "text",
                        text: "Can you check the loading indicator in this recording?",
                      },
                    ],
                  },
                  {
                    role: "assistant",
                    timestamp: 1_800_000_001_000,
                    content: [
                      {
                        type: "text",
                        text: "The recording is available above. You can play it here while keeping the conversation in view.",
                      },
                    ],
                  },
                ],
              },
              [otherKey]: { messages: [{ role: "user", content: "Another conversation." }] },
            },
          });
          await page.route("https://media.example/**", async (route) => {
            const request = route.request();
            mediaRequests.push(request.method() + " " + request.url());
            const start = Number(request.headers().range?.match(/bytes=(\d+)/)?.[1] ?? 0);
            await route.fulfill({
              status: request.method() === "HEAD" ? 200 : 206,
              contentType: "video/mp4",
              headers: {
                "access-control-allow-origin": "*",
                "accept-ranges": "bytes",
                "content-range": `bytes ${start}-${video.length - 1}/${video.length}`,
              },
              body: request.method() === "HEAD" ? undefined : video.subarray(start),
            });
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey), {
            waitUntil: "domcontentloaded",
          });
          const pane = page.locator(".chat-pane-cache__pane--active");
          const tile = pane.locator(".chat-video-preview");
          if (scenario === "converted") {
            await expectBrowser(tile).toContainText(label);
          } else {
            await expectBrowser(tile.locator("img")).toBeVisible();
          }
          await tile.scrollIntoViewIfNeeded();
          await expectBrowser(pane.locator("video")).toHaveCount(0);
          expect(mediaRequests.filter((request) => request.includes("playback=1"))).toEqual([]);
          if (scenario === "converted") {
            expect(mediaRequests).toEqual([]);
          }
          const capture = async (name: string) => {
            const frame = await takeControlUiScreenshotFrame(page, pane, [tile], {
              animations: "disabled",
            });
            await writeFile(
              path.join(suite.artifactDir, scenario + "-" + name + ".png"),
              frame.png,
            );
          };
          await capture("idle");
          await tile.getByRole("button", { name: /Play/ }).click();
          const player = tile.locator("video");
          await expectBrowser(player).toBeVisible();
          await expect
            .poll(() =>
              player.evaluate((element) =>
                element instanceof HTMLVideoElement ? element.readyState : 0,
              ),
            )
            .toBeGreaterThanOrEqual(2);
          expect(mediaRequests.filter((request) => request.startsWith("HEAD "))).toHaveLength(
            scenario === "converted" ? 1 : 0,
          );
          expect(mediaRequests.every((request) => request.includes("playback=1"))).toBe(
            scenario === "converted",
          );
          await expect
            .poll(() =>
              player.evaluate((element) => element instanceof HTMLVideoElement && element.paused),
            )
            .toBe(false);
          await player.evaluate((element) => {
            if (element instanceof HTMLVideoElement) {
              element.pause();
            }
          });
          await expectBrowser(player).toHaveJSProperty("paused", true);
          await capture("playing");
          await player.evaluate((element) =>
            element instanceof HTMLVideoElement ? element.play() : undefined,
          );
          await expectBrowser(player).toHaveJSProperty("paused", false);
          await tile.getByRole("button", { name: /Expand/ }).click();
          await expectBrowser(player).toHaveJSProperty("paused", true);
          await expectBrowser(page.locator("openclaw-image-lightbox video")).toBeVisible();
          await page.keyboard.press("Escape");
          await expectBrowser(page.locator("openclaw-image-lightbox")).toHaveCount(0);
          await navigateToControlUiSession(page, otherKey);
          await expectBrowser(page.locator(".chat-pane-cache__pane--active")).toHaveJSProperty(
            "sessionKey",
            otherKey,
          );
          await expectBrowser(page.locator("video[src]")).toHaveCount(0);
          await navigateToControlUiSession(page, sessionKey);
          await expectBrowser(tile.getByRole("button", { name: /Play/ })).toBeVisible();
          await page.setViewportSize({ width: 390, height: 844 });
          await capture("mobile-idle");
          const bounds = await tile.boundingBox();
          expect(bounds!.x).toBeGreaterThanOrEqual(0);
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
        },
      );
    },
  );
});
