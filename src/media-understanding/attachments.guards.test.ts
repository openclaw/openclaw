// Attachment selection guard tests cover malformed attachment containers and
// invalid entry shapes.
import { describe, expect, it } from "vitest";
import { selectAttachments } from "./attachments.js";
import type { MediaAttachment } from "./types.js";

describe("media-understanding selectAttachments guards", () => {
  it("returns no selections when attachments is undefined", () => {
    expect(
      selectAttachments({
        capability: "image",
        attachments: undefined as unknown as MediaAttachment[],
        policy: { prefer: "path" },
      }),
    ).toStrictEqual({ selected: [], droppedAttachmentIndexes: [] });
  });

  it("returns no selections when attachments is not an array", () => {
    expect(
      selectAttachments({
        capability: "audio",
        attachments: { malformed: true } as unknown as MediaAttachment[],
        policy: { prefer: "url" },
      }),
    ).toStrictEqual({ selected: [], droppedAttachmentIndexes: [] });
  });

  it("returns no selections for malformed attachment entries", () => {
    expect(
      selectAttachments({
        capability: "audio",
        attachments: [
          null,
          { index: 1, path: 123 },
          { index: 2, url: true },
          { index: 3, mime: { nope: true } },
        ] as unknown as MediaAttachment[],
        policy: { prefer: "path" },
      }),
    ).toStrictEqual({ selected: [], droppedAttachmentIndexes: [] });
  });

  it("reports only same-capability attachments dropped by truncation", () => {
    expect(
      selectAttachments({
        capability: "image",
        attachments: [
          { index: 0, path: "/tmp/first.jpg", mime: "image/jpeg" },
          { index: 1, path: "/tmp/note.ogg", mime: "audio/ogg" },
          { index: 2, path: "/tmp/second.jpg", mime: "image/jpeg" },
          { index: 3, path: "/tmp/third.jpg", mime: "image/jpeg" },
        ],
      }),
    ).toStrictEqual({
      selected: [{ index: 0, path: "/tmp/first.jpg", mime: "image/jpeg" }],
      droppedAttachmentIndexes: [2, 3],
    });
  });

  it.each([
    { prefer: "first", limit: 2, selected: [0, 2], dropped: [18, 23] },
    { prefer: "last", limit: 2, selected: [4, 3], dropped: [14, 11] },
    { prefer: "path", limit: 2, selected: [2, 3], dropped: [11, 23] },
    { prefer: "url", limit: 2, selected: [0, 3], dropped: [23, 14] },
    { prefer: "first", limit: 1.9, selected: [0], dropped: [14, 18, 23] },
    { prefer: "first", limit: Number.NaN, selected: [], dropped: [11, 14, 18, 23] },
    { prefer: "first", limit: Infinity, selected: [0, 2, 3, 4], dropped: [] },
  ] as const)(
    "preserves references and order with $prefer preference and limit $limit",
    ({ prefer, limit, selected, dropped }) => {
      const attachments: MediaAttachment[] = [
        { index: 11, kind: "image", url: "https://example.test/first.png" },
        { index: 12, kind: "audio", path: "/tmp/note.ogg" },
        { index: 14, kind: "image", path: "/tmp/second.png" },
        {
          index: 18,
          kind: "image",
          path: "/tmp/third.png",
          url: "https://example.test/third.png",
        },
        { index: 23, kind: "image", url: "https://example.test/fourth.png" },
      ];
      for (const attachment of attachments) {
        Object.freeze(attachment);
      }
      Object.freeze(attachments);

      const result = selectAttachments({
        capability: "image",
        attachments,
        policy: { mode: "all", prefer, maxAttachments: limit },
      });

      expect(result.selected).toHaveLength(selected.length);
      for (const [position, inputPosition] of selected.entries()) {
        expect(result.selected[position]).toBe(attachments[inputPosition]);
      }
      expect(result.droppedAttachmentIndexes).toEqual(dropped);
    },
  );
});
