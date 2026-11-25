import { readFileSync } from "node:fs";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
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
  it("contains the mobile offer, loads the encoder only after consent, and sends a playable copy", () =>
    suite.withPage(
      { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
      async ({ page }) => {
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
        const basename = "ScreenRecording_10-21-2026 09-53-48_1";
        await upload(page, basename + ".mp4");
        const compress = button(page, "Compress to fit");
        await compress.waitFor();
        expect(await send.isDisabled()).toBe(true);
        expect(encoderRequests()).toEqual([]);
        const normal = page
          .locator(".chat-attachment-thumb")
          .filter({ has: button(page, "Remove small.mp4") });
        const offer = page.locator(".chat-attachment-thumb").filter({ has: compress });
        await normal.locator(".chat-attachment-file").waitFor();
        const normalBox = (await normal.boundingBox())!;
        const offerBox = (await offer.boundingBox())!;
        expect(offerBox).toMatchObject({ y: normalBox.y, height: normalBox.height });
        const removeIcon = ".chat-attachment-remove svg";
        expect((await offer.locator(removeIcon).boundingBox())?.width).toBe(
          (await normal.locator(removeIcon).boundingBox())?.width,
        );
        expect(
          await offer.locator(".chat-attachment-file__name").evaluate((node) => ({
            clipped: node.scrollWidth > node.clientWidth,
            contained:
              node.getBoundingClientRect().right <=
              node.closest(".chat-attachment-thumb")!.getBoundingClientRect().right,
            text: node.textContent,
          })),
        ).toEqual({ clipped: true, contained: true, text: basename + ".mp4" });
        await button(page, "Remove small.mp4").click();
        expect(await offer.count()).toBe(1);
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
        expect([basename + ".mp4", basename + ".webm"]).toContain(output.fileName);
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
      },
    ));

  it("explains invalid media and unavailable browser codecs without sending on mobile", () =>
    suite.withPage(
      {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        colorScheme: "dark",
      },
      async ({ page, context }) => {
        const gateway = await installMockGateway(page, { attachmentMaxBytes: limit });
        let unavailable = true;
        // Remove WebCodecs from the real worker before its script is cached.
        await context.route("**/chat-attachment-video.worker-*.js", async (route) => {
          const response = await route.fetch();
          await route.fulfill({
            response,
            body:
              (unavailable ? "globalThis.VideoEncoder = undefined;\n" : "") +
              (await response.text()),
          });
        });
        await page.goto(suite.server.baseUrl + "chat");
        await page.locator(".agent-chat__composer-combobox textarea").fill("Keep this draft.");
        const expectError = async (error: string) => {
          await expect.poll(() => button(page, "Send message").isEnabled()).toBe(true);
          await page
            .locator(".chat-attachment-thumb")
            .getByRole("status")
            .filter({ hasText: error })
            .waitFor();
          await button(page, "Retry compression").waitFor();
          expect(await page.locator(".app-toast").count()).toBe(0);
          expect(await page.locator(".agent-chat__composer-combobox textarea").inputValue()).toBe(
            "Keep this draft.",
          );
        };
        await upload(page, "invalid.mp4", Buffer.alloc(256 * 1024));
        await button(page, "Compress to fit").click();
        await expectError("Could not compress video. Try again.");
        await button(page, "Remove invalid.mp4").click();
        await upload(page, "unsupported.mp4");
        await button(page, "Compress to fit").click();
        await expectError("This browser cannot compress this video.");
        unavailable = false;
        await button(page, "Retry compression").click();
        await page.locator(".chat-attachment-thumb--preparation").waitFor({ state: "detached" });
        await button(page, "Remove unsupported.mp4").waitFor();
        expect(await gateway.getRequests("chat.send")).toEqual([]);
        expect(await button(page, "Send message").isEnabled()).toBe(true);
      },
    ));
});
