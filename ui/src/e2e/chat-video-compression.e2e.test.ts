import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Client-side video compression" });
const video = readFileSync(new URL("./fixtures/video-poster.mp4", import.meta.url));
// ISO BMFF permits trailing padding; retain the fixture's real video samples,
// while crossing the advertised limit without slowing the encoder test down.
const oversized = Buffer.concat([video, Buffer.alloc(256 * 1024)]);
const limit = 128 * 1024;
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const upload = (page: Page, name: string, buffer = oversized) =>
  page
    .locator(".agent-chat__file-input")
    .first()
    .setInputFiles({ name, mimeType: "video/mp4", buffer });

suite.define(() => {
  it("loads the encoder only after consent and sends a playable bounded copy", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
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
      const frame = await takeControlUiScreenshotFrame(
        page,
        page.locator(".agent-chat__composer-shell"),
        [compress, composer],
        { animations: "disabled" },
      );
      await writeFile(suite.artifactDir + "/compression-offer.png", frame.png);
      await compress.click();
      await composer.fill("The draft stays editable while preparing a video.");
      await composer.press("End");
      await composer.press("!");
      expect(await composer.inputValue()).toBe(
        "The draft stays editable while preparing a video.!",
      );
      await composer.focus();
      const ime = await page.context().newCDPSession(page);
      await ime.send("Input.imeSetComposition", {
        text: "入力",
        selectionStart: 2,
        selectionEnd: 2,
      });
      await page.locator(".chat-attachment-thumb--preparation").waitFor({ state: "detached" });
      expect(await composer.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await composer.inputValue()).toBe(
        "The draft stays editable while preparing a video.!入力",
      );
      await ime.send("Input.insertText", { text: "入力" });
      await ime.detach();
      expect(encoderRequests().length).toBeGreaterThan(0);
      expect(await gateway.getRequests("chat.send")).toEqual([]);
      await send.click();
      const request = await gateway.waitForRequest("chat.send");
      const params = request.params as {
        message: string;
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
          await new Promise<void>((resolve, reject) => {
            player.addEventListener("loadeddata", () => resolve(), { once: true });
            player.addEventListener(
              "error",
              () => reject(new Error("Compressed video is not playable")),
              { once: true },
            );
          });
          await player.play();
          return {
            width: player.videoWidth,
            height: player.videoHeight,
            duration: player.duration,
          };
        } finally {
          player.pause();
          player.removeAttribute("src");
          player.load();
          URL.revokeObjectURL(url);
        }
      }, output);
      expect(playback).toMatchObject({ width: 320, height: 180 });
      expect(playback.duration).toBeCloseTo(1, 1);
    });
  });

  it("explains invalid media and unavailable browser codecs without sending", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page, context }) => {
      const gateway = await installMockGateway(page, { attachmentMaxBytes: limit });
      // Exercise the real worker and codec negotiation with a missing WebCodecs
      // capability, not a mocked successful/failed compression implementation.
      // Route at context scope before the first worker caches its script.
      await context.route("**/chat-attachment-video.worker-*.js", async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          body: "globalThis.VideoEncoder = undefined;\n" + (await response.text()),
        });
      });
      await page.goto(suite.server.baseUrl + "chat");
      await page.locator(".agent-chat__composer-combobox textarea").fill("Keep this draft.");
      const expectError = async (error: string) => {
        await page
          .locator(".chat-attachment-thumb")
          .getByRole("status")
          .filter({ hasText: error })
          .waitFor();
        await page.getByRole("alert").getByText(error, { exact: true }).waitFor();
      };
      await upload(page, "invalid.mp4", Buffer.alloc(256 * 1024));
      await button(page, "Compress to fit").click();
      const invalidError = "Could not compress this video. Try again or choose a smaller file.";
      await expectError(invalidError);
      await button(page, "Remove invalid.mp4").click();
      await upload(page, "unsupported.mp4");
      await button(page, "Compress to fit").click();
      const unsupportedError =
        "This browser cannot compress this video with its audio. Try another browser or a smaller file.";
      await expectError(unsupportedError);
      expect(await gateway.getRequests("chat.send")).toEqual([]);
      expect(await button(page, "Send message").isEnabled()).toBe(true);
    });
  });

  it("offers the same cancelable preparation in New Session", async () => {
    await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      await installMockGateway(page, { attachmentMaxBytes: limit });
      await page.goto(suite.server.baseUrl + "new");
      await upload(page, "screen.mp4");
      await button(page, "Compress to fit").click();
      await page.locator('.chat-attachment-thumb[aria-busy="true"]').waitFor();
      await button(page, "Remove screen.mp4").click();
      await expect.poll(() => page.locator(".chat-attachment-thumb").count()).toBe(0);
    });
  });
});
