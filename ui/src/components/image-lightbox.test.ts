/* @vitest-environment jsdom */

import Panzoom from "@panzoom/panzoom";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import type { ImageLightboxItem, ImageLightboxProps } from "./image-lightbox.types.ts";

vi.mock("@panzoom/panzoom", () => ({
  default: vi.fn(() => ({
    destroy: vi.fn(),
    getScale: vi.fn(() => 1),
    pan: vi.fn(),
    reset: vi.fn(),
    resetStyle: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    zoomToPoint: vi.fn(),
    zoomWithWheel: vi.fn(),
  })),
}));

import "./image-lightbox.tsx";

type Lightbox = HTMLElementTagNameMap["openclaw-image-lightbox"];
const button = (modal: Lightbox, selector: string) =>
  modal.querySelector<HTMLButtonElement>(selector)!;
function pressKey(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, ...init });
  target.dispatchEvent(event);
  return event;
}
function expectFocusCycle(first: HTMLElement, last: HTMLElement, init: KeyboardEventInit = {}) {
  last.focus();
  pressKey(last, "Tab", init);
  expect(document.activeElement).toBe(first);
  pressKey(first, "Tab", { shiftKey: true, ...init });
  expect(document.activeElement).toBe(last);
}
function mockDecoder(decode = async () => {}) {
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      decode = decode;
    },
  );
}
function interceptDownload() {
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  onTestFinished(() => click.mockRestore());
  return click;
}
function trackClose(modal: Lightbox) {
  const close = vi.fn();
  modal.addEventListener("image-lightbox-close", close);
  return close;
}
function attachLightbox(props: Partial<Lightbox>) {
  const modal = Object.assign(document.createElement("openclaw-image-lightbox"), props);
  container.append(modal);
  return modal;
}

let container: HTMLDivElement;
let restoreDialogPolyfill: () => void;
let createObjectUrl: ReturnType<typeof vi.fn<(object: Blob | MediaSource) => string>>;
let revokeObjectUrl: ReturnType<typeof vi.fn<(url: string) => void>>;
let fetchImage: ReturnType<typeof vi.fn>;

async function renderLightbox(props: Partial<ImageLightboxProps> = {}, target = container) {
  const modal = Object.assign(document.createElement("openclaw-image-lightbox"), {
    src: "data:image/png;charset=utf-8;base64,cG5n",
    imageTitle: "Generated lobster",
    mediaKind: "image",
    originalSrc: "",
    ...props,
  });
  mountSolid(() => modal, { container: target });
  await modal.updateComplete;
  const { modal: dialogAdapter } = await getRenderedModalDialog(modal);
  return { modal, dialogAdapter };
}

beforeEach(() => {
  restoreDialogPolyfill = installDialogPolyfill();
  createObjectUrl = vi.fn(() => "blob:lightbox-original");
  revokeObjectUrl = vi.fn();
  fetchImage = vi.fn(async () => ({
    ok: true,
    blob: async () => new Blob(["png"], { type: "image/png" }),
  }));
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = createObjectUrl;
      static override revokeObjectURL = revokeObjectUrl;
    },
  );
  vi.stubGlobal("fetch", fetchImage);
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  container.remove();
  await Promise.resolve();
  restoreDialogPolyfill();
  vi.unstubAllGlobals();
});

it("renders video playback, footer actions and live labels", async () => {
  const src = "https://example.com/demo.mp4?playback=1";
  const originalSrc = "https://example.com/demo.mp4";
  const { modal } = await renderLightbox({
    mediaKind: "video",
    src,
    originalSrc,
    imageTitle: "Demo clip",
  });
  const video = modal.querySelector("video")!;
  expect(video).toMatchObject({ src, controls: true, autoplay: true });
  expect(fetchImage).not.toHaveBeenCalled();
  expect(modal.querySelector("img, .zoom-controls, .header .open-original")).toBeNull();
  const footer = modal.querySelector("openclaw-modal-actions.lightbox-footer")!;
  expect(footer?.parentElement?.lastElementChild).toBe(footer);
  const openOriginal = footer.querySelector<HTMLAnchorElement>(".open-original")!;
  expect(openOriginal.href).toBe(originalSrc);
  const close = button(modal, ".close");
  expect(close.getAttribute("aria-label")).toBe("Close video preview");
  expectFocusCycle(close, openOriginal, { composed: true });
  modal.imageTitle = "Renamed video";
  await modal.updateComplete;
  expect(video.getAttribute("aria-label")).toBe("Renamed video");
  expect(modal.querySelector("openclaw-modal-dialog")?.label).toBe("Video preview: Renamed video");
});

