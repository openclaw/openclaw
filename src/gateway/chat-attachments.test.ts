import { describe, expect, it, vi } from "vitest";
import {
  buildMessageWithAttachments,
  type ChatAttachment,
  parseMessageWithAttachments,
} from "./chat-attachments.js";

const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";

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

  it("rejects invalid base64 content", () => {
    const bad: ChatAttachment = {
      type: "image",
      mimeType: "image/png",
      fileName: "dot.png",
      content: "%not-base64%",
    };
    expect(() => buildMessageWithAttachments("x", [bad])).toThrow(/base64/);
  });

  it("rejects images over limit", () => {
    const big = "A".repeat(10_000);
    const att: ChatAttachment = {
      type: "image",
      mimeType: "image/png",
      fileName: "big.png",
      content: big,
    };
    const fromSpy = vi.spyOn(Buffer, "from");
    expect(() => buildMessageWithAttachments("x", [att], { maxBytes: 16 })).toThrow(
      /exceeds size limit/i,
    );
    const base64Calls = fromSpy.mock.calls.filter((args) => (args as unknown[])[1] === "base64");
    expect(base64Calls).toHaveLength(0);
    fromSpy.mockRestore();
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

  it("rejects invalid base64 content", async () => {
    await expect(
      parseMessageWithAttachments(
        "x",
        [
          {
            type: "image",
            mimeType: "image/png",
            fileName: "dot.png",
            content: "%not-base64%",
          },
        ],
        { log: { warn: () => {} } },
      ),
    ).rejects.toThrow(/base64/i);
  });

  it("rejects images over limit", async () => {
    const big = "A".repeat(10_000);
    const fromSpy = vi.spyOn(Buffer, "from");
    await expect(
      parseMessageWithAttachments(
        "x",
        [
          {
            type: "image",
            mimeType: "image/png",
            fileName: "big.png",
            content: big,
          },
        ],
        { maxBytes: 16, log: { warn: () => {} } },
      ),
    ).rejects.toThrow(/exceeds size limit/i);
    const base64Calls = fromSpy.mock.calls.filter((args) => (args as unknown[])[1] === "base64");
    expect(base64Calls).toHaveLength(0);
    fromSpy.mockRestore();
  });

  it("sniffs mime when missing", async () => {
    const logs: string[] = [];
    const parsed = await parseMessageWithAttachments(
      "see this",
      [
        {
          type: "image",
          fileName: "dot.png",
          content: PNG_1x1,
        },
      ],
      { log: { warn: (message) => logs.push(message) } },
    );
    expect(parsed.message).toBe("see this");
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]?.mimeType).toBe("image/png");
    expect(parsed.images[0]?.data).toBe(PNG_1x1);
    expect(logs).toHaveLength(0);
  });

  it("collects non-image payloads as file attachments", async () => {
    const logs: string[] = [];
    const pdf = Buffer.from("%PDF-1.4\n").toString("base64");
    const parsed = await parseMessageWithAttachments(
      "x",
      [
        {
          type: "file",
          mimeType: "image/png",
          fileName: "not-image.pdf",
          content: pdf,
        },
      ],
      { log: { warn: (message) => logs.push(message) } },
    );
    expect(parsed.images).toHaveLength(0);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]?.mimeType).toBe("application/pdf");
    expect(parsed.files[0]?.fileName).toBe("not-image.pdf");
    expect(parsed.files[0]?.data).toBe(pdf);
    expect(logs).toHaveLength(0);
  });

  it("prefers sniffed mime type and logs mismatch", async () => {
    const logs: string[] = [];
    const parsed = await parseMessageWithAttachments(
      "x",
      [
        {
          type: "image",
          mimeType: "image/jpeg",
          fileName: "dot.png",
          content: PNG_1x1,
        },
      ],
      { log: { warn: (message) => logs.push(message) } },
    );
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]?.mimeType).toBe("image/png");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/mime mismatch/i);
  });

  it("collects unknown-mime attachments as files when sniff fails", async () => {
    const logs: string[] = [];
    const unknown = Buffer.from("not an image").toString("base64");
    const parsed = await parseMessageWithAttachments(
      "x",
      [{ type: "file", fileName: "unknown.bin", content: unknown }],
      { log: { warn: (message) => logs.push(message) } },
    );
    expect(parsed.images).toHaveLength(0);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]?.mimeType).toBe("application/octet-stream");
    expect(parsed.files[0]?.fileName).toBe("unknown.bin");
    expect(logs).toHaveLength(0);
  });

  it("separates images and files from mixed attachments", async () => {
    const logs: string[] = [];
    const pdf = Buffer.from("%PDF-1.4\n").toString("base64");
    const parsed = await parseMessageWithAttachments(
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
      { log: { warn: (message) => logs.push(message) } },
    );
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]?.mimeType).toBe("image/png");
    expect(parsed.images[0]?.data).toBe(PNG_1x1);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]?.mimeType).toBe("application/pdf");
    expect(parsed.files[0]?.fileName).toBe("not-image.pdf");
  });
});
