import { readFileSync } from "node:fs";
import type { CDPSession } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Expanded video gallery" });
// Existing synthetic VP9 fixture; no generated media is added to the source tree.
const video = readFileSync(new URL("./fixtures/video-poster.mp4", import.meta.url));

type NativeControlNode = {
  backendNodeId: number;
  attributes?: string[];
  children?: NativeControlNode[];
  shadowRoots?: NativeControlNode[];
};

// CDP is used only to locate Chromium's closed native controls. Input is real mouse input.
async function nativeVideoControlBox(cdp: CDPSession, control: string) {
  const { result } = await cdp.send("Runtime.evaluate", {
    expression:
      'document.querySelector("openclaw-image-lightbox").shadowRoot.querySelector("video")',
  });
  if (!result.objectId) {
    throw new Error("Missing expanded native player");
  }
  const { node } = await cdp.send("DOM.describeNode", {
    objectId: result.objectId,
    depth: -1,
    pierce: true,
  });
  await cdp.send("Runtime.releaseObject", { objectId: result.objectId });
  const find = (candidate: NativeControlNode): NativeControlNode | undefined => {
    if (candidate.attributes?.includes("-webkit-media-controls-" + control)) {
      return candidate;
    }
    for (const child of [...(candidate.children ?? []), ...(candidate.shadowRoots ?? [])]) {
      const found = find(child);
      if (found) {
        return found;
      }
    }
    return undefined;
  };
  const native = find(node);
  if (!native) {
    throw new Error("Missing native control " + control);
  }
  const { model } = await cdp.send("DOM.getBoxModel", { backendNodeId: native.backendNodeId });
  const x = model.content[0]!;
  const y = model.content[1]!;
  return { x, y, width: model.content[2]! - x, height: model.content[5]! - y };
}

