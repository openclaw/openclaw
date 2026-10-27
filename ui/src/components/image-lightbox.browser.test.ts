import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { page, server, userEvent } from "vitest/browser";
import { createDeferred } from "../../../test/helpers/promise.js";
import { nextFrame } from "../test-helpers/modal-dialog.ts";
import { emulateOverlayMedia } from "../test-helpers/overlay-browser-media.ts";
import type { ImageLightboxItem } from "./image-lightbox.types.ts";
import "../styles/base.css";
import "./image-lightbox.tsx";

const containers = new Set<HTMLElement>();
let previousViewport: { width: number; height: number };

async function tabTo(target: HTMLElement, reverse = false) {
  await userEvent.keyboard(reverse ? "{Shift>}{Tab}{/Shift}" : "{Tab}");
  expect(document.activeElement).toBe(target);
}

function expectSameRect(actual: DOMRect, expected: DOMRect) {
  for (const dimension of ["x", "y", "width", "height"] as const) {
    expect(actual[dimension]).toBeCloseTo(expected[dimension], 1);
  }
}

beforeEach(async () => {
  previousViewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1440, 1000);
});

afterEach(async () => {
  for (const container of containers) {
    container.replaceChildren();
    container.remove();
  }
  containers.clear();
  await page.viewport(previousViewport.width, previousViewport.height);
});

async function mountImage(item: Partial<ImageLightboxItem> = {}, deferredClose = false) {
  const { src = imageSource(320, 200), title = "Synthetic image" } = item;
  const container = document.body.appendChild(document.createElement("div"));
  containers.add(container);
  const viewer = document.createElement("openclaw-image-lightbox");
  Object.assign(viewer, {
    gallery: item.gallery,
    loadDisplayImage: item.loadDisplayImage,
    src,
    originalSrc: item.originalSrc ?? "",
    imageTitle: title,
    imageWidth: item.width,
    imageHeight: item.height,
  });
  viewer.addEventListener("image-lightbox-close", () => {
    if (deferredClose) {
      queueMicrotask(() => container.replaceChildren());
    } else {
      container.replaceChildren();
    }
  });
  container.append(viewer);
  await viewer.updateComplete;
  await vi.dynamicImportSettled();
  await expect.poll(() => viewer.querySelector("openclaw-modal-dialog")).not.toBeNull();
  const modal = viewer.querySelector("openclaw-modal-dialog")!;
  await modal.updateComplete;
  const dialog = modal.querySelector("dialog")!;
  await expect.poll(() => dialog.open).toBe(true);
  await Promise.all(dialog.getAnimations().map((animation) => animation.finished));
  const image = viewer.querySelector<HTMLImageElement>("img")!;
  await image.decode();
  await nextFrame();
  return { viewer, image, modal, dialog };
}

function imageSource(width: number, height: number, color = "#264060") {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  return canvas.toDataURL("image/png");
}

it.each([
  { name: "portrait trackpad pinch", width: 360, height: 800, input: "pinch" },
  { name: "landscape mouse wheel", width: 800, height: 360, input: "wheel" },
  { name: "small image double-click", width: 320, height: 200, input: "double-click" },
])(
  "keeps the image point under the pointer during $name zoom",
  async ({ width, height, input }) => {
    const { viewer, image } = await mountImage({
      src: imageSource(width, height, "#264060"),
      title: "Pointer zoom",
      ...(input === "double-click" ? {} : { width, height }),
    });
    const before = image.getBoundingClientRect();
    // An off-center point distinguishes pointer zoom from center-only button zoom.
    const x = before.left + before.width * 0.85;
    const y = before.top + before.height * 0.4;
    const stage = viewer.querySelector(".stage")!;
    // Continue past the 400% cap: a stale transform can reappear when scale stops changing.
    const steps = input === "double-click" ? 1 : 18;
    for (let step = 0; step < steps; step += 1) {
      if (input === "double-click") {
        stage.dispatchEvent(
          new MouseEvent("dblclick", { clientX: x, clientY: y, bubbles: true, cancelable: true }),
        );
      } else {
        stage.dispatchEvent(
          new WheelEvent("wheel", {
            clientX: x,
            clientY: y,
            deltaY: -100,
            ctrlKey: input === "pinch",
            bubbles: true,
            cancelable: true,
          }),
        );
      }
      await nextFrame();
      await nextFrame();
      const after = image.getBoundingClientRect();
      expect(after.width).toBeGreaterThan(before.width);
      expect(after.left + after.width * 0.85).toBeCloseTo(x, 0);
      expect(after.top + after.height * 0.4).toBeCloseTo(y, 0);
    }
    if (input !== "double-click") {
      expect(viewer.querySelector(".zoom-level")?.textContent?.trim()).toBe("400%");
    }

    viewer.querySelector<HTMLButtonElement>('[aria-label="Reset zoom"]')!.click();
    await nextFrame();
    const reset = image.getBoundingClientRect();
    for (const dimension of ["x", "y", "width", "height"] as const) {
      expect(reset[dimension]).toBeCloseTo(before[dimension], 0);
    }
  },
);

