import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Video attachment previews" });
// Synthetic VP9/yuv420p, 320×180, one second; works without proprietary codecs.
const video = readFileSync(new URL("./fixtures/video-poster.mp4", import.meta.url));

suite.define(() => {
  it.each(["chat", "new"])(
    "previews a video without shifting its slot and releases it on removal in %s",
    async (route) => {
      await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
        await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}${route}`);
        const input = page.locator(".agent-chat__file-input").first();
        await input.waitFor({ state: "attached" });
        await page.locator(".shell, .card.chat").evaluateAll(async (elements) => {
          await Promise.all(
            elements.flatMap((element) =>
              element.getAnimations().map((animation) => animation.finished),
            ),
          );
        });
        const resources = await page.evaluateHandle(() => {
          const urls = new Set<string>();
          const media = new Set<HTMLMediaElement>();
          const errors: string[] = [];
          const create = URL.createObjectURL.bind(URL);
          const revoke = URL.revokeObjectURL.bind(URL);
          const createElement = document.createElement.bind(document);
          const idle = window.requestIdleCallback;
          const pending: Parameters<typeof window.requestIdleCallback>[] = [];
          const frames: Array<() => void> = [];
          let holdFrames = true;
          document.createElement = new Proxy(createElement, {
            apply(target, receiver, args) {
              const element: unknown = Reflect.apply(target, receiver, args);
              if (element instanceof HTMLVideoElement) {
                media.add(element);
                element.addEventListener("error", () => errors.push(element.error?.message ?? ""));
                const requestFrame = element.requestVideoFrameCallback.bind(element);
                element.requestVideoFrameCallback = (callback) =>
                  requestFrame((now, metadata) => {
                    if (holdFrames) {
                      frames.push(() => callback(now, metadata));
                    } else {
                      callback(now, metadata);
                    }
                  });
              }
              return element;
            },
          });
          URL.createObjectURL = (blob) => {
            const url = create(blob);
            urls.add(url);
            return url;
          };
          URL.revokeObjectURL = (url) => {
            urls.delete(url);
            revoke(url);
          };
          window.requestIdleCallback = (...args) => pending.push(args);
          return {
            releaseIdle() {
              window.requestIdleCallback = idle;
              for (const args of pending) {
                idle(...args);
              }
            },
            frameState: () => ({ count: frames.length, decoders: media.size, errors }),
            holdFrames() {
              holdFrames = true;
            },
            releaseNextFrame() {
              frames.shift()?.();
            },
            releaseFrames() {
              holdFrames = false;
              for (const callback of frames.splice(0)) {
                callback();
              }
            },
            liveUrls: () => urls.size,
            retainedDecoders: () =>
              [...media].filter((element) => element.hasAttribute("src")).length,
          };
        });
        const waitForFrame = async () => {
          try {
            await expect
              .poll(() => resources.evaluate((proof) => proof.frameState().count))
              .toBe(1);
          } catch (cause) {
            const state = await resources.evaluate((proof) => proof.frameState());
            throw new Error(`Video frame unavailable: ${JSON.stringify(state)}`, { cause });
          }
        };
        await input.setInputFiles({ name: "demo.mp4", mimeType: "video/mp4", buffer: video });
        const chip = page.locator(".chat-attachment-thumb");
        const slot = chip.locator(".chat-attachment-file__preview");
        await slot.waitFor();
        const before = await slot.boundingBox();
        expect(before).toMatchObject({ width: 54, height: 54 });
        expect(await slot.locator("img").count()).toBe(0);
        await resources.evaluate((proof) => proof.releaseIdle());
        await waitForFrame();
        expect(await slot.locator("img").count()).toBe(0);
        await resources.evaluate((proof) => proof.releaseNextFrame());
        await waitForFrame();
        expect(await slot.locator("img").count()).toBe(0);
        await resources.evaluate((proof) => proof.releaseFrames());
        await slot.locator("img").waitFor();
        await expect
          .poll(() => slot.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth))
          .toBe(54);
        expect(
          await slot.locator("img").evaluate((image: HTMLImageElement) => {
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 54;
            const context = canvas.getContext("2d")!;
            context.drawImage(image, 0, 0);
            return new Set(context.getImageData(0, 0, 54, 54).data).size;
          }),
        ).toBeGreaterThan(10);
        expect(await slot.boundingBox()).toEqual(before);
        expect(await resources.evaluate((proof) => proof.retainedDecoders())).toBe(0);
        const preview = await slot.locator("img").getAttribute("src");
        expect(preview).toMatch(/^blob:/u);
        await chip.locator(".chat-attachment-remove").click();
        await expect.poll(() => chip.count()).toBe(0);
        expect(await resources.evaluate((proof) => proof.liveUrls())).toBe(0);
        expect(await page.locator("video").count()).toBe(0);
        expect(
          await page.evaluate(
            async (url) =>
              fetch(url!).then(
                () => false,
                () => true,
              ),
            preview,
          ),
        ).toBe(true);

        await resources.evaluate((proof) => proof.holdFrames());
        await input.setInputFiles({
          name: "remove-before-frame.mp4",
          mimeType: "video/mp4",
          buffer: video,
        });
        await waitForFrame();
        await chip.locator(".chat-attachment-remove").click();
        await resources.evaluate((proof) => proof.releaseFrames());
        await expect.poll(() => resources.evaluate((proof) => proof.liveUrls())).toBe(0);
        expect(await resources.evaluate((proof) => proof.retainedDecoders())).toBe(0);
        expect(await chip.count()).toBe(0);

        await input.setInputFiles({
          name: "unsupported.mov",
          mimeType: "video/quicktime",
          buffer: Buffer.from("not a video"),
        });
        await slot.waitFor();
        await expect.poll(() => resources.evaluate((proof) => proof.liveUrls())).toBe(0);
        expect(await slot.locator("img").count()).toBe(0);
        expect(await slot.locator("svg").count()).toBe(1);
        expect(await resources.evaluate((proof) => proof.retainedDecoders())).toBe(0);
        await chip.locator(".chat-attachment-remove").click();
        await expect.poll(() => chip.count()).toBe(0);
        await resources.dispose();
      });
    },
  );
});
