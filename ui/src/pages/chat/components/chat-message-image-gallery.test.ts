/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { createImageLightboxGallery } from "../../../components/image-lightbox-gallery.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import { cleanupSolid } from "../../../test-helpers/mount-solid.ts";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { MessageGroup } from "./chat-message-group-view.tsx";
import { readImageOriginalBlob } from "./chat-message-image-open.ts";
import { MessageImages, type MessageImagesProps } from "./chat-message-images-solid.tsx";
import {
  imageResponse,
  managedSource,
  stubObjectUrls,
  ticketResponse,
} from "./chat-message-media.test-helpers.ts";
import {
  releaseChatMediaResourceOwner,
  type ImageBlock,
  type ImageRenderOptions,
} from "./chat-message-media.ts";
import {
  createAssistantMessage,
  createAttachmentBlock,
  createMessageGroup,
  createUserMessage,
} from "./chat-message.test-support.ts";

let container: HTMLDivElement;
let onMediaChange: () => void;
let imageView: ReturnType<typeof mountSolid<MessageImagesProps>> | undefined;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  onMediaChange = vi.fn();
  vi.stubGlobal("devicePixelRatio", 1);
  vi.stubGlobal("innerWidth", 390);
  vi.stubGlobal("innerHeight", 844);
  imageView = undefined;
});

afterEach(() => {
  cleanupSolid();
  releaseChatMediaResourceOwner(onMediaChange);
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderImages(images: ImageBlock[], options: ImageRenderOptions) {
  const props = { images, options };
  if (imageView) {
    imageView.update(props);
  } else {
    imageView = mountSolid(MessageImages, props, container);
  }
}

function stubImageDecoding(blobPrefix: string, decode: () => Promise<void>) {
  let blobIndex = 0;
  stubObjectUrls(() => `${blobPrefix}-${blobIndex++}`);
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      decode = decode;
    },
  );
}

async function whenImageAppears(draw: () => void) {
  const ready = createDeferred();
  const observer = new MutationObserver(() => {
    if (container.querySelector(".chat-message-image")) {
      ready.resolve();
    }
  });
  observer.observe(container, { childList: true, subtree: true });
  try {
    draw();
    await ready.promise;
  } finally {
    observer.disconnect();
  }
}

function createGallery() {
  let controller: ReturnType<typeof createImageLightboxGallery>;
  let close = () => {};
  let opened: ImageLightboxItem | undefined;
  return {
    get controller() {
      return controller;
    },
    close: () => close(),
    onOpenImage: vi.fn((item: ImageLightboxItem) => {
      opened?.release?.();
      opened = item;
      close();
      controller = createRoot((dispose) => {
        close = dispose;
        return createImageLightboxGallery();
      });
      controller.reset(item.gallery, item);
    }),
    dispose: () => {
      close();
      opened?.release?.();
    },
  };
}