it.each([false, true])(
  "preserves preview/zoom during display upgrade (retry: %s)",
  async (retry) => {
    const full = createDeferred<ImageLightboxItem | null>();
    const decoded = createDeferred();
    const decode = vi.fn(() => (retry ? Promise.resolve() : decoded.promise));
    mockDecoder(decode);
    const original = { src: "blob:original", title: "Screenshot", release: vi.fn() };
    const loadDisplayImage = retry
      ? vi
          .fn<() => Promise<ImageLightboxItem | null>>()
          .mockRejectedValueOnce(new Error("Temporary display failure"))
          .mockResolvedValueOnce(original)
      : vi.fn(() => full.promise);
    const modal = attachLightbox({
      src: "blob:preview",
      imageTitle: "Screenshot",
      loadDisplayImage,
    });
    modal.addEventListener("image-lightbox-close", () => container.replaceChildren());
    await modal.updateComplete;
    const image = modal.querySelector("img")!;
    expect(image.src).toBe("blob:preview");
    expect(modal.querySelector(".open-original")).toBeNull();
    image.dispatchEvent(new Event("load"));
    image.dispatchEvent(new CustomEvent("panzoomchange", { detail: { scale: 2 } }));
    flush();
    modal.imageTitle = "Renamed screenshot";
    await modal.updateComplete;
    expect(image.alt).toBe("Renamed screenshot");
    expect(modal.hasAttribute("title")).toBe(false);
    expect(modal.querySelector("openclaw-modal-dialog")?.label).toBe(
      "Image preview: Renamed screenshot",
    );
    expect(loadDisplayImage).toHaveBeenCalledOnce();
    expect(modal.querySelector(".zoom-level")?.textContent?.trim()).toBe("200%");
    if (retry) {
      await waitForSolid(() =>
        expect(button(modal, ".image-quality-status button").textContent).toBe("Retry"),
      );
      expect(image.src).toBe("blob:preview");
      button(modal, ".image-quality-status button").click();
    } else {
      full.resolve(original);
      await waitForSolid(() => expect(decode).toHaveBeenCalledOnce());
      expect(image.src).toBe("blob:preview");
      decoded.resolve();
    }
    await waitForSolid(() => expect(image.src).toBe("blob:original"));
    image.dispatchEvent(new Event("load"));
    await modal.updateComplete;
    expect(modal.querySelector(".zoom-level")?.textContent?.trim()).toBe("200%");
    expect(modal.querySelector("img")).toBe(image);
    expect(modal.querySelector(".image-quality-status, .open-original")).toBeNull();
    expect(fetchImage).not.toHaveBeenCalled();
    button(modal, ".close").click();
    await waitForSolid(() => expect(original.release).toHaveBeenCalledOnce());
    expect(container.querySelector("openclaw-image-lightbox")).toBeNull();
  },
);

it("rejects opposing navigation while a move is pending", async () => {
  mockDecoder();
  const next = createDeferred<ImageLightboxItem | null>();
  const previous = vi.fn(async () => ({ src: "blob:previous", title: "Previous" }));
  const pending = vi.fn(() => next.promise);
  const { modal } = await renderLightbox({ src: "blob:middle", imageTitle: "Middle" });
  modal.gallery = { index: 1, items: [previous, async () => null, pending] };
  await modal.updateComplete;
  const image = modal.querySelector("img")!;
  button(modal, ".next").click();
  button(modal, ".previous").click();
  await waitForSolid(() => expect(pending).toHaveBeenCalledOnce());
  expect(previous).not.toHaveBeenCalled();
  expect(image.src).toBe("blob:middle");
  next.resolve({ src: "blob:next", title: "Next" });
  await waitForSolid(() => expect(image.src).toBe("blob:next"));
  expect(modal.querySelector(".title")?.textContent).toBe("Next");
});

