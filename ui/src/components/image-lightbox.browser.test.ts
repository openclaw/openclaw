import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createDeferred } from "../../../test/helpers/promise.js";
import { renderChatImageLightbox } from "../pages/chat/components/chat-image-lightbox.ts";
import { nextFrame } from "../test-helpers/modal-dialog.ts";
import type { ImageLightboxItem } from "./image-lightbox.types.ts";

const containers = new Set<HTMLElement>();
let previousViewport: { width: number; height: number };

beforeEach(async () => {
  previousViewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1440, 1000);
});

afterEach(async () => {
  for (const container of containers) {
    render(nothing, container);
    container.remove();
  }
  containers.clear();
  await page.viewport(previousViewport.width, previousViewport.height);
});

async function mountImage(item: ImageLightboxItem, deferredClose = false) {
  const container = document.body.appendChild(document.createElement("div"));
  containers.add(container);
  render(
    renderChatImageLightbox(item, () => {
      if (deferredClose) {
        queueMicrotask(() => render(nothing, container));
      } else {
        render(nothing, container);
      }
    }),
    container,
  );
  const viewer = container.querySelector("openclaw-image-lightbox")!;
  await viewer.updateComplete;
  const modal = viewer.querySelector("openclaw-modal-dialog")!;
  await modal.updateComplete;
  const dialog = modal.querySelector("dialog")!;
  await expect.poll(() => dialog.open).toBe(true);
  await Promise.all(dialog.getAnimations().map((animation) => animation.finished));
  const image = viewer.querySelector<HTMLImageElement>("img")!;
  await image.decode();
  await nextFrame();
  return { viewer, image };
}

function imageSource(width: number, height: number, color: string) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  return canvas.toDataURL("image/png");
}

describe("progressive image viewer geometry", () => {
  it("restores its original tile after Escape removes a still-closing native modal", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open image tile";
    document.body.append(trigger);
    onTestFinished(() => trigger.remove());
    trigger.focus();
    const { viewer } = await mountImage(
      { src: imageSource(320, 200, "#264060"), title: "Focus return" },
      true,
    );
    const modal = viewer.querySelector("openclaw-modal-dialog")!;
    const dialog = modal.querySelector("dialog")!;
    const animation = dialog.animate({ opacity: [1, 0.5] }, { duration: 60_000 });
    animation.pause();
    onTestFinished(() => animation.cancel());
    expect(dialog.matches(":modal")).toBe(true);

    await userEvent.keyboard("{Escape}");
    await expect.poll(() => viewer.isConnected).toBe(false);
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it.each([false, true])(
    "returns focus after retained native close without stealing newer focus (newer=%s)",
    async (newer) => {
      const trigger = document.createElement("button");
      trigger.textContent = "Open image tile";
      document.body.append(trigger);
      onTestFinished(() => trigger.remove());
      trigger.focus();
      const { viewer } = await mountImage({
        src: imageSource(320, 200, "#264060"),
        title: "Retained close",
      });
      const modal = viewer.querySelector("openclaw-modal-dialog")!;
      const dialog = modal.querySelector("dialog")!;
      const animation = dialog.animate({ opacity: [1, 0.5] }, { duration: 60_000 });
      animation.pause();
      onTestFinished(() => animation.cancel());
      const hidden = new Promise<void>((resolve) => {
        modal.addEventListener("wa-after-hide", () => resolve(), { once: true });
      });
      modal.hide();
      expect(modal.open).toBe(false);
      expect(dialog.open).toBe(true);
      expect(document.activeElement).not.toBe(trigger);

      let expected: HTMLElement = trigger;
      if (newer) {
        const next = document.createElement("openclaw-modal-dialog");
        const input = document.createElement("input");
        input.autofocus = true;
        next.append(input);
        document.body.append(next);
        onTestFinished(() => next.remove());
        await next.updateComplete;
        expect(document.activeElement).toBe(input);
        expected = input;
      }
      animation.finish();
      await hidden;
      expect(dialog.open).toBe(false);
      expect(document.activeElement).toBe(expected);
    },
  );

  it.each([
    { name: "landscape", width: 1600, height: 960, previewWidth: 1200, previewHeight: 720 },
    { name: "portrait", width: 1600, height: 3000, previewWidth: 640, previewHeight: 1200 },
    { name: "small", width: 320, height: 200, previewWidth: 320, previewHeight: 200 },
  ])(
    "preserves fitted size, position, and zoom when a $name preview upgrades",
    async ({ width, height, previewWidth, previewHeight }) => {
      const full = createDeferred<ImageLightboxItem | null>();
      const source = imageSource(width, height, "#264060");
      const { viewer, image } = await mountImage({
        src: imageSource(previewWidth, previewHeight, "#284262"),
        title: "Synthetic screenshot",
        width,
        height,
        loadFullResolution: () => full.promise,
      });
      const fitted = image.getBoundingClientRect();
      expect(fitted.width).toBeGreaterThan(0);
      expect(fitted.width / fitted.height).toBeCloseTo(width / height, 2);
      expect(fitted.width).toBeLessThanOrEqual(width);
      expect(fitted.height).toBeLessThanOrEqual(height);
      expect(fitted.left).toBeGreaterThanOrEqual(0);
      expect(fitted.right).toBeLessThanOrEqual(window.innerWidth);
      expect(fitted.top).toBeGreaterThanOrEqual(0);
      expect(fitted.bottom).toBeLessThanOrEqual(window.innerHeight);

      viewer.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click();
      const zoom = viewer.querySelector(".zoom-level")!;
      await expect.poll(() => zoom.textContent?.trim()).not.toBe("100%");
      await Promise.all(image.getAnimations().map((animation) => animation.finished));
      const zoomBefore = zoom.textContent;
      const before = image.getBoundingClientRect();
      full.resolve({ src: source, title: "Synthetic screenshot", width, height });
      await expect.poll(() => image.src).toBe(source);
      await image.decode();
      await nextFrame();
      const after = image.getBoundingClientRect();
      expect(zoom.textContent).toBe(zoomBefore);
      for (const dimension of ["x", "y", "width", "height"] as const) {
        expect(after[dimension]).toBeCloseTo(before[dimension], 1);
      }
    },
  );

  it("uses a neighbor's intrinsic size when its dimensions are absent", async () => {
    const neighbor = { src: imageSource(320, 200, "#264060"), title: "Small neighbor" };
    const { viewer, image } = await mountImage({
      src: imageSource(1600, 960, "#284262"),
      title: "Large image",
      width: 1600,
      height: 960,
      gallery: { index: 0, items: [async () => null, async () => neighbor] },
    });
    viewer.querySelector<HTMLButtonElement>('[aria-label="Next image"]')!.click();
    await expect.poll(() => image.src).toBe(neighbor.src);
    await image.decode();
    await nextFrame();
    const bounds = image.getBoundingClientRect();
    expect(bounds.width).toBeCloseTo(320, 1);
    expect(bounds.height).toBeCloseTo(200, 1);
  });
});