it.each(["removed", "newer"])("restores tile focus after %s close", async (mode) => {
  const trigger = document.body.appendChild(document.createElement("button"));
  trigger.textContent = "Open image tile";
  onTestFinished(() => trigger.remove());
  trigger.focus();
  const { viewer, modal, dialog } = await mountImage({}, mode === "removed");
  const animation = dialog.animate({ opacity: [1, 0.5] }, { duration: 60_000 });
  animation.pause();
  onTestFinished(() => animation.cancel());
  if (mode === "removed") {
    expect(dialog.matches(":modal")).toBe(true);
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => viewer.isConnected).toBe(false);
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
    return;
  }
  const hidden = new Promise<void>((resolve) => {
    modal.addEventListener("overlay-after-hide", () => resolve(), { once: true });
  });
  modal.hide();
  expect(modal.open).toBe(false);
  expect(dialog.open).toBe(true);
  expect(document.activeElement).not.toBe(trigger);

  const next = document.createElement("openclaw-modal-dialog");
  const input = document.createElement("input");
  input.autofocus = true;
  next.initialFocus = () => input;
  next.append(input);
  document.body.append(next);
  onTestFinished(() => next.remove());
  await next.updateComplete;
  expect(document.activeElement).toBe(input);
  animation.finish();
  await hidden;
  expect(dialog.open).toBe(false);
  expect(document.activeElement).toBe(input);
});