it("replaces video connections and disconnects before close", async () => {
  const order: string[] = [];
  const disconnect = vi.fn();
  const connectVideo = vi.fn(() => disconnect);
  const modal = attachLightbox({ mediaKind: "video", connectVideo });
  await modal.updateComplete;
  await waitForSolid(() => expect(connectVideo).toHaveBeenCalledOnce());
  const video = modal.querySelector("video")!;
  modal.imageTitle = "Renamed video";
  await modal.updateComplete;
  expect(connectVideo).toHaveBeenCalledOnce();
  expect(disconnect).not.toHaveBeenCalled();

  disconnect.mockImplementation(() => order.push("disconnect"));
  const replacementDisconnect = vi.fn();
  const replacement = vi.fn(() => {
    order.push("connect");
    return replacementDisconnect;
  });
  modal.connectVideo = replacement;
  await waitForSolid(() => expect(replacement).toHaveBeenCalledOnce());
  expect(order).toEqual(["disconnect", "connect"]);
  expect(replacement).toHaveBeenCalledWith(video, expect.any(Function), false);
  expect(modal.querySelector("video")).toBe(video);

  const closed = vi.fn(() => expect(replacementDisconnect).toHaveBeenCalledOnce());
  modal.addEventListener("image-lightbox-close", closed);
  button(modal, ".close").click();
  expect(closed).toHaveBeenCalledOnce();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(replacementDisconnect).toHaveBeenCalledOnce();
});

it("ignores retired media events when switching kind", async () => {
  const { modal } = await renderLightbox();
  const image = modal.querySelector<HTMLImageElement>("img")!;
  image.dispatchEvent(new Event("load"));
  const disconnect = vi.fn();
  const connectVideo = vi.fn(() => disconnect);
  Object.assign(modal, { mediaKind: "video", connectVideo });
  await modal.updateComplete;
  const video = modal.querySelector("video")!;
  await waitForSolid(() =>
    expect(connectVideo).toHaveBeenCalledExactlyOnceWith(video, expect.any(Function), false),
  );
  expect(image.isConnected).toBe(false);

  vi.mocked(Panzoom).mockClear();
  image.dispatchEvent(new Event("load"));
  image.dispatchEvent(new Event("error"));
  expect(Panzoom).not.toHaveBeenCalled();

  modal.mediaKind = "image";
  await modal.updateComplete;
  expect(disconnect).toHaveBeenCalledOnce();
  expect(video.isConnected).toBe(false);
  modal.querySelector("img")!.dispatchEvent(new Event("load"));
  await modal.updateComplete;
  expect(button(modal, '[aria-label="Zoom in"]').getAttribute("aria-disabled")).toBe("false");
});

it("retires detached work and reconnects without downloading", async () => {
  const { modal } = await renderLightbox();
  const image = modal.querySelector<HTMLImageElement>("img")!;
  const neighbor = vi.fn(async () => null);
  modal.gallery = { index: 0, items: [async () => null, neighbor] };
  modal.remove();
  await modal.updateComplete;
  await Promise.resolve();
  expect(fetchImage).not.toHaveBeenCalled();
  expect(createObjectUrl).not.toHaveBeenCalled();
  expect(revokeObjectUrl).not.toHaveBeenCalled();
  expect(neighbor).not.toHaveBeenCalled();
  vi.mocked(Panzoom).mockClear();
  image.dispatchEvent(new Event("load"));
  expect(Panzoom).not.toHaveBeenCalled();
  container.append(modal);
  await modal.updateComplete;
  expect(modal.querySelector(".download-image")).not.toBeNull();
  expect(fetchImage).not.toHaveBeenCalled();
});

it.each([
  ["data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'></svg>", "image/svg+xml", false],
  ["blob:untrusted-svg", "image/svg+xml", false],
  ["blob:safe-png", "image/png", true],
] as const)("downloads only inert image bytes on request: %s", async (src, type, allowed) => {
  fetchImage.mockResolvedValueOnce({
    ok: true,
    blob: async () => new Blob(["image"], { type }),
  });
  const click = interceptDownload();
  const { modal } = await renderLightbox({ src });
  expect(fetchImage).not.toHaveBeenCalled();
  expect(modal.querySelector(".open-original")).toBeNull();
  button(modal, ".download-image").click();
  await waitForSolid(() =>
    expect(modal.querySelector(".download-image")?.hasAttribute("disabled")).toBe(false),
  );
  expect(fetchImage).toHaveBeenCalledExactlyOnceWith(src);
  expect(createObjectUrl).toHaveBeenCalledTimes(allowed ? 1 : 0);
  expect(click).toHaveBeenCalledTimes(allowed ? 1 : 0);
});

