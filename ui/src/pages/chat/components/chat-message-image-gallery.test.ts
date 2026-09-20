/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { ImageLightboxGalleryController } from "../../../components/image-lightbox-gallery.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import { renderMessageImages } from "./chat-message-images.ts";
import { releaseChatMediaResourceSubscriber } from "./chat-message-media.ts";

let container: HTMLDivElement;
let onRequestUpdate: () => void;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  onRequestUpdate = vi.fn();
});

afterEach(() => {
  render(nothing, container);
  releaseChatMediaResourceSubscriber(onRequestUpdate);
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("message image gallery loading", () => {
  it.each(["navigation", "tile"] as const)(
    "retries exhausted managed neighbors on %s without polling when reopened",
    async (action) => {
      vi.useFakeTimers();
      const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
      const blobPrefix = `blob:gallery-${crypto.randomUUID()}`;
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
          async decode() {}
        },
      );
      const imageResponse = () => new Response("png", { headers: { "Content-Type": "image/png" } });
      const fetchFull = vi.fn(async () => new Response(null, { status: 503 }));
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => (url === source ? fetchFull() : imageResponse())),
      );
      const controller = new ImageLightboxGalleryController(vi.fn());
      const onOpenImage = vi.fn((item: ImageLightboxItem) => controller.reset(item.gallery, item));
      try {
        const draw = () =>
          render(
            renderMessageImages(
              [
                { url: "data:image/png;base64,cG5n", alt: "First image" },
                { url: source, alt: "Managed neighbor" },
              ],
              { onOpenImage, onRequestUpdate },
            ),
            container,
          );
        draw();
        const firstTile = container.querySelector<HTMLButtonElement>(".chat-message-image-button")!;
        firstTile.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchFull).toHaveBeenCalledOnce();
        expect(controller.current?.title).toBe("First image");
        expect(controller.failed).toBe(false);

        // The lifecycle permits one more speculative attempt after its retry window.
        await vi.advanceTimersByTimeAsync(5_000);
        firstTile.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchFull).toHaveBeenCalledTimes(2);

        fetchFull.mockImplementation(async () => imageResponse());
        await vi.advanceTimersByTimeAsync(10_000);
        firstTile.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchFull).toHaveBeenCalledTimes(2);
        expect(controller.current?.title).toBe("First image");
        expect(controller.failed).toBe(false);

        if (action === "navigation") {
          expect(await controller.move(1)).toBe(true);
        } else {
          controller.dispose();
          draw();
          const tiles = container.querySelectorAll<HTMLButtonElement>(".chat-message-image-button");
          expect(tiles).toHaveLength(2);
          onOpenImage.mockClear();
          tiles[1]!.click();
          await vi.advanceTimersByTimeAsync(0);
          expect(onOpenImage).toHaveBeenCalledOnce();
        }
        expect(fetchFull).toHaveBeenCalledTimes(3);
        expect(controller.index).toBe(1);
        expect(controller.current).toMatchObject({
          title: "Managed neighbor",
          src: `${blobPrefix}-1`,
        });
        expect(controller.failed).toBe(false);
      } finally {
        onOpenImage.mock.calls.at(-1)?.[0].release?.();
        controller.dispose();
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
      render(
        renderMessageImages(
          [
            { url: "data:image/png;base64,cG5n", alt: "First image" },
            { url: localSource, alt: "Local neighbor" },
          ],
          { onOpenImage, onRequestUpdate, sessionKey: "main", resourceBasePath: "/openclaw" },
        ),
        container,
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
      // Cross a task boundary while the metadata response remains explicitly held.
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(settled).not.toHaveBeenCalled();
      expect(fetchMetadata).toHaveBeenCalledOnce();

      if (removeOwner) {
        render(nothing, container);
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
        expect(result?.title).toBe("Local neighbor");
        const url = new URL(result!.src, window.location.href);
        expect(url.pathname).toBe("/openclaw/__openclaw__/assistant-media");
        expect(url.searchParams.get("source")).toBe(localSource);
        expect(url.searchParams.get("mediaTicket")).toBe("gallery-neighbor-ticket");
        expect(url.searchParams.get("sessionKey")).toBe("main");
      }
    },
  );
});
