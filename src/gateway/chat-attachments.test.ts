import { describe, expect, it, vi } from "vitest";
import {
  buildMessageWithAttachments,
  type ChatAttachment,
  parseMessageWithAttachments,
  UnsupportedAttachmentError,
  type UnsupportedAttachmentReason,
} from "./chat-attachments.js";

const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";

async function parseWithWarnings(message: string, attachments: ChatAttachment[]) {
  const logs: string[] = [];
  const parsed = await parseMessageWithAttachments(message, attachments, {
    log: { warn: (warning) => logs.push(warning) },
  });
  return { parsed, logs };
}

async function expectUnsupportedAttachment(
  promise: Promise<unknown>,
  reason: UnsupportedAttachmentReason,
  messagePattern: RegExp,
): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(UnsupportedAttachmentError);
    const caught = err as UnsupportedAttachmentError;
    expect(caught.reason).toBe(reason);
    expect(caught.message).toMatch(messagePattern);
    return;
  }
  throw new Error(
    `expected parseMessageWithAttachments to throw UnsupportedAttachmentError (reason=${reason})`,
  );
}

describe("buildMessageWithAttachments", () => {
  it("embeds a single image as data URL", () => {
    const msg = buildMessageWithAttachments("see this", [
      {
        type: "image",
        mimeType: "image/png",
        fileName: "dot.png",
        content: PNG_1x1,
      },
    ]);
    expect(msg).toContain("see this");
    expect(msg).toContain(`data:image/png;base64,${PNG_1x1}`);
    expect(msg).toContain("![dot.png]");
  });

  it("rejects non-image mime types", () => {
    const bad: ChatAttachment = {
      type: "file",
      mimeType: "application/pdf",
      fileName: "a.pdf",
      content: "AAA",
    };
    expect(() => buildMessageWithAttachments("x", [bad])).toThrow(/image/);
  });
});

describe("parseMessageWithAttachments", () => {
  it("strips data URL prefix", async () => {
    const parsed = await parseMessageWithAttachments(
      "see this",
      [
        {
          type: "image",
          mimeType: "image/png",
          fileName: "dot.png",
          content: `data:image/png;base64,${PNG_1x1}`,
        },
      ],
      { log: { warn: () => {} } },
    );
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]?.mimeType).toBe("image/png");
    expect(parsed.images[0]?.data).toBe(PNG_1x1);
  });

  it("sniffs mime when missing", async () => {
    const { parsed, logs } = await parseWithWarnings("see this", [
      {
        type: "image",
        fileName: "dot.png",
        content: PNG_1x1,
      },
    ]);
    expect(parsed.message).toBe("see this");
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]?.mimeType).toBe("image/png");
    expect(parsed.images[0]?.data).toBe(PNG_1x1);
    expect(logs).toHaveLength(0);
  });

  it("throws UnsupportedAttachmentError when a non-image payload is attached instead of silently dropping", async () => {
    const pdf = Buffer.from("%PDF-1.4\n").toString("base64");
    await expectUnsupportedAttachment(
      parseMessageWithAttachments(
        "x",
        [
          {
            type: "file",
            mimeType: "image/png",
            fileName: "not-image.pdf",
            content: pdf,
          },
        ],
        { log: { warn: () => {} } },
      ),
      "non-image",
      /non-image/i,
    );
  });

  it("prefers sniffed mime type and logs mismatch", async () => {
    const { parsed, logs } = await parseWithWarnings("x", [
      {
        type: "image",
        mimeType: "image/jpeg",
        fileName: "dot.png",
        content: PNG_1x1,
      },
    ]);
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]?.mimeType).toBe("image/png");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/mime mismatch/i);
  });

  it("throws UnsupportedAttachmentError when mime cannot be sniffed and provided mime is non-image", async () => {
    const unknown = Buffer.from("not an image").toString("base64");
    await expectUnsupportedAttachment(
      parseMessageWithAttachments(
        "x",
        [{ type: "file", fileName: "unknown.bin", content: unknown }],
        { log: { warn: () => {} } },
      ),
      "unknown-mime",
      /unable to detect image mime type/i,
    );
  });

  it("fails the entire parse when a mixed batch contains a non-image attachment", async () => {
    // Previously the parser dropped the PDF and kept the PNG. That behaviour
    // silently discarded user data. The batch now fails loudly so clients can
    // retry with only the supported attachments. See #48123.
    const pdf = Buffer.from("%PDF-1.4\n").toString("base64");
    await expectUnsupportedAttachment(
      parseMessageWithAttachments(
        "x",
        [
          {
            type: "image",
            mimeType: "image/png",
            fileName: "dot.png",
            content: PNG_1x1,
          },
          {
            type: "file",
            mimeType: "image/png",
            fileName: "not-image.pdf",
            content: pdf,
          },
        ],
        { log: { warn: () => {} } },
      ),
      "non-image",
      /non-image/i,
    );
  });

  it("throws UnsupportedAttachmentError when a text-only session receives any attachment", async () => {
    // Previously `parseMessageWithAttachments` returned empty and logged a
    // warning when `supportsImages === false`, which silently discarded all
    // attachments (including valid images) and let callers see a successful
    // response while the model never saw the content. Now it raises
    // explicitly so callers can surface the failure. See #48123.
    await expectUnsupportedAttachment(
      parseMessageWithAttachments(
        "describe image",
        [
          {
            type: "image",
            mimeType: "image/png",
            fileName: "dot.png",
            content: PNG_1x1,
          },
        ],
        { log: { warn: () => {} }, supportsImages: false },
      ),
      "text-only-session",
      /does not support images/i,
    );
  });

  it("passes text through unchanged for text-only sessions with no attachments", async () => {
    const parsed = await parseMessageWithAttachments("plain text", [], {
      log: { warn: () => {} },
      supportsImages: false,
    });
    expect(parsed.message).toBe("plain text");
    expect(parsed.images).toHaveLength(0);
    expect(parsed.offloadedRefs).toHaveLength(0);
  });
});

describe("shared attachment validation", () => {
  it("rejects invalid base64 content for both builder and parser", async () => {
    const bad: ChatAttachment = {
      type: "image",
      mimeType: "image/png",
      fileName: "dot.png",
      content: "%not-base64%",
    };

    expect(() => buildMessageWithAttachments("x", [bad])).toThrow(/base64/i);
    await expect(
      parseMessageWithAttachments("x", [bad], { log: { warn: () => {} } }),
    ).rejects.toThrow(/base64/i);
  });

  it("rejects images over limit for both builder and parser without decoding base64", async () => {
    const big = "A".repeat(10_000);
    const att: ChatAttachment = {
      type: "image",
      mimeType: "image/png",
      fileName: "big.png",
      content: big,
    };

    const fromSpy = vi.spyOn(Buffer, "from");
    try {
      expect(() => buildMessageWithAttachments("x", [att], { maxBytes: 16 })).toThrow(
        /exceeds size limit/i,
      );
      await expect(
        parseMessageWithAttachments("x", [att], { maxBytes: 16, log: { warn: () => {} } }),
      ).rejects.toThrow(/exceeds size limit/i);
      const base64Calls = fromSpy.mock.calls.filter((args) => (args as unknown[])[1] === "base64");
      expect(base64Calls).toHaveLength(0);
    } finally {
      fromSpy.mockRestore();
    }
  });
});
