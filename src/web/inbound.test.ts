import { describe, expect, it } from "vitest";

import { extractMediaPlaceholder, extractText } from "./inbound.js";

describe("web inbound helpers", () => {
  it("prefers the main conversation body", () => {
    const body = extractText({
      conversation: " hello ",
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(body).toBe("hello");
  });

  it("falls back to captions when conversation text is missing", () => {
    const body = extractText({
      imageMessage: { caption: " caption " },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(body).toBe("caption");
  });

  it("handles document captions", () => {
    const body = extractText({
      documentMessage: { caption: " doc " },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(body).toBe("doc");
  });

  it("unwraps view-once v2 extension messages", () => {
    const body = extractText({
      viewOnceMessageV2Extension: {
        message: { conversation: " hello " },
      },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(body).toBe("hello");
  });

  it("returns placeholders for media-only payloads", () => {
    expect(
      extractMediaPlaceholder({
        imageMessage: {},
      } as unknown as import("@whiskeysockets/baileys").proto.IMessage),
    ).toBe("<media:image>");
    expect(
      extractMediaPlaceholder({
        audioMessage: {},
      } as unknown as import("@whiskeysockets/baileys").proto.IMessage),
    ).toBe("<media:audio>");
  });
});
