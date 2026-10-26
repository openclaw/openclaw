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
    (route) =>
      suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
        await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}${route}`);
        const input = page.locator(".agent-chat__file-input").first();
        await input.waitFor({ state: "attached" });
        const resources = await page.evaluateHandle(() => {
          const urls = new Set<string>();
          const media = new Set<HTMLMediaElement>();
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
                const requestFrame = element.requestVideoFrameCallback.bind(element);
                element.requestVideoFrameCallback = (callback) =>
                  requestFrame((now, metadata) =>
                    holdFrames
                      ? frames.push(() => callback(now, metadata))
                      : callback(now, metadata),
                  );
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
              pending.forEach((args) => idle(...args));
            },
            frameCount: () => frames.length,
            holdFrames() {
              holdFrames = true;
            },
            releaseNextFrame: () => frames.shift()?.(),
            releaseFrames() {
              holdFrames = false;
              frames.splice(0).forEach((callback) => callback());
            },
            liveUrls: () => urls.size,
            retainedDecoders: () =>
              [...media].filter((element) => element.hasAttribute("src")).length,
          };
        });
        const waitForFrame = () =>
          expect.poll(() => resources.evaluate((proof) => proof.frameCount())).toBe(1);
        const upload = (name: string, buffer = video, mimeType = "video/mp4") =>
          input.setInputFiles({ name, mimeType, buffer });
        await upload("demo.mp4");
        const chip = page.locator(".chat-attachment-thumb");
        const slot = chip.locator(".chat-attachment-file__preview");
        const poster = slot.locator("img");
        const remove = () => chip.locator(".chat-attachment-remove").click();
        const expectNoDecoders = async () =>
          expect(await resources.evaluate((proof) => proof.retainedDecoders())).toBe(0);
        const waitForNoUrls = () =>
          expect.poll(() => resources.evaluate((proof) => proof.liveUrls())).toBe(0);
        await slot.waitFor();
        const before = await slot.boundingBox();
        expect(before).toMatchObject({ width: 54, height: 54 });
        expect(await poster.count()).toBe(0);
        await resources.evaluate((proof) => proof.releaseIdle());
        await waitForFrame();
        expect(await poster.count()).toBe(0);
        await resources.evaluate((proof) => proof.releaseNextFrame());
        await waitForFrame();
        expect(await poster.count()).toBe(0);
        await resources.evaluate((proof) => proof.releaseFrames());
        await poster.waitFor();
        await expect
          .poll(() => poster.evaluate((image: HTMLImageElement) => image.naturalWidth))
          .toBe(54);
        expect(
          await poster.evaluate((image: HTMLImageElement) => {
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 54;
            const context = canvas.getContext("2d")!;
            context.drawImage(image, 0, 0);
            return new Set(context.getImageData(0, 0, 54, 54).data).size;
          }),
        ).toBeGreaterThan(10);
        expect(await slot.boundingBox()).toEqual(before);
        await expectNoDecoders();
        const preview = await poster.getAttribute("src");
        expect(preview).toMatch(/^blob:/u);
        await remove();
        await expect.poll(() => chip.count()).toBe(0);
        expect(await resources.evaluate((proof) => proof.liveUrls())).toBe(0);
        expect(await page.locator("video").count()).toBe(0);
        await expect(
          page.evaluate((url) => fetch(url!).then(() => undefined), preview),
        ).rejects.toThrow();

        await resources.evaluate((proof) => proof.holdFrames());
        await upload("remove-before-frame.mp4");
        await waitForFrame();
        await remove();
        await resources.evaluate((proof) => proof.releaseFrames());
        await waitForNoUrls();
        await expectNoDecoders();
        expect(await chip.count()).toBe(0);

        await upload("unsupported.mov", Buffer.from("not a video"), "video/quicktime");
        await slot.waitFor();
        await waitForNoUrls();
        expect(await poster.count()).toBe(0);
        expect(await slot.locator("svg").count()).toBe(1);
        await expectNoDecoders();
        await remove();
        await expect.poll(() => chip.count()).toBe(0);
        await resources.dispose();
      }),
  );
});