describe("message image gallery loading", () => {
  it.each([false, true])("reads full original bytes for managed=%s images", async (managed) => {
    const source = managed ? managedSource() : "https://images.example.test/original.png";
    stubObjectUrls();
    const fetchImage = vi.fn(async () => imageResponse());
    vi.stubGlobal("fetch", fetchImage);

    const blob = await readImageOriginalBlob(
      { url: source, mimeType: "image/png" },
      { mediaOwner: onMediaChange },
    );

    expect(blob.type).toBe("image/png");
    expect(await blob.text()).toBe("png");
    expect(fetchImage).toHaveBeenCalledOnce();
    expect(fetchImage.mock.calls[0]).toEqual([
      source,
      expect.objectContaining(
        managed
          ? { method: "GET", credentials: "same-origin", signal: expect.any(AbortSignal) }
          : { credentials: "same-origin", referrerPolicy: "no-referrer" },
      ),
    ]);
  });

  it("rejects an unsuccessful original image download", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    await expect(
      readImageOriginalBlob({ url: "https://images.example.test/unavailable.png" }),
    ).rejects.toThrow("Image download failed");
  });

  it("renders canonical inbound transcript images through the authenticated media route", async () => {
    const source = `media://inbound/${crypto.randomUUID()}.png`;
    const filename = "café 雪 🦞.png";
    const opened = createDeferred();
    const onOpenImage = vi.fn(() => opened.resolve());
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const mediaUrl = new URL(url, "http://control.test");
      expect(mediaUrl.searchParams.get("source")).toBe(source);
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-auth-token");
      return ticketResponse("ticket-inbound");
    });
    vi.stubGlobal("fetch", fetchMock);
    const message = createUserMessage("", {
      id: "user-inbound-media-ref",
      __openclaw: { media: [{ path: source, contentType: "image/png", fileName: filename }] },
    });
    await whenImageAppears(() =>
      renderMessage(message, "user", {
        showReasoning: true,
        resourceBasePath: "/openclaw",
        assistantAttachmentAuthToken: "test-auth-token",
        mediaOwner: onMediaChange,
        onOpenImage,
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const expectedSrc = `/openclaw/__openclaw__/assistant-media?source=${encodeURIComponent(source)}&mediaTicket=ticket-inbound&${new URLSearchParams({ filename })}`;
    expect(
      container.querySelector<HTMLImageElement>(".chat-message-image")?.getAttribute("src"),
    ).toBe(`${expectedSrc}&variant=thumbnail&width=480&v=4`);
    expect(container.querySelector(".chat-message-image")?.getAttribute("srcset")).toBe(
      `${expectedSrc}&variant=thumbnail&width=480&v=4 1x, ${expectedSrc}&variant=thumbnail&width=960&v=4 2x`,
    );
    const tile = container.querySelector<HTMLButtonElement>(".chat-message-image-button");
    expect(tile).not.toBeNull();
    expect(tile?.getAttribute("aria-label")).toBe(`Open image ${filename}`);
    expect(container.querySelector(".chat-message-image")?.getAttribute("alt")).toBe(filename);
    tile!.click();
    await opened.promise;
    expect(onOpenImage).toHaveBeenCalledWith(
      expect.objectContaining({
        src: new URL(`${expectedSrc}&variant=thumbnail&width=480&v=4`, window.location.href).href,
        title: filename,
      }),
    );
  });

  it.each(["png", "gif"] as const)(
    "keeps legacy local %s images on one native source without an upgrade",
    async (extension) => {
      const source = "/workspace/legacy-" + crypto.randomUUID() + "." + extension;
      const fetchMetadata = vi.fn(async () => ticketResponse("legacy-ticket"));
      vi.stubGlobal("fetch", fetchMetadata);
      const onOpenImage = vi.fn<(item: ImageLightboxItem) => void>();
      await whenImageAppears(() =>
        renderImages([{ url: source, mimeType: "image/" + extension }], {
          onOpenImage,
          mediaOwner: onMediaChange,
        }),
      );
      const image = container.querySelector<HTMLImageElement>("img")!;
      const url = new URL(image.src);
      expect(url.searchParams.get("source")).toBe(source);
      expect(url.searchParams.has("variant")).toBe(false);
      expect(url.searchParams.has("width")).toBe(false);
      expect(image.getAttribute("srcset")).toBeNull();
      container.querySelector<HTMLButtonElement>(".chat-message-image-button")!.click();
      expect(onOpenImage).toHaveBeenCalledOnce();
      expect(onOpenImage.mock.calls[0]![0].loadDisplayImage).toBeUndefined();
      expect(fetchMetadata).toHaveBeenCalledOnce();
    },
  );

  it.each(["navigation", "tile"] as const)(
    "does not prefetch neighbors and retries a failed selected rendition via %s",
    async (action) => {
      vi.useFakeTimers();
      const source = managedSource();
      const blobPrefix = `blob:gallery-${crypto.randomUUID()}`;
      stubImageDecoding(blobPrefix, async () => {});
      const fetchDisplay = vi.fn(async () => new Response(null, { status: 503 }));
      const fetch = vi.fn(async (url: string) =>
        url.includes("width=960") ? fetchDisplay() : imageResponse(),
      );
      vi.stubGlobal("fetch", fetch);
      const gallery = createGallery();
      const { onOpenImage, dispose } = gallery;
      try {
        renderImages(
          [
            { url: "data:image/png;base64,cG5n", alt: "First image" },
            { url: source, alt: "Managed neighbor", fileName: "neighbor.png" },
          ],
          { onOpenImage, mediaOwner: onMediaChange },
        );
        await vi.advanceTimersByTimeAsync(0);
        const tiles = container.querySelectorAll<HTMLButtonElement>(".chat-message-image-button");
        tiles[0]!.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchDisplay).not.toHaveBeenCalled();
        expect(fetch.mock.calls.map(([url]) => url)).toEqual([
          source.replace(/\/full$/u, "/thumbnail?v=4&width=480"),
        ]);
        expect(await gallery.controller.move(1)).toBe(false);
        expect(fetchDisplay).toHaveBeenCalledOnce();
        expect(gallery.controller.peek().current?.title).toBe("First image");
        expect(gallery.controller.peek().failed).toBe(true);
        fetchDisplay.mockImplementation(async () => imageResponse());
        if (action === "navigation") {
          expect(await gallery.controller.move(1)).toBe(true);
        } else {
          tiles[1]!.click();
          await vi.advanceTimersByTimeAsync(0);
          expect(onOpenImage).toHaveBeenCalledTimes(2);
        }
        expect(fetchDisplay).toHaveBeenCalledTimes(2);
        expect(gallery.controller.peek().index).toBe(1);
        expect(gallery.controller.peek().current?.title).toBe("Managed neighbor");
        expect(gallery.controller.peek().current?.src).toBe(`${blobPrefix}-1`);
        expect(gallery.controller.peek().failed).toBe(false);
        expect(fetch.mock.calls.every(([url]) => url.includes("/thumbnail?v=4&width="))).toBe(true);
      } finally {
        dispose();
      }
    },
  );

  it.each([false, true])(
    "waits for local-image metadata and discards it after owner removal=%s",
    async (removeOwner) => {
      const metadata = createDeferred<Response>();
      const fetchMetadata = vi.fn(() => metadata.promise);
      vi.stubGlobal("fetch", fetchMetadata);
      const localSource = `/home/node/.openclaw/media/outbound/${crypto.randomUUID()}.png`;
      const onOpenImage = vi.fn<(item: ImageLightboxItem) => void>();
      renderImages(
        [
          { url: "data:image/png;base64,cG5n", alt: "First image" },
          { url: localSource, fileName: "Local neighbor.png" },
        ],
        {
          onOpenImage,
          mediaOwner: onMediaChange,
          sessionKey: "main",
          resourceBasePath: "/openclaw",
        },
      );
      container.querySelector<HTMLButtonElement>(".chat-message-image-button")!.click();
      const opened = onOpenImage.mock.calls[0]?.[0];
      expect(opened?.gallery?.index).toBe(0);
      const loadNeighbor = opened?.gallery?.items[1];
      if (!loadNeighbor) {
        throw new Error("Opening the first tile did not expose its message gallery");
      }
      const settled = vi.fn();
      const neighbor = loadNeighbor().then((item) => {
        settled(item);
        return item;
      });
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      expect(fetchMetadata).toHaveBeenCalledOnce();

      if (removeOwner) {
        imageView?.dispose();
        releaseChatMediaResourceOwner(onMediaChange);
      }
      metadata.resolve(ticketResponse("gallery-neighbor-ticket"));
      const result = await neighbor;
      if (removeOwner) {
        expect(result).toBeNull();
      } else {
        expect(result?.title).toBe("Local neighbor.png");
        const url = new URL(result!.src, window.location.href);
        expect(url.pathname).toBe("/openclaw/__openclaw__/assistant-media");
        expect(url.searchParams.get("source")).toBe(localSource);
        expect(url.searchParams.get("mediaTicket")).toBe("gallery-neighbor-ticket");
        expect(url.searchParams.get("sessionKey")).toBe("main");
      }
    },
  );
});

