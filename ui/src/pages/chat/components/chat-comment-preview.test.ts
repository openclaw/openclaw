/* @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { readChatSelectionAnnotation } from "../../../lib/chat/selection-annotation.ts";
import {
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayload,
} from "../attachment-payload-store.ts";
import { parseCommentAttachment } from "./chat-comment-preview.ts";
import { createChatSelectionAttachment } from "./chat-selection-attachment.ts";

describe("sent comment attachment presentation", () => {
  it.each([
    { text: "repeat\nlast", comment: "", domLength: 10 },
    {
      text: "🦞 First\n第二段\n\nUser comment:\n quoted",
      comment:
        "Keep this literal:\n\nSource session: example\nSelected text UTF-16 length: 1\nDOM text UTF-16 range: [0, 1)",
      domLength: "🦞 First第二段User comment: quoted".length,
    },
  ])(
    "roundtrips rendered selection $text independently of its DOM range",
    ({ text, comment, domLength }) => {
      const attachment = createChatSelectionAttachment(
        {
          text,
          comment,
          sessionKey: "agent:main:main",
          start: 7,
          end: 7 + domLength,
        },
        {},
        0,
      )!;
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

  it("retains file coordinates and quoted filenames through sending", () => {
    const file = { path: 'src/odd"name.ts', startLine: 7, endLine: 9, side: "old" as const };
    const attachment = createChatSelectionAttachment(
      {
        text: "return 3;",
        comment: "Replace this.",
        sessionKey: "agent:main:main",
        start: 0,
        end: 9,
        file,
      },
      {},
      0,
    )!;
    try {
      const data = getChatAttachmentDataUrl(attachment)!;
      expect(
        parseCommentAttachment(Buffer.from(data.split(",")[1]!, "base64").toString("utf8")),
      ).toEqual({ text: "return 3;", comment: "Replace this.", file });
    } finally {
      releaseChatAttachmentPayload(attachment.id);
    }
  });

  it("retains PDF names and page references through draft recovery and sending", () => {
    const pdf = { name: 'Release "review".pdf', page: 2 };
    const original = {
      text: "Rollback owner",
      comment: "Name the owner.",
      sessionKey: "agent:main:main",
      start: 0,
      end: 14,
      pdf,
    };
    const recovered = readChatSelectionAnnotation(structuredClone(original))!;
    expect(recovered.pdf).toEqual(pdf);
    const attachment = createChatSelectionAttachment(recovered, {}, 0)!;
    try {
      const data = getChatAttachmentDataUrl(attachment)!;
      expect(
        parseCommentAttachment(Buffer.from(data.split(",")[1]!, "base64").toString("utf8")),
      ).toEqual({ text: original.text, comment: original.comment, pdf });
    } finally {
      releaseChatAttachmentPayload(attachment.id);
    }
    expect(readChatSelectionAnnotation({ ...original, pdf: { ...pdf, page: 0 } })).toBeUndefined();
  });

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
    "Selected text:\nvalue\n\nUser comment:\nno provenance",
    "Selected text:\nvalue\n\nSource session: agent:main:main\nDOM text UTF-16 range: [0, 100)",
    "Selected text:\nrepeat\nlast\n\nSource session: agent:main:main\nDOM text UTF-16 range: [0, 10)",
    ...["0", "100", "9007199254740992"].map(
      (length) =>
        `Selected text:\nvalue\n\nSource session: agent:main:main\nSelected text UTF-16 length: ${length}\nDOM text UTF-16 range: [0, 5)`,
    ),
    "Selected text:\nvalue\n\nSource session: agent:main:main\nSelected text UTF-16 length: 5\nDOM text UTF-16 range: [9, 2)",
    "Selected text:\nvalue\n\nSource session: agent:main:main\nSelected text UTF-16 length: 5\nDOM text UTF-16 range: [9007199254740992, 9007199254740996)",
  ])("preserves malformed or lookalike text files as attachments", (value) => {
    expect(parseCommentAttachment(value)).toBeNull();
  });
});
