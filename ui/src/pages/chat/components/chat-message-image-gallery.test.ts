/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { ImageLightboxGalleryController } from "../../../components/image-lightbox-gallery.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import { cleanupSolid } from "../../../test-helpers/mount-solid.ts";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { MessageGroup } from "./chat-message-group-view.tsx";
import { MessageImages, type MessageImagesProps } from "./chat-message-images-solid.tsx";
import {
  releaseChatMediaResourceSubscriber,
  type ImageBlock,
  type ImageRenderOptions,
} from "./chat-message-media.ts";
import { createMessageGroup, createUserMessage } from "./chat-message.test-support.ts";

let container: HTMLDivElement;
let onRequestUpdate: () => void;
let imageView: ReturnType<typeof mountSolid<MessageImagesProps>> | undefined;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  onRequestUpdate = vi.fn();
  vi.stubGlobal("devicePixelRatio", 1);
  vi.stubGlobal("innerWidth", 390);
  vi.stubGlobal("innerHeight", 844);
  imageView = undefined;
});

afterEach(() => {
  cleanupSolid();
  releaseChatMediaResourceSubscriber(onRequestUpdate);
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
  const NativeUrl = URL;
  vi.stubGlobal(
    "URL",
    class extends NativeUrl {
      static override createObjectURL = () => `${blobPrefix}-${blobIndex++}`;
      static override revokeObjectURL = vi.fn();
    },
  );
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      decode = decode;
    },
  );
}

function imageResponse() {
  return new Response("png", { headers: { "Content-Type": "image/png" } });
}

function createGallery() {
  const controller = new ImageLightboxGalleryController(vi.fn());
  let opened: ImageLightboxItem | undefined;
  return {
    controller,
    onOpenImage: vi.fn((item: ImageLightboxItem) => {
      opened?.release?.();
      opened = item;
      controller.reset(item.gallery, item);
    }),
    dispose: () => {
      controller.dispose();
      opened?.release?.();
    },
  };
}

