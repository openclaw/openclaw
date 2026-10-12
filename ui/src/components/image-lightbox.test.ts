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

import "./image-lightbox.ts";

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
  const dialogAdapter = modal.querySelector("openclaw-modal-dialog");
  if (!dialogAdapter) {
    throw new Error("missing modal dialog adapter");
  }
  await getRenderedModalDialog(modal);
  return { modal, dialogAdapter };
}

describe("openclaw-image-lightbox", () => {
  beforeEach(() => {
    restoreDialogPolyfill = installDialogPolyfill();
    createObjectUrl = vi.fn(() => "blob:lightbox-original");
    revokeObjectUrl = vi.fn();
    fetchImage = vi.fn(async () => ({
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
    "renders a labelled %s with original and close actions",
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
      await waitForSolid(() =>
        expect(root.querySelector<HTMLAnchorElement>(".open-original")?.href).toBe(
          originalSrc || "blob:lightbox-original",
        ),
      );
      if (isVideo) {
        const video = root.querySelector<HTMLVideoElement>("video")!;
        expect(video.controls).toBe(true);
        expect(video.autoplay).toBe(true);
        expect(root.querySelector("img, .zoom-controls")).toBeNull();
        expect(root.querySelector(".close")?.getAttribute("aria-label")).toBe(
          "Close video preview",
        );
        const openOriginal = root.querySelector<HTMLAnchorElement>(".open-original");
        video.focus();
        video.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Tab", bubbles: true, composed: true }),
        );
        expect(document.activeElement).toBe(openOriginal);
        openOriginal?.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Tab",
            shiftKey: true,
            bubbles: true,
            composed: true,
          }),
        );
        expect(document.activeElement).toBe(video);
      } else {
        expect(media.getAttribute("alt")).toBe("Generated lobster");
        expect(modal.hasAttribute("title")).toBe(false);
        expect(fetchImage).toHaveBeenCalledTimes(1);
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

  it("keeps the preview and zoom until a decoded original replaces it in the open viewer", async () => {
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
    modal.loadFullResolution = () => full.promise;
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
    await waitForSolid(() =>
      expect(modal.querySelector<HTMLAnchorElement>(".open-original")?.href).toBe("blob:original"),
    );
    modal.querySelector<HTMLButtonElement>(".close")!.click();
    await waitForSolid(() => expect(original.release).toHaveBeenCalledOnce());
    expect(container.querySelector("openclaw-image-lightbox")).toBeNull();
  });

  it("retires queued image work and original URLs on detachment, then reconnects", async () => {
    const { modal } = await renderLightbox();
    const image = modal.querySelector<HTMLImageElement>("img")!;
    await waitForSolid(() => expect(createObjectUrl).toHaveBeenCalledTimes(1));
    const neighbor = vi.fn(async () => null);
    modal.gallery = { index: 0, items: [async () => null, neighbor] };
    modal.remove();
    await modal.updateComplete;
    await Promise.resolve();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:lightbox-original");
    expect(neighbor).not.toHaveBeenCalled();
    vi.mocked(Panzoom).mockClear();
    image.dispatchEvent(new Event("load"));
    expect(Panzoom).not.toHaveBeenCalled();

    container.append(modal);
    await waitForSolid(() => expect(createObjectUrl).toHaveBeenCalledTimes(2));
  });

  it.each([
    [
      "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'></svg>",
      "image/svg+xml",
      false,
      false,
    ],
    ["blob:untrusted-svg", "image/svg+xml", true, false],
    ["blob:safe-png", "image/png", true, true],
  ] as const)(
    "admits only inert original-image actions for %s",
    async (src, type, fetched, allowed) => {
      fetchImage.mockResolvedValueOnce({ blob: async () => new Blob(["image"], { type }) });
      const { modal } = await renderLightbox({ src });
      if (fetched) {
        await waitForSolid(() => expect(fetchImage).toHaveBeenCalledWith(src));
      } else {
        expect(fetchImage).not.toHaveBeenCalled();
      }
      if (allowed) {
        await waitForSolid(() =>
          expect(modal.querySelector<HTMLAnchorElement>(".open-original")?.href).toBe(src),
        );
      } else {
        expect(modal.querySelector(".open-original")).toBeNull();
      }
      expect(createObjectUrl).not.toHaveBeenCalled();
    },
  );

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

    await waitForSolid(() =>
      expect(root?.querySelector<HTMLAnchorElement>(".open-original")).toBeTruthy(),
    );
    const openOriginal = root?.querySelector<HTMLAnchorElement>(".open-original");
    zoomIn?.focus();

    zoomIn?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(openOriginal);

    openOriginal?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
    );
    expect(document.activeElement).toBe(zoomIn);
  });

  it("pans zoomed images with Shift+arrows while plain arrows still navigate the gallery", async () => {
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
    const press = (key: string, modifiers: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...modifiers,
      });
      dialogAdapter.dispatchEvent(event);
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

      pointer(stage, "pointerdown", 3, 10);
      pointer(stage, "pointerup", 3, 10);
      expect(closes).toBe(1);
    },
  );
});
