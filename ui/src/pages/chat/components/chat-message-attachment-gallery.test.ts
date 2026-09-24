/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import {
  createAssistantMessage,
  createAttachmentBlock,
  createMessageGroup,
} from "./chat-message.test-support.ts";
import { renderMessageGroup } from "./chat-message.ts";

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  render(nothing, container);
  container.remove();
});

function renderAssistantMessage(
  target: HTMLElement,
  message: unknown,
  options: Partial<Parameters<typeof renderMessageGroup>[1]>,
) {
  render(
    renderMessageGroup(createMessageGroup(message, "assistant"), {
      showReasoning: false,
      showToolCalls: false,
      assistantName: "OpenClaw",
      assistantAvatar: null,
      ...options,
    }),
    target,
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
        format: "structured images",
        content: [
          { type: "text", text: "Introduction\n\n**Before**" },
          { type: "image", url: "https://example.com/before.png" },
          { type: "text", text: "**After**" },
          { type: "image", url: "https://example.com/after.png" },
          { type: "text", text: "Closing paragraph" },
        ],
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
    ].flatMap(({ format, content }) =>
      [false, true].map((persisted) => ({ format, content, persisted })),
    ),
  )(
    "keeps assistant $format in order and in one image gallery (persisted: $persisted)",
    async ({ content, persisted }) => {
      const onOpenImage = vi.fn<(item: ImageLightboxItem) => void>();
      renderAssistantMessage(
        container,
        createAssistantMessage(content, {
          timestamp: 1000,
          ...(persisted
            ? {
                __openclaw: {
                  media: [
                    { path: "https://example.com/before.png", contentType: "image/png" },
                    { path: "https://example.com/after.png", contentType: "image/png" },
                  ],
                },
              }
            : {}),
        }),
        { onOpenImage },
      );

      expect(
        Array.from(
          container.querySelectorAll(".chat-text strong, .chat-message-image"),
          (element) =>
            element instanceof HTMLImageElement
              ? new URL(element.src).pathname
              : element.textContent?.replace(/\s+/g, " ").trim(),
        ),
      ).toEqual(["Before", "/before.png", "After", "/after.png"]);
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

  it("keeps duplicate attachment slots but not their persisted mirrors in the gallery", () => {
    const source = "https://example.com/repeated.png";
    const onOpenImage = vi.fn<(item: ImageLightboxItem) => void>();
    renderAssistantMessage(
      container,
      createAssistantMessage(
        [
          createAttachmentBlock(source, "document", "Repeated", "image/png"),
          createAttachmentBlock(source, "document", "Repeated", "image/png"),
        ],
        { __openclaw: { media: [{ path: source, contentType: "image/png" }] } },
      ),
      { onOpenImage },
    );
    const tiles = container.querySelectorAll<HTMLButtonElement>(".chat-message-image-button");
    expect(tiles).toHaveLength(2);
    tiles[1]?.click();
    expect(onOpenImage.mock.calls[0]?.[0].gallery).toMatchObject({
      index: 1,
      items: [expect.any(Function), expect.any(Function)],
    });
  });

  it("includes persisted images identified by an opaque download filename in the gallery", () => {
    const onOpenImage = vi.fn<(item: ImageLightboxItem) => void>();
    renderAssistantMessage(
      container,
      createAssistantMessage("", {
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
      { onOpenImage },
    );
    const tiles = container.querySelectorAll<HTMLButtonElement>(".chat-message-image-button");
    expect(tiles).toHaveLength(2);
    tiles[0]?.click();
    expect(onOpenImage.mock.calls[0]?.[0].gallery).toMatchObject({
      index: 0,
      items: [expect.any(Function), expect.any(Function)],
    });
  });
});