describe("message image gallery loading", () => {
  it("renders canonical inbound transcript images through the authenticated media route", async () => {
    const source = `media://inbound/${crypto.randomUUID()}.png`;
    const filename = "café 雪 🦞.png";
    const available = createDeferred();
    const opened = createDeferred();
    const onOpenImage = vi.fn(() => opened.resolve());
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const mediaUrl = new URL(url, "http://control.test");
      expect(mediaUrl.searchParams.get("source")).toBe(source);
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-auth-token");
      return new Response(
        JSON.stringify({
          available: true,
          mediaTicket: "ticket-inbound",
          mediaTicketExpiresAt: new Date(Date.now() + 300_000).toISOString(),
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const message = createUserMessage("", {
      id: "user-inbound-media-ref",
      __openclaw: { media: [{ path: source, contentType: "image/png", fileName: filename }] },
    });
    const group = createMessageGroup(message, "user");
    const draw = () =>
      mountSolid(
        MessageGroup,
        {
          group,
          options: {
            showReasoning: true,
            showToolCalls: false,
            assistantName: "OpenClaw",
            assistantAvatar: null,
            resourceBasePath: "/openclaw",
            assistantAttachmentAuthToken: "test-auth-token",
            onRequestUpdate,
            onOpenImage,
          },
        },
        container,
      );
    const observer = new MutationObserver(() => {
      if (container.querySelector(".chat-message-image")) {
        available.resolve();
      }
    });
    observer.observe(container, { childList: true, subtree: true });
    try {
      draw();
      await available.promise;
    } finally {
      observer.disconnect();
    }

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
      const fetchMetadata = vi.fn(async () =>
        Response.json({
          available: true,
          mediaTicket: "legacy-ticket",
          mediaTicketExpiresAt: new Date(Date.now() + 300_000).toISOString(),
        }),
      );
      vi.stubGlobal("fetch", fetchMetadata);
      const ready = createDeferred();
      const observer = new MutationObserver(() => {
        if (container.querySelector(".chat-message-image")) {
          ready.resolve();
        }
      });
      observer.observe(container, { childList: true, subtree: true });
      const onOpenImage = vi.fn<(item: ImageLightboxItem) => void>();
      try {
        renderImages([{ url: source, mimeType: "image/" + extension }], {
          onOpenImage,
          onRequestUpdate,
        });
        await ready.promise;
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
      } finally {
        observer.disconnect();
      }
    },
  );

  it("opens the cached preview immediately, upgrades a bounded rendition after decoding, and reuses it", async () => {
    const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
    const full = createDeferred<Response>();
    const decoded = createDeferred();
    const decode = vi.fn(() => decoded.promise);
    const blobPrefix = `blob:progressive-${crypto.randomUUID()}`;
    stubImageDecoding(blobPrefix, decode);
    const fetch = vi.fn((url: string) =>
      url.includes("width=960") ? full.promise : Promise.resolve(imageResponse()),
    );
    vi.stubGlobal("fetch", fetch);
    const { controller, onOpenImage, dispose } = createGallery();
    try {
      renderImages([{ url: source, alt: "Detailed screenshot" }], {
        onOpenImage,
        onRequestUpdate,
      });
      await vi.waitFor(() => expect(container.querySelector(".chat-message-image")).not.toBeNull());
      const tile = container.querySelector<HTMLButtonElement>(".chat-message-image-button")!;
      tile.click();

      expect(onOpenImage).toHaveBeenCalledOnce();
      expect(controller.current?.src).toBe(`${blobPrefix}-0`);
      full.resolve(imageResponse());
      await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
      expect(controller.current?.src).toBe(`${blobPrefix}-0`);
      decoded.resolve();
      await vi.waitFor(() => expect(controller.current?.src).toBe(`${blobPrefix}-1`));

      controller.dispose();
      tile.click();
      expect(onOpenImage).toHaveBeenCalledTimes(2);
      expect(controller.current?.src).toBe(`${blobPrefix}-0`);
      await vi.waitFor(() => expect(controller.current?.src).toBe(`${blobPrefix}-1`));
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([
        source.replace(/\/full$/u, "/thumbnail?v=4&width=480"),
        source.replace(/\/full$/u, "/thumbnail?v=4&width=960"),
      ]);
    } finally {
      full.resolve(new Response(null, { status: 503 }));
      decoded.resolve();
      dispose();
    }
  });

  it("keeps the preview when reopening a rendition the browser cannot decode", async () => {
    const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
    const blobPrefix = `blob:unsupported-${crypto.randomUUID()}`;
    const decode = vi.fn(async () => {
      throw new Error("Unsupported image format");
    });
    stubImageDecoding(blobPrefix, decode);
    const fetch = vi.fn(async (_url: string) => imageResponse());
    vi.stubGlobal("fetch", fetch);
    const { controller, onOpenImage, dispose } = createGallery();
    try {
      renderImages([{ url: source, alt: "Original in unsupported format" }], {
        onOpenImage,
        onRequestUpdate,
      });
      await vi.waitFor(() => expect(container.querySelector(".chat-message-image")).not.toBeNull());
      const tile = container.querySelector<HTMLButtonElement>(".chat-message-image-button")!;
      tile.click();
      await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
      expect(controller.current?.src).toBe(`${blobPrefix}-0`);

      controller.dispose();
      tile.click();
      expect(controller.current?.src).toBe(`${blobPrefix}-0`);
      await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(2));
      expect(controller.current?.src).toBe(`${blobPrefix}-0`);
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([
        source.replace(/\/full$/u, "/thumbnail?v=4&width=480"),
        source.replace(/\/full$/u, "/thumbnail?v=4&width=960"),
      ]);
    } finally {
      dispose();
    }
  });

  it.each(["navigation", "tile"] as const)(
    "does not prefetch neighbors and retries a failed selected rendition via %s",
    async (action) => {
      vi.useFakeTimers();
      const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
      const blobPrefix = `blob:gallery-${crypto.randomUUID()}`;
      stubImageDecoding(blobPrefix, async () => {});
      const fetchDisplay = vi.fn(async () => new Response(null, { status: 503 }));
      const fetch = vi.fn(async (url: string) =>
        url.includes("width=960") ? fetchDisplay() : imageResponse(),
      );
      vi.stubGlobal("fetch", fetch);
      const { controller, onOpenImage, dispose } = createGallery();
      try {
        renderImages(
          [
            { url: "data:image/png;base64,cG5n", alt: "First image" },
            { url: source, alt: "Managed neighbor", fileName: "neighbor.png" },
          ],
          { onOpenImage, onRequestUpdate },
        );
        await vi.advanceTimersByTimeAsync(0);
        const tiles = container.querySelectorAll<HTMLButtonElement>(".chat-message-image-button");
        tiles[0]!.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchDisplay).not.toHaveBeenCalled();
        expect(fetch.mock.calls.map(([url]) => url)).toEqual([
          source.replace(/\/full$/u, "/thumbnail?v=4&width=480"),
        ]);
        expect(await controller.move(1)).toBe(false);
        expect(fetchDisplay).toHaveBeenCalledOnce();
        expect(controller.current?.title).toBe("First image");
        expect(controller.failed).toBe(true);
        fetchDisplay.mockImplementation(async () => imageResponse());
        if (action === "navigation") {
          expect(await controller.move(1)).toBe(true);
        } else {
          tiles[1]!.click();
          await vi.advanceTimersByTimeAsync(0);
          expect(onOpenImage).toHaveBeenCalledTimes(2);
        }
        expect(fetchDisplay).toHaveBeenCalledTimes(2);
        expect(controller.index).toBe(1);
        expect(controller.current?.title).toBe("Managed neighbor");
        expect(controller.current?.src).toBe(`${blobPrefix}-1`);
        expect(controller.failed).toBe(false);
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
        { onOpenImage, onRequestUpdate, sessionKey: "main", resourceBasePath: "/openclaw" },
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
        releaseChatMediaResourceSubscriber(onRequestUpdate);
      }
      metadata.resolve(
        new Response(
          JSON.stringify({
            available: true,
            mediaTicket: "gallery-neighbor-ticket",
            mediaTicketExpiresAt: new Date(Date.now() + 300_000).toISOString(),
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
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