it.each(["url", "blob", "gallery-url", "gallery-blob"] as const)(
  "downloads the selected original only on request: %s",
  async (source) => {
    const original = createDeferred<Blob>();
    const gallery = source.startsWith("gallery");
    const blob = source === "blob";
    const readOriginalBlob = vi.fn(() =>
      blob ? original.promise : Promise.resolve(new Blob(["first"], { type: "image/png" })),
    );
    const click = interceptDownload();
    const first = "https://example.com/first.png",
      next = "https://example.com/next.png";
    const { modal } = await renderLightbox({
      src: "blob:preview",
      originalSrc: blob ? "" : first,
      readOriginalBlob: source.endsWith("blob") ? readOriginalBlob : undefined,
    });
    expect(readOriginalBlob).not.toHaveBeenCalled();
    expect(fetchImage).not.toHaveBeenCalled();
    expect(modal.querySelector(".open-original")).toBeNull();
    if (gallery) {
      mockDecoder();
      modal.gallery = {
        index: 0,
        items: [async () => null, async () => ({ src: next, title: "Next" })],
      };
      await modal.updateComplete;
      button(modal, ".navigation.next").click();
      await waitForSolid(() => expect(modal.querySelector("img")?.src).toBe(next));
      expect(fetchImage).not.toHaveBeenCalled();
    }
    const download = button(modal, ".download-image");
    download.click();
    if (blob) {
      flush();
      expect(readOriginalBlob).toHaveBeenCalledOnce();
      expect(download.disabled).toBe(true);
      expect(download.getAttribute("aria-busy")).toBe("true");
      download.click();
      expect(readOriginalBlob).toHaveBeenCalledOnce();
      original.resolve(new Blob(["original"], { type: "image/png" }));
    }
    await waitForSolid(() => expect(click).toHaveBeenCalledOnce());
    if (blob) {
      expect(fetchImage).not.toHaveBeenCalled();
      expect(download.disabled).toBe(false);
    } else {
      expect(readOriginalBlob).not.toHaveBeenCalled();
      expect(fetchImage).toHaveBeenCalledExactlyOnceWith(gallery ? next : first);
    }
  },
);

it("offers browser access for external images", async () => {
  const { modal } = await renderLightbox({ src: "https://images.example.org/photo.jpg" });
  const link = modal.querySelector<HTMLAnchorElement>(".external-image");
  expect(link).toMatchObject({ href: "https://images.example.org/photo.jpg", target: "_blank" });
  expect(link?.rel).toContain("noreferrer");
  expect(link?.getAttribute("aria-label")).toBe("Open in new tab");
  expect(fetchImage).not.toHaveBeenCalled();
  Object.assign(modal, { src: new URL("/api/chat/media/photo/thumbnail", location.href).href });
  await modal.updateComplete;
  expect(modal.querySelector(".external-image")).toBeNull();
});

it("gates zoom shortcuts and traps Tab focus", async () => {
  const { modal, dialogAdapter } = await renderLightbox();
  const image = modal.querySelector<HTMLImageElement>(".image")!;
  expect(image).toMatchObject({
    src: "data:image/png;charset=utf-8;base64,cG5n",
    alt: "Generated lobster",
  });
  expect(button(modal, ".close").hasAttribute("autofocus")).toBe(true);
  const zoomIn = button(modal, '[aria-label="Zoom in"]');
  expect(zoomIn?.getAttribute("aria-disabled")).toBe("true");
  const unavailableShortcut = pressKey(dialogAdapter, "+", { cancelable: true });
  expect(unavailableShortcut.defaultPrevented).toBe(false);

  image.dispatchEvent(new Event("error"));
  await modal.updateComplete;
  expect(zoomIn?.getAttribute("aria-disabled")).toBe("true");

  image.dispatchEvent(new Event("load"));
  flush();
  expect(zoomIn?.getAttribute("aria-disabled")).toBe("false");
  const availableShortcut = pressKey(dialogAdapter, "+", { cancelable: true });
  expect(availableShortcut.defaultPrevented).toBe(true);

  expectFocusCycle(button(modal, ".close"), button(modal, ".download-image"));
});

