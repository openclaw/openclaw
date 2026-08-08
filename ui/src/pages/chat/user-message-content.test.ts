/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { buildUserChatMessageContentBlocks } from "./user-message-content.ts";

describe("buildUserChatMessageContentBlocks", () => {
  it("keeps staged video attachments typed as video content", () => {
    expect(
      buildUserChatMessageContentBlocks("", [
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

  it("projects inline video payloads as filename-only text", () => {
    const payload = "dmlkZW8=";
    const blocks = buildUserChatMessageContentBlocks("Watch this", [
      {
        id: "video-1",
        mimeType: "video/mp4",
        fileName: "demo.mp4",
        dataUrl: `data:video/mp4;base64,${payload}`,
      },
    ]);

    expect(blocks).toEqual([
      { type: "text", text: "Watch this" },
      { type: "text", text: "Attached video: demo.mp4" },
    ]);
    expect(JSON.stringify(blocks)).not.toContain(payload);
  });

  it.each([
    ["clip.avi", ""],
    ["clip.mp4", ""],
    ["clip.mkv", ""],
    ["clip.mpeg", ""],
    ["clip.mpg", ""],
    ["clip.mkv", "application/octet-stream"],
  ])("falls back to the %s extension when MIME is %s", (fileName, mimeType) => {
    const [block] = buildUserChatMessageContentBlocks("", [
      {
        id: `video-${fileName}-${mimeType}`,
        mimeType,
        fileName,
        previewUrl: `blob:${fileName}`,
      },
    ]);

    expect(block?.attachment?.kind).toBe("video");
  });
});