it.each([
  ["landscape", 1600, 960, 1200, 720],
  ["portrait", 1600, 3000, 640, 1200],
  ["small", 320, 200, 320, 200],
] as const)(
  "preserves %s preview geometry and zoom on upgrade",
  async (_, width, height, previewWidth, previewHeight) => {
    const full = createDeferred<ImageLightboxItem | null>();
    const source = imageSource(width, height, "#264060");
    const { viewer, image } = await mountImage({
      src: imageSource(previewWidth, previewHeight, "#284262"),
      width,
      height,
      loadDisplayImage: () => full.promise,
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
    expect(before.width).toBeGreaterThan(fitted.width);
    expect(before.height).toBeGreaterThan(fitted.height);
    full.resolve({ src: source, title: "Synthetic screenshot", width, height });
    await expect.poll(() => image.src).toBe(source);
    await image.decode();
    await nextFrame();
    const after = image.getBoundingClientRect();
    expect(viewer.querySelector("img")).toBe(image);
    expect(zoom.textContent).toBe(zoomBefore);
    expectSameRect(after, before);
  },
);

it.each([320, 390, 1440])("keeps download below media and clear of zoom at %ipx", async (width) => {
  await page.viewport(width, 1000);
  const { viewer, image } = await mountImage({
    originalSrc: "https://example.invalid/original.png",
  });
  const original = viewer.querySelector<HTMLButtonElement>(".download-image")!;
  expect(viewer.querySelector(".open-original")).toBeNull();
  expect(original.getAttribute("aria-label")).toBe("Download image");
  await expect.element(original).toBeVisible();
  const footer = original.closest<HTMLElement>("openclaw-modal-actions")!;
  expect(footer.parentElement?.lastElementChild).toBe(footer);
  expect(viewer.querySelector(".header .open-original")).toBeNull();
  const bounds = original.getBoundingClientRect();
  const zoom = viewer.querySelector<HTMLElement>(".zoom-controls")!.getBoundingClientRect();
  expect(bounds.top).toBeGreaterThanOrEqual(image.getBoundingClientRect().bottom);
  expect(bounds.left).toBeGreaterThanOrEqual(zoom.right);
  expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
  expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
  expect(bounds.width).toBeGreaterThanOrEqual(44);
  const close = viewer.querySelector<HTMLButtonElement>(".close")!;
  const external = viewer.querySelector<HTMLAnchorElement>(".external-image")!;
  expect(external.href).toBe("https://example.invalid/original.png");
  expect(external.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
  close.focus();
  await tabTo(external, true);
  await tabTo(original, true);
  await tabTo(external);
  await tabTo(close);
});

it("uses intrinsic dimensions for unsized neighbors", async () => {
  const neighbor = { src: imageSource(320, 200), title: "Small neighbor" };
  const { viewer, image } = await mountImage({
    src: imageSource(1600, 960, "#284262"),
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

it("skips the pending video original link without skipping native controls", async () => {
  const original = createDeferred<Response>();
  const originalSrc = imageSource(32, 20);
  const fetch = window.fetch.bind(window);
  const fetchOriginal = vi
    .spyOn(window, "fetch")
    .mockImplementation((input, init) =>
      input === originalSrc ? original.promise : fetch(input, init),
    );
  onTestFinished(() => fetchOriginal.mockRestore());
  const container = document.body.appendChild(document.createElement("div"));
  containers.add(container);
  const trigger = container.appendChild(document.createElement("button"));
  trigger.textContent = "Open synthetic video gallery";
  trigger.focus();
  const viewer = Object.assign(document.createElement("openclaw-image-lightbox"), {
    mediaKind: "video",
    src: new URL("../e2e/fixtures/video-poster.mp4", import.meta.url).href,
    originalSrc,
    imageTitle: "Synthetic gallery video",
    gallery: { index: 0, items: [async () => null, async () => null] },
  });
  viewer.addEventListener("image-lightbox-close", () => viewer.remove());
  container.append(viewer);
  await viewer.updateComplete;
  await expect.poll(() => viewer.querySelector("dialog")?.open).toBe(true);
  const video = viewer.querySelector("video")!;
  await expect.poll(() => video.readyState).toBeGreaterThanOrEqual(2);
  video.pause();
  const close = viewer.querySelector<HTMLButtonElement>(".close")!;
  const previous = viewer.querySelector<HTMLButtonElement>(".previous")!;
  const next = viewer.querySelector<HTMLButtonElement>(".next")!;
  close.focus();
  await tabTo(next, true);
  await tabTo(close);
  await tabTo(video);
  const beforeSeek = video.currentTime;
  let arrowPrevented: boolean | undefined;
  video.addEventListener("keydown", (event) => (arrowPrevented = event.defaultPrevented), {
    once: true,
  });
  await userEvent.keyboard("{ArrowRight}");
  expect(arrowPrevented).toBe(false);
  // A focused WebKit video host does not seek on ArrowRight; Chromium does.
  if (server.browser === "chromium") {
    await expect.poll(() => video.currentTime).toBeGreaterThan(beforeSeek);
  }
  expect(viewer.querySelector(".gallery-counter")?.textContent?.trim()).toBe("1 / 2");
  // Native player controls can expose several stops on the video host.
  for (let stop = 0; stop < 12 && document.activeElement === video; stop++) {
    await userEvent.keyboard("{Tab}");
  }
  expect(document.activeElement).toBe(previous);
  expect(previous.getAttribute("aria-disabled")).toBe("true");
  original.resolve(new Response(new Blob(["png"], { type: "image/png" })));
  await expect
    .poll(() => viewer.querySelector<HTMLAnchorElement>(".open-original")?.tabIndex)
    .toBe(0);
  const link = viewer.querySelector<HTMLAnchorElement>(".open-original")!;
  close.focus();
  await tabTo(link, true);
  await tabTo(close);
  await userEvent.keyboard("{Escape}");
  expect(viewer.isConnected).toBe(false);
  expect(document.activeElement).toBe(trigger);
});

it.each(["no-preference", "reduce"] as const)(
  "keeps portrait images anchored through interrupted gallery transitions (%s)",
  async (reducedMotion) => {
    await emulateOverlayMedia({ reducedMotion });
    onTestFinished(() => emulateOverlayMedia({ reducedMotion: "no-preference" }));
    const first = { src: imageSource(420, 840), title: "First portrait", width: 420, height: 840 };
    const second = {
      src: imageSource(450, 900, "#89562c"),
      title: "Second portrait",
      width: 450,
      height: 900,
    };
    const { viewer, image } = await mountImage({
      ...first,
      gallery: { index: 0, items: [async () => first, async () => second] },
    });
    const cloneNode = image.cloneNode.bind(image);
    // Pause each real outgoing animation before DOM waits can outlast its 100ms duration.
    const cloneSpy = vi.spyOn(image, "cloneNode").mockImplementation((deep) => {
      const clone = cloneNode(deep);
      if (clone instanceof HTMLImageElement) {
        const animate = clone.animate.bind(clone);
        const animationSpy = vi.spyOn(clone, "animate").mockImplementation((...args) => {
          const animation = animate(...args);
          animation.pause();
          return animation;
        });
        onTestFinished(() => animationSpy.mockRestore());
      }
      return clone;
    });
    onTestFinished(() => cloneSpy.mockRestore());
    for (const item of [second, first, second, first]) {
      const previousBounds = image.getBoundingClientRect();
      viewer
        .querySelector<HTMLButtonElement>(
          item === second ? '[aria-label="Next image"]' : '[aria-label="Previous image"]',
        )!
        .click();
      await expect.poll(() => image.src).toBe(item.src);
      await nextFrame();
      const animations = viewer.getAnimations({ subtree: true });
      for (const animation of animations) {
        animation.currentTime = 50;
      }
      const bounds = image.getBoundingClientRect();
      const stage = viewer.querySelector<HTMLElement>(".stage")!.getBoundingClientRect();
      expect(bounds.width).toBeCloseTo(item.width, 1);
      expect(bounds.height).toBeCloseTo(item.height, 1);
      expect(bounds.x).toBeCloseTo(stage.x + (stage.width - item.width) / 2, 1);
      expect(bounds.y).toBeCloseTo(stage.y + 20 + (stage.height - 92 - item.height) / 2, 1);
      expect(getComputedStyle(image).opacity).toBe("1");
      expect(viewer.querySelectorAll("img").length).toBeLessThanOrEqual(2);
      if (reducedMotion === "reduce") {
        expect(viewer.querySelectorAll("img")).toHaveLength(1);
      } else {
        const outgoing = [...viewer.querySelectorAll("img")].find((node) => node !== image)!;
        expect(outgoing).toBeDefined();
        expect(Number(getComputedStyle(outgoing).opacity)).toBeGreaterThan(0);
        expect(Number(getComputedStyle(outgoing).opacity)).toBeLessThan(1);
        expectSameRect(outgoing.getBoundingClientRect(), previousBounds);
      }
    }
    for (const animation of viewer.getAnimations({ subtree: true })) {
      animation.finish();
    }
    await nextFrame();
    expect(viewer.querySelectorAll("img")).toHaveLength(1);
    viewer.querySelector<HTMLButtonElement>('[aria-label="Next image"]')!.click();
    await expect.poll(() => image.src).toBe(second.src);
    await nextFrame();
    viewer.remove();
    await nextFrame();
    expect(viewer.getAnimations({ subtree: true })).toHaveLength(0);
    expect(viewer.querySelectorAll("img").length).toBeLessThanOrEqual(1);
  },
);