suite.define(() => {
  it.each([false, true])(
    "navigates the whole turn and preserves player controls (touch=%s)",
    async (mobile) => {
      await suite.withPage(
        {
          viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
          hasTouch: mobile,
          isMobile: mobile,
        },
        async ({ page, context }) => {
          const dir = createControlUiE2eArtifactDir(
            mobile ? "video-gallery-mobile" : "video-gallery-desktop",
          );
          await page.route("**/gallery-proof/*.mp4", (route) => {
            const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? "");
            const start = range ? Number(range[1]) : 0;
            const end = range?.[2]
              ? Math.min(Number(range[2]), video.length - 1)
              : video.length - 1;
            return route.fulfill({
              status: range ? 206 : 200,
              contentType: "video/mp4",
              headers: {
                "accept-ranges": "bytes",
                ...(range ? { "content-range": `bytes ${start}-${end}/${video.length}` } : {}),
              },
              body: video.subarray(start, end + 1),
            });
          });
          const gateway = await installMockGateway(page, {
            historyMessages: [
              { role: "user", content: "Compare these clips.", timestamp: 1800000000000 },
              {
                role: "assistant",
                content:
                  "**Before**\nMEDIA:https://example.com/gallery-proof/before.mp4\n\n**After**\nMEDIA:https://example.com/gallery-proof/after.mp4",
                timestamp: 1800000001000,
              },
              {
                role: "assistant",
                content: "**Alternate**\nMEDIA:https://example.com/gallery-proof/alternate.mp4",
                timestamp: 1800000002000,
              },
              { role: "user", content: "A separate turn.", timestamp: 1800000003000 },
              {
                role: "assistant",
                content: "MEDIA:https://example.com/gallery-proof/separate.mp4",
                timestamp: 1800000004000,
              },
            ],
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          await gateway.waitForRequest("chat.startup");
          const expand = page.getByRole("button", {
            name: "Expand before.mp4 in the media overlay",
            exact: true,
          });
          await expand.scrollIntoViewIfNeeded();
          await expand.waitFor();
          await page.screenshot({ path: `${dir}/inline.png` });
          await expand.click();
          const viewer = page.locator("openclaw-image-lightbox");
          const player = viewer.locator("video");
          const counter = viewer.locator(".gallery-counter");
          await expect
            .poll(() => player.evaluate((media: HTMLVideoElement) => media.readyState))
            .toBeGreaterThanOrEqual(2);
          await expect.poll(async () => (await counter.textContent())?.trim()).toBe("1 / 3");
          await page.screenshot({ path: `${dir}/expanded-first.png`, animations: "disabled" });
          await page.keyboard.press("ArrowRight");
          await expect.poll(() => player.getAttribute("src")).toContain("after.mp4");
          await page.keyboard.press("ArrowRight");
          await expect.poll(() => player.getAttribute("src")).toContain("alternate.mp4");
          await page.keyboard.press("ArrowRight");
          expect((await counter.textContent())?.trim()).toBe("3 / 3");
          await page.keyboard.press("ArrowLeft");
          await expect.poll(() => player.getAttribute("src")).toContain("after.mp4");
          await expect
            .poll(() => player.evaluate((media: HTMLVideoElement) => media.readyState))
            .toBeGreaterThanOrEqual(2);
          await page.screenshot({ path: `${dir}/expanded-next.png`, animations: "disabled" });
          const controls = await context.newCDPSession(page);
          const clickNative = async (name: string, fraction = 0.5) => {
            await player.hover();
            const box = await nativeVideoControlBox(controls, name);
            await page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2);
          };
          // Pause using the real native button, then scrub the real timeline.
          if (!(await player.evaluate((media: HTMLVideoElement) => media.paused))) {
            await clickNative("play-button");
          }
          await expect
            .poll(() => player.evaluate((media: HTMLVideoElement) => media.paused))
            .toBe(true);
          await clickNative("timeline", 0.25);
          await expect
            .poll(() => player.evaluate((media: HTMLVideoElement) => media.currentTime))
            .toBeGreaterThan(0.1);
          expect((await counter.textContent())?.trim()).toBe("2 / 3");
          await player.focus();
          const beforeSeek = await player.evaluate((media: HTMLVideoElement) => media.currentTime);
          await page.keyboard.press("ArrowRight");
          await expect
            .poll(() => player.evaluate((media: HTMLVideoElement) => media.currentTime))
            .toBeGreaterThan(beforeSeek);
          expect((await counter.textContent())?.trim()).toBe("2 / 3");
          await clickNative("timeline", 0.1);
          await clickNative("play-button");
          await expect
            .poll(() => player.evaluate((media: HTMLVideoElement) => media.paused))
            .toBe(false);
          await clickNative("play-button");
          await expect
            .poll(() => player.evaluate((media: HTMLVideoElement) => media.paused))
            .toBe(true);
          if (!mobile) {
            await clickNative("fullscreen-button");
            await expect
              .poll(() => player.evaluate((media) => media.matches(":fullscreen")))
              .toBe(true);
            await page.keyboard.press("Escape");
            await expect
              .poll(() => player.evaluate((media) => media.matches(":fullscreen")))
              .toBe(false);
            expect(await viewer.count()).toBe(1);
          }
          await controls.detach();
          const retained = await player.elementHandle();
          if (mobile) {
            const touch = await context.newCDPSession(page);
            const timeline = await nativeVideoControlBox(touch, "timeline");
            const timelinePoint = {
              x: timeline.x + timeline.width * 0.2,
              y: timeline.y + timeline.height / 2,
              id: 1,
            };
            await touch.send("Input.dispatchTouchEvent", {
              type: "touchStart",
              touchPoints: [timelinePoint],
            });
            await touch.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [{ ...timelinePoint, x: timeline.x + timeline.width * 0.6 }],
            });
            await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
            await expect
              .poll(() => player.evaluate((media: HTMLVideoElement) => media.currentTime))
              .toBeGreaterThan(0.3);
            expect((await counter.textContent())?.trim()).toBe("2 / 3");
            const swipe = async (dx: number) => {
              const box = await player.boundingBox();
              if (!box) {
                throw new Error("Missing video geometry");
              }
              const point = { x: box.x + box.width / 2, y: box.y + box.height / 3, id: 1 };
              await touch.send("Input.dispatchTouchEvent", {
                type: "touchStart",
                touchPoints: [point],
              });
              for (let step = 1; step <= 5; step++) {
                await touch.send("Input.dispatchTouchEvent", {
                  type: "touchMove",
                  touchPoints: [{ ...point, x: point.x + (dx * step) / 5 }],
                });
              }
              await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
            };
            await swipe(-100);
            await expect.poll(() => player.getAttribute("src")).toContain("alternate.mp4");
            await swipe(100);
            await expect.poll(() => player.getAttribute("src")).toContain("after.mp4");
            await touch.detach();
            expect(await page.locator(".content[inert]").count()).toBe(0);
          }
          await viewer.getByRole("button", { name: "Close video preview", exact: true }).focus();
          await page.keyboard.press("Escape");
          await expect.poll(() => viewer.count()).toBe(0);
          expect(
            await retained?.evaluate(
              (media: HTMLVideoElement) => media.paused && !media.hasAttribute("src"),
            ),
          ).toBe(true);
          await retained?.dispose();
          await expect
            .poll(() => expand.evaluate((element) => element.matches(":focus")))
            .toBe(true);
          await page
            .getByRole("button", { name: "Expand separate.mp4 in the media overlay", exact: true })
            .click();
          expect(await viewer.locator(".gallery-counter").count()).toBe(0);
          await page.keyboard.press("Escape");
        },
      );
    },
  );
});
