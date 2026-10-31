// @vitest-environment node
// Control UI tests cover browser-safe media extension parsing.
import { describe, expect, it } from "vitest";
import { projectMessageMedia } from "../pages/chat/components/chat-message-media.ts";
import { normalizeMessage } from "./chat/message-normalizer.ts";
import { getMediaFileExtension, labelForMediaPath } from "./media-file-extension.ts";

describe("getMediaFileExtension", () => {
  it.each([
    { value: "https://cdn.example/render%2Emp4?download=1#preview", expected: "mp4" },
    { value: "https://cdn.example/render%2Em%70%34", expected: "mp4" },
    { value: "/media/inbound/photo.png?mediaTicket=signed#preview", expected: "png" },
    { value: "/__openclaw__/media/voice%2Eogg?mediaTicket=signed", expected: "ogg" },
    { value: "/media/inbound/photo.png?preview=.jpg", expected: "png" },
    { value: "/tmp/recording?download=.mp3", expected: "mp3" },
    { value: "/tmp/clip#final.mp4", expected: "mp4" },
    { value: "https://cdn.example/bad%ZZ/render%2Emp4", expected: "mp4" },
    { value: "https://cdn.example/archive%2Fclip%2Emp4", expected: "mp4" },
    { value: "https://cdn.example/archive%5Cclip%2Emp4", expected: "mp4" },
    { value: "https://cdn.example/render.mp4%2Fpreview", expected: undefined },
    { value: "https://cdn.example/render.mp4%5Cpreview", expected: undefined },
    { value: "https://cdn.example/bad%ZZ%2Emp4", expected: undefined },
    { value: "https://cdn.example/render%2Emp4/", expected: undefined },
    { value: String.raw`C:\media\clip.MP4`, expected: "mp4" },
  ] as const)("extracts $expected from $value", ({ value, expected }) => {
    expect(getMediaFileExtension(value)).toBe(expected);
  });
});

describe("inbound attachment filenames", () => {
  it("decodes fallback labels once while preserving explicit filenames and media sources", () => {
    for (const fileName of [
      "My Report.pdf",
      "研究 报告.pdf",
      "budget#1.pdf",
      "literal%20name.pdf",
    ]) {
      const id = fileName.replace(".pdf", "---123e4567-e89b-12d3-a456-426614174000.pdf");
      const path = `media://inbound/${encodeURIComponent(id)}`;
      for (const explicitFileName of [undefined, fileName]) {
        const message = {
          role: "user",
          content: [{ type: "text", text: "Synthetic attachment" }],
          __openclaw: {
            media: [{ path, contentType: "application/pdf", fileName: explicitFileName }],
          },
        };
        const { attachments } = projectMessageMedia(message, normalizeMessage(message).content);
        expect(attachments[0]).toMatchObject({
          type: "attachment",
          attachment: { label: fileName, url: path },
        });
      }
    }
  });

  it("preserves malformed escapes and encoded separators in fallback labels", () => {
    for (const basename of ["bad%ZZ.pdf", "archive%2Freport.pdf", "archive%5Creport.pdf"]) {
      expect(labelForMediaPath(`media://inbound/${basename}`)).toBe(basename);
    }
  });

  it("uses readable fallback labels for assistant MEDIA directives", () => {
    for (const fileName of [
      "My Report.pdf",
      "研究 报告.pdf",
      "budget#1.pdf",
      "literal%20name.pdf",
    ]) {
      const id = fileName.replace(".pdf", "---123e4567-e89b-12d3-a456-426614174000.pdf");
      const path = `media://inbound/${encodeURIComponent(id)}`;
      const message = { role: "assistant", content: `MEDIA:${path}` };
      const { attachments } = projectMessageMedia(message, normalizeMessage(message).content);
      expect(attachments[0]).toMatchObject({
        type: "attachment",
        attachment: { label: fileName, url: path },
      });
    }
  });
});
