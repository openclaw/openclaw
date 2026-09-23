/* @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import {
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayload,
} from "../attachment-payload-store.ts";
import { parseCommentAttachment } from "./chat-comment-preview.ts";
import { createChatSelectionAttachment } from "./chat-selection-attachment.ts";

describe("sent comment attachment presentation", () => {
  it.each([
    ["Review the deployment checklist.", ""],
    [
      "🦞 Keep spacing\n\nUser comment:\n  in the selected text.",
      "Another\n\nSource session: literal heading\n\nUser comment:\ninside the comment.",
    ],
  ])(
    "recovers the original selection and optional comment without interpreting their headings",
    (text, comment) => {
      const attachment = createChatSelectionAttachment({
        text,
        comment,
        sessionKey: "agent:main:main",
        start: 7,
        end: 7 + text.length,
      })!;
      try {
        const payload = getChatAttachmentDataUrl(attachment)!;
        expect(
          parseCommentAttachment(Buffer.from(payload.split(",")[1]!, "base64").toString("utf8")),
        ).toEqual({ text, comment });
      } finally {
        releaseChatAttachmentPayload(attachment.id);
      }
    },
  );

  it.each([
    { text: "repeat\nlast", comment: "", domLength: 10 },
    { text: "repeat\nlast", comment: "Check both lines.", domLength: 10 },
    {
      text: "🦞 First\n第二段\n\nUser comment:\n quoted",
      comment:
        "Keep this literal:\n\nSource session: example\nSelected text UTF-16 length: 1\nDOM text UTF-16 range: [0, 1)",
      domLength: "🦞 First第二段User comment: quoted".length,
    },
  ])(
    "roundtrips rendered selection $text independently of its DOM range",
    ({ text, comment, domLength }) => {
      const attachment = createChatSelectionAttachment({
        text,
        comment,
        sessionKey: "agent:main:main",
        start: 7,
        end: 7 + domLength,
      })!;
      try {
        const payload = getChatAttachmentDataUrl(attachment)!;
        expect(
          parseCommentAttachment(Buffer.from(payload.split(",")[1]!, "base64").toString("utf8")),
        ).toEqual({ text, comment });
      } finally {
        releaseChatAttachmentPayload(attachment.id);
      }
    },
  );

  it("retains the validated boundary in previously sent files without an explicit text length", () => {
    const text = "🦞 Quoted\n\nUser comment:\nliteral heading";
    const comment = "Keep the original comment.";
    const payload = [
      `Selected text:\n${text}`,
      `User comment:\n${comment}`,
      `Source session: agent:main:main\nDOM text UTF-16 range: [7, ${7 + text.length})`,
    ].join("\n\n");
    expect(parseCommentAttachment(payload)).toEqual({ text, comment });
  });

  it.each([
    "An ordinary text file.",
    "Selected text:\nvalue\n\nUser comment:\nno provenance",
    "Selected text:\nvalue\n\nSource session: agent:main:main\nDOM text UTF-16 range: [0, 100)",
    "Selected text:\nrepeat\nlast\n\nSource session: agent:main:main\nDOM text UTF-16 range: [0, 10)",
    ...["0", "-1", "1.5", "100", "9007199254740992"].map(
      (length) =>
        `Selected text:\nvalue\n\nSource session: agent:main:main\nSelected text UTF-16 length: ${length}\nDOM text UTF-16 range: [0, 5)`,
    ),
    "Selected text:\nvalue\n\nSource session: agent:main:main\nSelected text UTF-16 length: 5\nDOM text UTF-16 range: [9, 2)",
    "Selected text:\nvalue\n\nSource session: agent:main:main\nSelected text UTF-16 length: 5\nDOM text UTF-16 range: [9007199254740992, 9007199254740996)",
  ])("preserves malformed or lookalike text files as attachments", (value) => {
    expect(parseCommentAttachment(value)).toBeNull();
  });
});
