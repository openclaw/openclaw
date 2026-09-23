/* @vitest-environment jsdom */

import Panzoom from "@panzoom/panzoom";
import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { renderChatImageLightbox } from "../pages/chat/components/chat-image-lightbox.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
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

async function renderLightbox() {
  render(
    html`<openclaw-image-lightbox
      src="data:image/png;base64,cG5n"
      .imageTitle=${"Generated lobster"}
    ></openclaw-image-lightbox>`,
    container,
  );
  const modal = container.querySelector("openclaw-image-lightbox");
  if (!modal) {
    throw new Error("missing image lightbox");
  }
  await modal.updateComplete;
  const dialogAdapter = modal.shadowRoot?.querySelector("openclaw-modal-dialog");
  if (!dialogAdapter) {
    throw new Error("missing modal dialog adapter");
  }
  await getRenderedModalDialog((modal.shadowRoot ?? modal) as unknown as HTMLElement);
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

  afterEach(() => {
    render(nothing, container);
    container.remove();
    restoreDialogPolyfill();
    vi.unstubAllGlobals();
  });

  it("renders a labelled large image with original and close actions", async () => {
    const { modal } = await renderLightbox();
    const root = modal.shadowRoot;

    expect(root?.querySelector<HTMLImageElement>("img")?.alt).toBe("Generated lobster");
    expect(root?.querySelector<HTMLImageElement>("img")?.src).toBe("data:image/png;base64,cG5n");
    expect(modal.hasAttribute("title")).toBe(false);
    await vi.waitFor(() =>
      expect(root?.querySelector<HTMLAnchorElement>("a")?.href).toBe("blob:lightbox-original"),
    );
    expect(fetchImage).toHaveBeenCalledTimes(1);
    expect(root?.querySelector<HTMLButtonElement>(".close")?.hasAttribute("autofocus")).toBe(true);

    modal.imageTitle = "Renamed image";
    await modal.updateComplete;
    expect(root?.querySelector<HTMLImageElement>("img")?.alt).toBe("Renamed image");
    expect(root?.querySelector("openclaw-modal-dialog")?.label).toBe(
      "Image preview: Renamed image",
    );
  });

  it("renders video in the shared overlay without image zoom controls", async () => {
    render(
      html`<openclaw-image-lightbox
        mediaKind="video"
        src="https://example.com/demo.mp4?playback=1"
        originalSrc="https://example.com/demo.mp4"
        .imageTitle=${"Demo clip"}
      ></openclaw-image-lightbox>`,
      container,
    );
    const modal = container.querySelector("openclaw-image-lightbox");
    if (!modal) {
      throw new Error("missing media lightbox");
    }
    await modal.updateComplete;

    const video = modal.shadowRoot?.querySelector<HTMLVideoElement>("video");
    expect(video?.src).toBe("https://example.com/demo.mp4?playback=1");
    expect(video?.controls).toBe(true);
    expect(video?.autoplay).toBe(true);
    expect(modal.shadowRoot?.querySelector("img, .zoom-controls")).toBeNull();
    expect(
      modal.shadowRoot?.querySelector<HTMLButtonElement>(".close")?.getAttribute("aria-label"),
    ).toBe("Close video preview");
    await vi.waitFor(() =>
      expect(modal.shadowRoot?.querySelector<HTMLAnchorElement>(".open-original")?.href).toBe(
        "https://example.com/demo.mp4",
      ),
    );
    const openOriginal = modal.shadowRoot?.querySelector<HTMLAnchorElement>(".open-original");
    video?.focus();
    video?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, composed: true }),
    );
    expect(modal.shadowRoot?.activeElement).toBe(openOriginal);
    openOriginal?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, composed: true }),
    );
    expect(modal.shadowRoot?.activeElement).toBe(video);

    modal.imageTitle = "Renamed video";
    await modal.updateComplete;
    expect(video?.getAttribute("aria-label")).toBe("Renamed video");
    expect(modal.shadowRoot?.querySelector("openclaw-modal-dialog")?.label).toBe(
      "Video preview: Renamed video",
    );
  });

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
    render(
      renderChatImageLightbox(
        {
          src: "blob:preview",
          title: "Screenshot",
          loadFullResolution: () => full.promise,
        },
        () => render(nothing, container),
      ),
      container,
    );
    const modal = container.querySelector("openclaw-image-lightbox")!;
    await modal.updateComplete;
    const image = modal.shadowRoot!.querySelector<HTMLImageElement>("img")!;
    expect(image.src).toBe("blob:preview");
    expect(modal.shadowRoot!.querySelector(".open-original")).toBeNull();
    image.dispatchEvent(new Event("load"));
    image.dispatchEvent(new CustomEvent("panzoomchange", { detail: { scale: 2 } }));
    await modal.updateComplete;

    full.resolve(original);
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
    expect(image.src).toBe("blob:preview");
    decoded.resolve();
    await vi.waitFor(() => expect(image.src).toBe("blob:original"));
    image.dispatchEvent(new Event("load"));
    await modal.updateComplete;
    expect(modal.shadowRoot!.querySelector(".zoom-level")?.textContent?.trim()).toBe("200%");
    await vi.waitFor(() =>
      expect(modal.shadowRoot!.querySelector<HTMLAnchorElement>(".open-original")?.href).toBe(
        "blob:original",
      ),
    );
    modal.shadowRoot!.querySelector<HTMLButtonElement>(".close")!.click();
    await vi.waitFor(() => expect(original.release).toHaveBeenCalledOnce());
    expect(container.querySelector("openclaw-image-lightbox")).toBeNull();
  });

  it("does not preload a gallery from an update queued before detachment", async () => {
    const { modal } = await renderLightbox();
    const neighbor = vi.fn(async () => null);
    modal.gallery = { index: 0, items: [async () => null, neighbor] };
    modal.remove();

    await modal.updateComplete;
    await Promise.resolve();

    expect(neighbor).not.toHaveBeenCalled();
  });

  it("ignores an image load that finishes after the viewer closes", async () => {
    const { modal } = await renderLightbox();
    const image = modal.shadowRoot!.querySelector<HTMLImageElement>("img")!;
    modal.remove();
    vi.mocked(Panzoom).mockClear();

    image.dispatchEvent(new Event("load"));

    expect(Panzoom).not.toHaveBeenCalled();
  });

  it("accepts parameters on safe raster MIME types", async () => {
    fetchImage.mockResolvedValueOnce({
      blob: async () => new Blob(["png"], { type: "image/png;charset=utf-8" }),
    });
    render(
      html`<openclaw-image-lightbox
        src="data:image/png;charset=utf-8;base64,cG5n"
        .imageTitle=${"Generated lobster"}
      ></openclaw-image-lightbox>`,
      container,
    );
    const modal = container.querySelector("openclaw-image-lightbox");
    if (!modal) {
      throw new Error("missing image lightbox");
    }
    await modal.updateComplete;

    await vi.waitFor(() =>
      expect(modal.shadowRoot?.querySelector<HTMLAnchorElement>(".open-original")?.href).toBe(
        "blob:lightbox-original",
      ),
    );
  });

  it("releases and recreates the original-image URL across reconnection", async () => {
    const { modal } = await renderLightbox();
    await vi.waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(1));

    modal.remove();

    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:lightbox-original");

    container.append(modal);
    await vi.waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(2));
  });

  it("omits the original action for active data image formats", async () => {
    render(
      html`<openclaw-image-lightbox
        src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'></svg>"
        .imageTitle=${"Untrusted SVG"}
      ></openclaw-image-lightbox>`,
      container,
    );
    const modal = container.querySelector("openclaw-image-lightbox");
    if (!modal) {
      throw new Error("missing image lightbox");
    }
    await modal.updateComplete;

    expect(modal.shadowRoot?.querySelector(".open-original")).toBeNull();
    expect(fetchImage).not.toHaveBeenCalled();
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it("omits the original action for active blob image formats", async () => {
    fetchImage.mockResolvedValueOnce({
      blob: async () => new Blob(["svg"], { type: "image/svg+xml" }),
    });
    render(
      html`<openclaw-image-lightbox
        src="blob:untrusted-svg"
        .imageTitle=${"Untrusted SVG"}
      ></openclaw-image-lightbox>`,
      container,
    );
    const modal = container.querySelector("openclaw-image-lightbox");
    if (!modal) {
      throw new Error("missing image lightbox");
    }
    await modal.updateComplete;

    await vi.waitFor(() => expect(fetchImage).toHaveBeenCalledWith("blob:untrusted-svg"));
    expect(modal.shadowRoot?.querySelector(".open-original")).toBeNull();
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it("keeps the original action for inert blob image formats", async () => {
    render(
      html`<openclaw-image-lightbox
        src="blob:safe-png"
        .imageTitle=${"Safe PNG"}
      ></openclaw-image-lightbox>`,
      container,
    );
    const modal = container.querySelector("openclaw-image-lightbox");
    if (!modal) {
      throw new Error("missing image lightbox");
    }
    await modal.updateComplete;

    await vi.waitFor(() =>
      expect(modal.shadowRoot?.querySelector<HTMLAnchorElement>(".open-original")?.href).toBe(
        "blob:safe-png",
      ),
    );
    expect(fetchImage).toHaveBeenCalledWith("blob:safe-png");
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it("gates zoom readiness and keeps Tab focus within the actions", async () => {
    const { modal, dialogAdapter } = await renderLightbox();
    const root = modal.shadowRoot;
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
    await modal.updateComplete;
    expect(zoomIn?.getAttribute("aria-disabled")).toBe("false");
    const availableShortcut = new KeyboardEvent("keydown", {
      key: "+",
      bubbles: true,
      cancelable: true,
    });
    dialogAdapter.dispatchEvent(availableShortcut);
    expect(availableShortcut.defaultPrevented).toBe(true);

    await vi.waitFor(() =>
      expect(root?.querySelector<HTMLAnchorElement>(".open-original")).toBeTruthy(),
    );
    const openOriginal = root?.querySelector<HTMLAnchorElement>(".open-original");
    zoomIn?.focus();

    zoomIn?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(root?.activeElement).toBe(openOriginal);

    openOriginal?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
    );
    expect(root?.activeElement).toBe(zoomIn);
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
    const image = modal.shadowRoot!.querySelector<HTMLImageElement>(".image")!;
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

    modal.shadowRoot?.querySelector<HTMLButtonElement>("button")?.click();
    expect(closes).toBe(1);

    dialogAdapter.dispatchEvent(new CustomEvent("modal-cancel", { bubbles: true }));
    expect(closes).toBe(2);
  });

  it("dismisses only a pointer gesture that starts and ends on the backdrop", async () => {
    const { modal } = await renderLightbox();
    const stage = modal.shadowRoot?.querySelector<HTMLElement>(".stage");
    const image = modal.shadowRoot?.querySelector<HTMLImageElement>(".image");
    Object.defineProperty(modal.shadowRoot!, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => stage ?? null),
    });
    let closes = 0;
    modal.addEventListener("image-lightbox-close", () => {
      closes += 1;
    });

    image?.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true, pointerId: 1 }),
    );
    stage?.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, button: 0, isPrimary: true, pointerId: 1 }),
    );
    expect(closes).toBe(0);

    stage?.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 10,
        clientY: 10,
        isPrimary: true,
        pointerId: 2,
      }),
    );
    stage?.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        clientX: 30,
        clientY: 30,
        isPrimary: true,
        pointerId: 2,
      }),
    );
    expect(closes).toBe(0);

    stage?.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 10,
        clientY: 10,
        isPrimary: true,
        pointerId: 3,
      }),
    );
    stage?.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        clientX: 10,
        clientY: 10,
        isPrimary: true,
        pointerId: 3,
      }),
    );
    expect(closes).toBe(1);
  });
});
