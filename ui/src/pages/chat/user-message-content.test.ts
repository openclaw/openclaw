/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import {
  getChatAttachmentDataUrl,
  getChatAttachmentPreviewUrl,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import { buildLocalUserMessage } from "./user-message-content.ts";

function buildAttachmentContent(
  attachments: Parameters<typeof buildLocalUserMessage>[0]["attachments"],
) {
  return buildLocalUserMessage({ attachments, createdAt: 1, text: "" })?.content;
}

describe("buildUserChatMessageContentBlocks", () => {
  it("keeps staged video attachments typed as video content", () => {
    expect(
      buildAttachmentContent([
        {
          id: "video-1",
          mimeType: "video/mp4",
          fileName: "demo.mp4",
          previewUrl: "blob:demo-video",
        },
      ]),
    ).toEqual([
      {
        type: "attachment",
        attachment: {
          url: "blob:demo-video",
          kind: "video",
          label: "demo.mp4",
          mimeType: "video/mp4",
        },
      },
    ]);
  });

  it.each([
    ["clip.avi", ""],
    ["clip.mp4", ""],
    ["clip.mkv", ""],
    ["clip.mpeg", ""],
    ["clip.mpg", ""],
    ["clip.mkv", "application/octet-stream"],
  ])("falls back to the %s extension when MIME is %s", (fileName, mimeType) => {
    const [block] =
      buildAttachmentContent([
        {
          id: `video-${fileName}-${mimeType}`,
          mimeType,
          fileName,
          previewUrl: `blob:${fileName}`,
        },
      ]) ?? [];

    expect(block?.attachment?.kind).toBe("video");
  });
});

it.each(["paste", "file", undefined] as const)(
  "preserves recorded and legacy origins in optimistic attachments: %s",
  (origin) => {
    const attachments = [
      {
        id: `origin-attachment-${origin}`,
        mimeType: "text/plain",
        fileName: "pasted-text-123.txt",
        dataUrl: "data:text/plain;base64,bm90ZXM=",
        ...(origin ? { origin } : {}),
      },
    ];
    try {
      const content = buildAttachmentContent(attachments);
      expect(content).toEqual([
        {
          type: "attachment",
          attachment: {
            url: expect.any(String),
            kind: "document",
            label: "pasted-text-123.txt",
            mimeType: "text/plain",
            ...(origin ? { origin } : {}),
          },
        },
      ]);
      expect(content?.[0]?.attachment?.url).toBe(getChatAttachmentPreviewUrl(attachments[0]!));
      expect(getChatAttachmentDataUrl(attachments[0]!)).toBe("data:text/plain;base64,bm90ZXM=");
    } finally {
      releaseChatAttachmentPayloads(attachments);
    }
  },
);