function renderMessage(
  message: unknown,
  role: "user" | "assistant",
  options: Partial<Parameters<typeof MessageGroup>[0]["options"]>,
) {
  mountSolid(
    MessageGroup,
    {
      group: createMessageGroup(message, role),
      options: {
        showReasoning: false,
        showToolCalls: false,
        assistantName: "OpenClaw",
        assistantAvatar: null,
        ...options,
      },
    },
    container,
  );
}

describe("message attachment image gallery projection", () => {
  it.each(
    [
      {
        format: "MEDIA directives",
        content:
          "Introduction\n\n**Before**\nMEDIA:https://example.com/before.png\n\n**After**\nMEDIA:https://example.com/after.png\n\nClosing paragraph",
      },
      {
        format: "mixed image blocks and document-shaped images",
        content: [
          { type: "text", text: "Introduction\n\n**Before**" },
          { type: "image", url: "https://example.com/before.png" },
          { type: "text", text: "**After**" },
          createAttachmentBlock(
            "https://example.com/after.png",
            "document",
            "after.png",
            "application/octet-stream; charset=binary",
          ),
          { type: "text", text: "Closing paragraph" },
        ],
      },
    ].flatMap((fixture) =>
      [false, true].map((cachedDimensions) => ({ ...fixture, cachedDimensions })),
    ),
  )(
    "keeps assistant $format in one gallery with cached dimensions=$cachedDimensions",
    async ({ content, cachedDimensions }) => {
      const onOpenImage = vi.fn<(item: ImageLightboxItem) => void>();
      const images = Object.fromEntries(
        ["before", "after"].map((name) => [
          JSON.stringify([null, `https://example.com/${name}.png`, 480]),
          { width: 480, height: 240, rendition: 480 as const },
        ]),
      );
      renderMessage(
        createAssistantMessage(content, {
          timestamp: 1000,
          __openclaw: { id: "cached-gallery" },
        }),
        "assistant",
        {
          onOpenImage,
          displayFacts: cachedDimensions
            ? {
                forRow: (id) =>
                  id === "cached-gallery"
                    ? { read: () => ({ images }), write: vi.fn() }
                    : undefined,
              }
            : undefined,
        },
      );

      await waitForSolid(() =>
        expect(
          Array.from(
            container.querySelectorAll(".chat-text strong, .chat-message-image"),
            (element) =>
              element instanceof HTMLImageElement
                ? new URL(element.src).pathname
                : element.textContent?.replace(/\s+/g, " ").trim(),
          ),
        ).toEqual(["Before", "/before.png", "After", "/after.png"]),
      );
      const text = container.querySelector(".chat-text")?.textContent?.trim() ?? "";
      expect(text.startsWith("Introduction")).toBe(true);
      expect(text.endsWith("Closing paragraph")).toBe(true);
      const tiles = container.querySelectorAll<HTMLButtonElement>(".chat-message-image-button");
      for (const [index, tile] of tiles.entries()) {
        tile.click();
        const opened = onOpenImage.mock.calls.at(-1)?.[0];
        expect(opened?.gallery?.index).toBe(index);
        expect(opened?.gallery?.items).toHaveLength(2);
        const gallery = expectDefined(opened?.gallery, "message image gallery");
        const neighbors = await Promise.all(gallery.items.map((load) => load()));
        expect(neighbors.map((image) => image?.src)).toEqual([
          "https://example.com/before.png",
          "https://example.com/after.png",
        ]);
        neighbors.forEach((image) => image?.release?.());
      }
    },
  );

  const source = "https://example.com/repeated.png";
  it.each([
    {
      name: "duplicate attachment slots without persisted mirrors",
      message: createAssistantMessage(
        [
          createAttachmentBlock(source, "document", "Repeated", "image/png"),
          createAttachmentBlock(source, "document", "Repeated", "image/png"),
        ],
        { __openclaw: { media: [{ path: source, contentType: "image/png" }] } },
      ),
      index: 1,
    },
    {
      name: "persisted images with opaque download filenames",
      message: createAssistantMessage("", {
        __openclaw: {
          media: [
            {
              path: "https://example.com/download/first",
              fileName: "first.png",
              contentType: "application/octet-stream; charset=binary",
            },
            {
              path: "https://example.com/download/second",
              fileName: "second.avif",
              contentType: "application/octet-stream",
            },
          ],
        },
      }),
      index: 0,
    },
  ])("projects $name into the gallery", async ({ message, index }) => {
    const onOpenImage = vi.fn<(item: ImageLightboxItem) => void>();
    renderMessage(message, "assistant", { onOpenImage });
    await waitForSolid(() =>
      expect(container.querySelectorAll(".chat-message-image-button")).toHaveLength(2),
    );
    await waitForSolid(() =>
      expect(container.querySelectorAll(".chat-message-image")).toHaveLength(2),
    );
    const tiles = container.querySelectorAll<HTMLButtonElement>(".chat-message-image-button");
    tiles[index]?.click();
    expect(onOpenImage.mock.calls[0]?.[0].gallery).toMatchObject({
      index,
      items: [expect.any(Function), expect.any(Function)],
    });
  });
});
