/* @vitest-environment jsdom */

import Panzoom from "@panzoom/panzoom";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import type { ImageLightboxItem } from "./image-lightbox.types.ts";

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

let container: HTMLDivElement;
let restoreDialogPolyfill: () => void;
let createObjectUrl: ReturnType<typeof vi.fn<(object: Blob | MediaSource) => string>>;
let revokeObjectUrl: ReturnType<typeof vi.fn<(url: string) => void>>;
let fetchImage: ReturnType<typeof vi.fn>;

async function renderLightbox(
  {
    src = "data:image/png;base64,cG5n",
    imageTitle = "Generated lobster",
    mediaKind = "image",
    originalSrc = "",
  } = {},
  target = container,
) {
  const modal = document.createElement("openclaw-image-lightbox");
  Object.assign(modal, { src, mediaKind, originalSrc, imageTitle });
  mountSolid(() => modal, { container: target });
  await modal.updateComplete;
  const { modal: dialogAdapter } = await getRenderedModalDialog(modal);
  return { modal, dialogAdapter };
}

describe("openclaw-image-lightbox", () => {
  beforeEach(() => {
    restoreDialogPolyfill = installDialogPolyfill();
    createObjectUrl = vi.fn(() => "blob:lightbox-original");
    revokeObjectUrl = vi.fn();
    fetchImage = vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(["png"], { type: "image/png" }),
    }));
    const NativeUrl = URL;
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override createObjectURL(object: Blob | MediaSource): string {
          return createObjectUrl(object);
        }

        static override revokeObjectURL(url: string): void {
          revokeObjectUrl(url);
        }
      },
    );
    vi.stubGlobal("fetch", fetchImage);
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(async () => {
    container.replaceChildren();
    container.remove();
    await Promise.resolve();
    restoreDialogPolyfill();
    vi.unstubAllGlobals();
  });

  it.each(["image", "video"] as const)(
    "renders a labelled %s with its secondary media action and close",
    async (mediaKind) => {
      const isVideo = mediaKind === "video";
      const src = isVideo
        ? "https://example.com/demo.mp4?playback=1"
        : "data:image/png;charset=utf-8;base64,cG5n";
      const originalSrc = isVideo ? "https://example.com/demo.mp4" : "";
      const imageTitle = isVideo ? "Demo clip" : "Generated lobster";
      fetchImage.mockResolvedValueOnce({
        blob: async () => new Blob(["png"], { type: "image/png;charset=utf-8" }),
      });
      const { modal } = await renderLightbox({ mediaKind, src, originalSrc, imageTitle });
      const root = modal;
      const media = root.querySelector<HTMLImageElement | HTMLVideoElement>(
        mediaKind === "video" ? "video" : "img",
      )!;
      expect(media.src).toBe(src);
      expect(fetchImage).not.toHaveBeenCalled();
      expect(root.querySelector<HTMLAnchorElement>(".open-original")?.href ?? "").toBe(originalSrc);
      const footer = root.querySelector("openclaw-modal-actions.lightbox-footer");
      expect(root.querySelector(".header .open-original")).toBeNull();
      expect(footer?.parentElement?.lastElementChild).toBe(footer);
      expect(footer?.querySelector(isVideo ? ".open-original" : ".download-image")).not.toBeNull();
      if (isVideo) {
        const video = root.querySelector<HTMLVideoElement>("video")!;
        expect(video.controls).toBe(true);
        expect(video.autoplay).toBe(true);
        expect(root.querySelector("img, .zoom-controls")).toBeNull();
        expect(root.querySelector(".close")?.getAttribute("aria-label")).toBe(
          "Close video preview",
        );
        const openOriginal = root.querySelector<HTMLAnchorElement>(".open-original");
        const close = root.querySelector<HTMLButtonElement>(".close")!;
        openOriginal?.focus();
        openOriginal?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Tab", bubbles: true, composed: true }),
        );
        expect(document.activeElement).toBe(close);
        close.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Tab",
            shiftKey: true,
            bubbles: true,
            composed: true,
          }),
        );
        expect(document.activeElement).toBe(openOriginal);
      } else {
        expect(media.getAttribute("alt")).toBe("Generated lobster");
        expect(modal.hasAttribute("title")).toBe(false);
        expect(root.querySelector(".open-original")).toBeNull();
        expect(root.querySelector(".download-image")?.getAttribute("aria-label")).toBe(
          "Download image",
        );
        expect(fetchImage).not.toHaveBeenCalled();
        expect(root.querySelector(".close")?.hasAttribute("autofocus")).toBe(true);
      }
      modal.imageTitle = `Renamed ${mediaKind}`;
      await modal.updateComplete;
      expect(media.getAttribute(isVideo ? "aria-label" : "alt")).toBe(`Renamed ${mediaKind}`);
      expect(root.querySelector("openclaw-modal-dialog")?.label).toBe(
        `${isVideo ? "Video" : "Image"} preview: Renamed ${mediaKind}`,
      );
    },
  );

  it("keeps the same preview element and zoom until a decoded display rendition replaces it", async () => {
    const full = createDeferred<ImageLightboxItem | null>();
    const decoded = createDeferred();
    const decode = vi.fn(() => decoded.promise);
    vi.stubGlobal(
      "Image",
      class {
        src = "";
        decode = decode;
      },
    );
    const original = { src: "blob:original", title: "Screenshot", release: vi.fn() };
    const modal = document.createElement("openclaw-image-lightbox");
    modal.src = "blob:preview";
    modal.imageTitle = "Screenshot";
    modal.loadDisplayImage = () => full.promise;
    modal.addEventListener("image-lightbox-close", () => container.replaceChildren());
    container.append(modal);
    await modal.updateComplete;
    const image = modal.querySelector<HTMLImageElement>("img")!;
    expect(image.src).toBe("blob:preview");
    expect(modal.querySelector(".open-original")).toBeNull();
    image.dispatchEvent(new Event("load"));
    image.dispatchEvent(new CustomEvent("panzoomchange", { detail: { scale: 2 } }));
    flush();

    full.resolve(original);
    await waitForSolid(() => expect(decode).toHaveBeenCalledOnce());
    expect(image.src).toBe("blob:preview");
    decoded.resolve();
    await waitForSolid(() => expect(image.src).toBe("blob:original"));
    image.dispatchEvent(new Event("load"));
    await modal.updateComplete;
    expect(modal.querySelector(".zoom-level")?.textContent?.trim()).toBe("200%");
    expect(modal.querySelector("img")).toBe(image);
    expect(modal.querySelector(".open-original")).toBeNull();
    expect(fetchImage).not.toHaveBeenCalled();
    modal.querySelector<HTMLButtonElement>(".close")!.click();
    await waitForSolid(() => expect(original.release).toHaveBeenCalledOnce());
    expect(container.querySelector("openclaw-image-lightbox")).toBeNull();
  });

  it("keeps a pending gallery move authoritative before display commits", async () => {
    vi.stubGlobal(
      "Image",
      class {
        decode = async () => {};
      },
    );
    const next = createDeferred<ImageLightboxItem | null>();
    const previous = vi.fn(async () => ({ src: "blob:previous", title: "Previous" }));
    const pending = vi.fn(() => next.promise);
    const { modal } = await renderLightbox({ src: "blob:middle", imageTitle: "Middle" });
    modal.gallery = { index: 1, items: [previous, async () => null, pending] };
    await modal.updateComplete;
    const image = modal.querySelector("img")!;
    modal.querySelector<HTMLButtonElement>(".next")!.click();
    modal.querySelector<HTMLButtonElement>(".previous")!.click();
    await waitForSolid(() => expect(pending).toHaveBeenCalledOnce());
    expect(previous).not.toHaveBeenCalled();
    expect(image.src).toBe("blob:middle");
    next.resolve({ src: "blob:next", title: "Next" });
    await waitForSolid(() => expect(image.src).toBe("blob:next"));
    expect(modal.querySelector(".title")?.textContent).toBe("Next");
  });

  it("disconnects the selected video before publishing close", async () => {
    const disconnect = vi.fn();
    const connectVideo = vi.fn(() => disconnect);
    const modal = document.createElement("openclaw-image-lightbox");
    modal.mediaKind = "video";
    modal.connectVideo = connectVideo;
    container.append(modal);
    await modal.updateComplete;
    await waitForSolid(() => expect(connectVideo).toHaveBeenCalledOnce());
    const closed = vi.fn(() => expect(disconnect).toHaveBeenCalledOnce());
    modal.addEventListener("image-lightbox-close", closed);
    modal.querySelector<HTMLButtonElement>(".close")!.click();
    expect(closed).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("uses only mounted media when switching between image and video", async () => {
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
    expect(modal.querySelector('[aria-label="Zoom in"]')?.getAttribute("aria-disabled")).toBe(
      "false",
    );
  });

  it("retires queued image work on detachment without downloading originals, then reconnects", async () => {
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
  ] as const)(
    "downloads only inert image bytes on explicit request: %s",
    async (src, type, allowed) => {
      fetchImage.mockResolvedValueOnce({
        ok: true,
        blob: async () => new Blob(["image"], { type }),
      });
      const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
      onTestFinished(() => click.mockRestore());
      const { modal } = await renderLightbox({ src });
      expect(fetchImage).not.toHaveBeenCalled();
      expect(modal.querySelector(".open-original")).toBeNull();
      modal.querySelector<HTMLButtonElement>(".download-image")!.click();
      await waitForSolid(() =>
        expect(modal.querySelector(".download-image")?.hasAttribute("disabled")).toBe(false),
      );
      expect(fetchImage).toHaveBeenCalledExactlyOnceWith(src);
      expect(createObjectUrl).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(click).toHaveBeenCalledTimes(allowed ? 1 : 0);
    },
  );

  it("fetches an explicitly supplied original only after Download image is selected", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    onTestFinished(() => click.mockRestore());
    const { modal } = await renderLightbox({
      src: "blob:preview",
      originalSrc: "https://example.com/original.png",
    });
    expect(fetchImage).not.toHaveBeenCalled();
    expect(modal.querySelector(".open-original")).toBeNull();
    modal.querySelector<HTMLButtonElement>(".download-image")!.click();
    await waitForSolid(() => expect(click).toHaveBeenCalledOnce());
    expect(fetchImage).toHaveBeenCalledExactlyOnceWith("https://example.com/original.png");
  });

  it("reads original bytes lazily instead of fetching its preview", async () => {
    const original = createDeferred<Blob>();
    const readOriginalBlob = vi.fn(() => original.promise);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    onTestFinished(() => click.mockRestore());
    const modal = document.createElement("openclaw-image-lightbox");
    Object.assign(modal, { src: "blob:preview", imageTitle: "Screenshot", readOriginalBlob });
    container.append(modal);
    await modal.updateComplete;
    expect(readOriginalBlob).not.toHaveBeenCalled();
    expect(fetchImage).not.toHaveBeenCalled();
    const download = modal.querySelector<HTMLButtonElement>(".download-image")!;
    download.click();
    flush();
    expect(readOriginalBlob).toHaveBeenCalledOnce();
    expect(download.disabled).toBe(true);
    expect(download.getAttribute("aria-busy")).toBe("true");
    download.click();
    expect(readOriginalBlob).toHaveBeenCalledOnce();
    original.resolve(new Blob(["original"], { type: "image/png" }));
    await waitForSolid(() => expect(click).toHaveBeenCalledOnce());
    expect(fetchImage).not.toHaveBeenCalled();
    expect(download.disabled).toBe(false);
  });

  it.each([false, true])(
    "downloads the selected gallery item, not initial props (reader: %s)",
    async (customReader) => {
      vi.stubGlobal(
        "Image",
        class {
          src = "";
          decode = async () => {};
        },
      );
      const firstReader = vi.fn(async () => new Blob(["first"], { type: "image/png" }));
      const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
      onTestFinished(() => click.mockRestore());
      const { modal } = await renderLightbox({
        src: "blob:preview",
        originalSrc: "https://example.com/first.png",
      });
      modal.readOriginalBlob = customReader ? firstReader : undefined;
      modal.gallery = {
        index: 0,
        items: [
          async () => null,
          async () => ({ src: "https://example.com/next.png", title: "Next" }),
        ],
      };
      await modal.updateComplete;
      modal.querySelector<HTMLButtonElement>(".navigation.next")!.click();
      await waitForSolid(() =>
        expect(modal.querySelector<HTMLImageElement>("img")?.src).toBe(
          "https://example.com/next.png",
        ),
      );
      expect(fetchImage).not.toHaveBeenCalled();
      modal.querySelector<HTMLButtonElement>(".download-image")!.click();
      await waitForSolid(() => expect(click).toHaveBeenCalledOnce());
      expect(firstReader).not.toHaveBeenCalled();
      expect(fetchImage).toHaveBeenCalledExactlyOnceWith("https://example.com/next.png");
    },
  );

  it("keeps explicit browser access for external images without CORS downloads", async () => {
    fetchImage.mockRejectedValue(new TypeError("Failed to fetch"));
    const { modal } = await renderLightbox({ src: "https://images.example.org/photo.jpg" });
    const link = modal.querySelector<HTMLAnchorElement>(".external-image");
    expect(link?.href).toBe("https://images.example.org/photo.jpg");
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toContain("noreferrer");
    expect(link?.getAttribute("aria-label")).toBe("Open in new tab");
    expect(fetchImage).not.toHaveBeenCalled();
    Object.assign(modal, { src: new URL("/api/chat/media/photo/thumbnail", location.href).href });
    await modal.updateComplete;
    expect(modal.querySelector(".external-image")).toBeNull();
  });

  it("retains the preview and zoom with a visible retry after display-image failure", async () => {
    vi.stubGlobal(
      "Image",
      class {
        src = "";
        decode = async () => {};
      },
    );
    const load = vi
      .fn<() => Promise<ImageLightboxItem | null>>()
      .mockRejectedValueOnce(new Error("Temporary display failure"))
      .mockResolvedValueOnce({ src: "blob:display", title: "Screenshot" });
    const modal = document.createElement("openclaw-image-lightbox");
    Object.assign(modal, { src: "blob:preview", imageTitle: "Screenshot", loadDisplayImage: load });
    container.append(modal);
    await modal.updateComplete;
    const image = modal.querySelector<HTMLImageElement>("img")!;
    image.dispatchEvent(new Event("load"));
    image.dispatchEvent(new CustomEvent("panzoomchange", { detail: { scale: 2 } }));
    await waitForSolid(() =>
      expect(modal.querySelector(".image-quality-status button")?.textContent).toBe("Retry"),
    );
    expect(image.src).toBe("blob:preview");
    expect(modal.querySelector(".zoom-level")?.textContent).toBe("200%");
    modal.querySelector<HTMLButtonElement>(".image-quality-status button")!.click();
    await waitForSolid(() => expect(image.src).toBe("blob:display"));
    expect(modal.querySelector("img")).toBe(image);
    expect(modal.querySelector(".image-quality-status")).toBeNull();
    expect(modal.querySelector(".zoom-level")?.textContent).toBe("200%");
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it("gates zoom readiness and keeps Tab focus within the actions", async () => {
    const { modal, dialogAdapter } = await renderLightbox();
    const root = modal;
    const image = root?.querySelector<HTMLImageElement>(".image");
    const zoomIn = root?.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]');
    expect(zoomIn?.getAttribute("aria-disabled")).toBe("true");
    const unavailableShortcut = new KeyboardEvent("keydown", {
      key: "+",
      bubbles: true,
      cancelable: true,
    });
    dialogAdapter.dispatchEvent(unavailableShortcut);
    expect(unavailableShortcut.defaultPrevented).toBe(false);

    image?.dispatchEvent(new Event("error"));
    await modal.updateComplete;
    expect(zoomIn?.getAttribute("aria-disabled")).toBe("true");

    image?.dispatchEvent(new Event("load"));
    flush();
    expect(zoomIn?.getAttribute("aria-disabled")).toBe("false");
    const availableShortcut = new KeyboardEvent("keydown", {
      key: "+",
      bubbles: true,
      cancelable: true,
    });
    dialogAdapter.dispatchEvent(availableShortcut);
    expect(availableShortcut.defaultPrevented).toBe(true);

    const openOriginal = root.querySelector<HTMLButtonElement>(".download-image")!;
    const close = root.querySelector<HTMLButtonElement>(".close")!;
    openOriginal?.focus();

    openOriginal?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(close);

    close.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
    );
    expect(document.activeElement).toBe(openOriginal);
  });

  it("captures gallery shortcuts before descendants and releases them on removal", async () => {
    vi.stubGlobal(
      "Image",
      class {
        src = "";
        decode = async () => {};
      },
    );
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
    const press = (key: string, modifiers: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...modifiers,
      });
      image.dispatchEvent(event);
      return event;
    };

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
      await new Promise<void>((resolve) => {
        const observer = new MutationObserver(() => {
          if (image.src === source) {
            observer.disconnect();
            resolve();
          }
        });
        observer.observe(image, { attributes: true, attributeFilter: ["src"] });
        expect(press(key).defaultPrevented).toBe(true);
      });
      expect(image.src).toBe(source);
    }

    modal.remove();
    await Promise.resolve();
    const retiredShortcut = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    dialogAdapter.dispatchEvent(retiredShortcut);
    expect(retiredShortcut.defaultPrevented).toBe(false);
  });

  it("emits one close event for the close button and modal cancellation", async () => {
    const { modal, dialogAdapter } = await renderLightbox();
    let closes = 0;
    modal.addEventListener("image-lightbox-close", () => {
      closes += 1;
    });

    modal.querySelector<HTMLButtonElement>("button")?.click();
    expect(closes).toBe(1);

    dialogAdapter.dispatchEvent(new CustomEvent("modal-cancel", { bubbles: true }));
    expect(closes).toBe(2);
  });

  it.each(["document", "shadow"] as const)(
    "dismisses only a pointer gesture that starts and ends on the backdrop in a %s root",
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
      let closes = 0;
      modal.addEventListener("image-lightbox-close", () => {
        closes += 1;
      });

      const pointer = (
        target: Element | null | undefined,
        type: string,
        pointerId: number,
        xy = 0,
      ) =>
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
      expect(closes).toBe(0);

      pointer(stage, "pointerdown", 2, 10);
      pointer(stage, "pointerup", 2, 30);
      expect(closes).toBe(0);

      pointer(slide, "pointerdown", 3, 10);
      pointer(stage, "pointerup", 3, 10);
      expect(closes).toBe(1);
    },
  );
});