it("captures gallery shortcuts and releases them on removal", async () => {
  mockDecoder();
  const { modal, dialogAdapter } = await renderLightbox();
  const initialSource = modal.src;
  const nextSource = "https://example.com/next.png";
  modal.gallery = {
    index: 0,
    items: [
      async () => ({ src: initialSource, title: "Generated lobster" }),
      async () => ({ src: nextSource, title: "Next image" }),
    ],
  };
  await modal.updateComplete;
  const image = modal.querySelector<HTMLImageElement>(".image")!;
  image.dispatchEvent(new Event("load"));
  const panzoom = vi.mocked(Panzoom).mock.results.at(-1)!.value;
  image.addEventListener("keydown", (event) => event.stopPropagation());
  const press = (value: string, modifiers: KeyboardEventInit = {}) =>
    pressKey(image, value, { cancelable: true, ...modifiers });

  expect(press("ArrowRight", { shiftKey: true }).defaultPrevented).toBe(false);
  expect(panzoom.pan).not.toHaveBeenCalled();
  await modal.updateComplete;
  expect(image.src).toBe(initialSource);

  vi.mocked(panzoom.getScale).mockReturnValue(2);
  for (const [key, x, y] of [
    ["ArrowLeft", -24, 0],
    ["ArrowRight", 24, 0],
    ["ArrowUp", 0, -24],
    ["ArrowDown", 0, 24],
  ] as const) {
    expect(press(key, { shiftKey: true }).defaultPrevented).toBe(true);
    expect(panzoom.pan).toHaveBeenLastCalledWith(x, y, { relative: true, animate: false });
  }
  expect(press("ArrowRight", { shiftKey: true, metaKey: true }).defaultPrevented).toBe(false);
  expect(panzoom.pan).toHaveBeenCalledTimes(4);
  expect(image.src).toBe(initialSource);

  for (const [key, source] of [
    ["ArrowRight", nextSource],
    ["ArrowLeft", initialSource],
  ] as const) {
    expect(press(key).defaultPrevented).toBe(true);
    await waitForSolid(() => expect(image.src).toBe(source));
  }

  modal.remove();
  await Promise.resolve();
  const retiredShortcut = pressKey(dialogAdapter, "ArrowRight", { cancelable: true });
  expect(retiredShortcut.defaultPrevented).toBe(false);
});

it("closes once per button or modal cancellation", async () => {
  const { modal, dialogAdapter } = await renderLightbox();
  const close = trackClose(modal);
  modal.querySelector<HTMLButtonElement>("button")?.click();
  expect(close).toHaveBeenCalledOnce();
  dialogAdapter.dispatchEvent(new CustomEvent("modal-cancel", { bubbles: true }));
  expect(close).toHaveBeenCalledTimes(2);
});

it.each(["document", "shadow"] as const)(
  "dismisses only backdrop click gestures (%s root)",
  async (rootKind) => {
    const mountTarget =
      rootKind === "shadow"
        ? container.attachShadow({ mode: "open" }).appendChild(document.createElement("div"))
        : container;
    const { modal } = await renderLightbox({}, mountTarget);
    const hitTestRoot = modal.getRootNode();
    const stage = modal.querySelector<HTMLElement>(".stage");
    const slide = modal.querySelector<HTMLElement>(".slide");
    slide?.addEventListener("pointerdown", (event) => event.stopPropagation());
    const image = modal.querySelector<HTMLImageElement>(".image");
    const elementFromPoint = Object.getOwnPropertyDescriptor(hitTestRoot, "elementFromPoint");
    onTestFinished(() => {
      if (elementFromPoint) {
        Object.defineProperty(hitTestRoot, "elementFromPoint", elementFromPoint);
      } else {
        Reflect.deleteProperty(hitTestRoot, "elementFromPoint");
      }
    });
    Object.defineProperty(hitTestRoot, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => stage ?? null),
    });
    const close = trackClose(modal);

    const pointer = (target: Element | null | undefined, type: string, pointerId: number, xy = 0) =>
      target?.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          button: 0,
          isPrimary: true,
          pointerId,
          clientX: xy,
          clientY: xy,
        }),
      );
    pointer(image, "pointerdown", 1);
    pointer(stage, "pointerup", 1);
    expect(close).not.toHaveBeenCalled();

    pointer(stage, "pointerdown", 2, 10);
    pointer(stage, "pointerup", 2, 30);
    expect(close).not.toHaveBeenCalled();

    pointer(slide, "pointerdown", 3, 10);
    pointer(stage, "pointerup", 3, 10);
    expect(close).toHaveBeenCalledOnce();
  },
);
