import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { expectAttachmentErrorToast } from "./chat-attachment-toast.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Client-side video compression" });
const video = readFileSync(new URL("./fixtures/video-poster.mp4", import.meta.url));
// ISO BMFF padding crosses the limit while preserving real samples and quick encoding.
const oversized = Buffer.concat([video, Buffer.alloc(256 * 1024)]);
const limit = 128 * 1024;
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const upload = (page: Page, name: string, buffer = oversized) =>
  page
    .locator(".agent-chat__file-input")
    .first()
    .setInputFiles({ name, mimeType: "video/mp4", buffer });

suite.define(() => {
  it("loads the encoder only after consent and sends a playable bounded copy", () =>
    suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
      const requests: string[] = [];
      page.on("request", (request) => requests.push(request.url()));
      const encoderRequests = () =>
        requests.filter((url) => /chat-attachment-video|mediabunny/u.test(url));
      const gateway = await installMockGateway(page, { attachmentMaxBytes: limit });
      await page.goto(suite.server.baseUrl + "chat");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      const send = button(page, "Send message");
      await composer.fill("A synthetic screen recording.");
      await upload(page, "small.mp4", video);
      await button(page, "Remove small.mp4").waitFor();
      expect(encoderRequests()).toEqual([]);
      await button(page, "Remove small.mp4").click();
      await upload(page, "screen.mp4");
      const compress = button(page, "Compress to fit");
      await compress.waitFor();
      expect(await send.isDisabled()).toBe(true);
      expect(encoderRequests()).toEqual([]);
      await compress.click();
      const draft = "Editable during preparation.";
      await composer.fill(draft);
      await composer.press("End");
      await composer.press("!");
      expect(await composer.inputValue()).toBe(draft + "!");
      const ime = await page.context().newCDPSession(page);
      await ime.send("Input.imeSetComposition", {
        text: "入力",
        selectionStart: 2,
        selectionEnd: 2,
      });
      await page.locator(".chat-attachment-thumb--preparation").waitFor({ state: "detached" });
      expect(await composer.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await composer.inputValue()).toBe(draft + "!入力");
      await ime.send("Input.insertText", { text: "入力" });
      await ime.detach();
      expect(encoderRequests().length).toBeGreaterThan(0);
      expect(await gateway.getRequests("chat.send")).toEqual([]);
      await send.click();
      const request = await gateway.waitForRequest("chat.send");
      const params = request.params as {
        attachments: Array<{ content: string; mimeType: string; fileName: string }>;
      };
      const output = params.attachments[0]!;
      expect(output.fileName).toMatch(/^screen-compressed\.(mp4|webm)$/u);
      const bytes = Buffer.from(output.content, "base64");
      expect(bytes.length).toBeGreaterThan(0);
      expect(bytes.length).toBeLessThanOrEqual(limit);
      const playback = await page.evaluate(async (attachment) => {
        const decoded = Uint8Array.from(atob(attachment.content), (char) => char.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([decoded], { type: attachment.mimeType }));
        const player = document.createElement("video");
        player.muted = true;
        player.src = url;
        try {
          await player.play();
          const { videoWidth: width, videoHeight: height, duration } = player;
          return { width, height, duration };
        } finally {
          player.pause();
          player.removeAttribute("src");
          player.load();
          URL.revokeObjectURL(url);
        }
      }, output);
      expect(playback).toMatchObject({ width: 320, height: 180 });
      expect(playback.duration).toBeCloseTo(1, 1);
    }));

  it.each([
    { device: "desktop", viewport: { width: 1280, height: 900 }, mobile: false },
    { device: "mobile", viewport: { width: 390, height: 844 }, mobile: true },
  ])(
    "explains invalid media and unavailable browser codecs without sending on $device",
    ({ device, viewport, mobile }) =>
      suite.withPage(
        { viewport, isMobile: mobile, hasTouch: mobile, colorScheme: "dark" },
        async ({ page, context }) => {
          const gateway = await installMockGateway(page, { attachmentMaxBytes: limit });
          // Remove WebCodecs from the real worker before its script is cached.
          await context.route("**/chat-attachment-video.worker-*.js", async (route) => {
            const response = await route.fetch();
            await route.fulfill({
              response,
              body: "globalThis.VideoEncoder = undefined;\n" + (await response.text()),
            });
          });
          await page.goto(suite.server.baseUrl + "chat");
          await page.locator(".agent-chat__composer-combobox textarea").fill("Keep this draft.");
          const expectError = async (error: string, capture: boolean) => {
            await expect.poll(() => button(page, "Send message").isEnabled()).toBe(true);
            if (capture && process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR) {
              await page.screenshot({
                path: path.join(suite.artifactDir, `${device}-compression-failed.png`),
              });
            }
            const toast = page.locator(".app-toast");
            await toast.getByText(error, { exact: true }).waitFor();
            if (capture && process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR) {
              await page.screenshot({
                path: path.join(suite.artifactDir, `${device}-compression-failed-toast.png`),
              });
            }
            await expectAttachmentErrorToast(toast);
            const bounds = (await toast.boundingBox())!;
            expect(bounds.x + bounds.width / 2).toBeCloseTo(viewport.width / 2, 0);
            expect(bounds.y).toBeLessThan(viewport.height / 4);
            expect(await page.locator(".chat-attachment-thumb").count()).toBe(0);
            expect(await page.locator(".chat-attachment-failures").count()).toBe(0);
            expect(await page.locator(".agent-chat__composer-combobox textarea").inputValue()).toBe(
              "Keep this draft.",
            );
          };
          await upload(page, "invalid.mp4", Buffer.alloc(256 * 1024));
          await button(page, "Compress to fit").click();
          await expectError("Could not compress video. Try again.", true);
          await upload(page, "unsupported.mp4");
          await button(page, "Compress to fit").click();
          await expectError("This browser cannot compress this video.", false);
          expect(await gateway.getRequests("chat.send")).toEqual([]);
          expect(await button(page, "Send message").isEnabled()).toBe(true);
        },
      ),
  );

  it("offers the same cancelable preparation in New Session", () =>
    suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      await installMockGateway(page, { attachmentMaxBytes: limit });
      await page.goto(suite.server.baseUrl + "new");
      await upload(page, "screen.mp4");
      await button(page, "Compress to fit").click();
      await page.locator('.chat-attachment-thumb[aria-busy="true"]').waitFor();
      await button(page, "Remove screen.mp4").click();
      await expect.poll(() => page.locator(".chat-attachment-thumb").count()).toBe(0);
    }));
});
