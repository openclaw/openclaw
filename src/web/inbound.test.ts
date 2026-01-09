import { describe, expect, it } from "vitest";

import {
  extractLocationData,
  extractMediaPlaceholder,
  extractText,
} from "./inbound.js";

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

  it("extracts WhatsApp contact cards", () => {
    const body = extractText({
      contactMessage: {
        displayName: "Ada Lovelace",
        vcard: [
          "BEGIN:VCARD",
          "VERSION:3.0",
          "FN:Ada Lovelace",
          "TEL;TYPE=CELL:+15555550123",
          "END:VCARD",
        ].join("\n"),
      },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(body).toBe("<contact: Ada Lovelace, +15555550123>");
  });

  it("prefers FN over N in WhatsApp vcards", () => {
    const body = extractText({
      contactMessage: {
        vcard: [
          "BEGIN:VCARD",
          "VERSION:3.0",
          "N:Lovelace;Ada;;;",
          "FN:Ada Lovelace",
          "TEL;TYPE=CELL:+15555550123",
          "END:VCARD",
        ].join("\n"),
      },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(body).toBe("<contact: Ada Lovelace, +15555550123>");
  });

  it("extracts multiple WhatsApp contact cards", () => {
    const body = extractText({
      contactsArrayMessage: {
        contacts: [
          { displayName: "Alice" },
          { displayName: "Bob" },
          { displayName: "Charlie" },
          { displayName: "Dana" },
        ],
      },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(body).toBe("<contacts: Alice, Bob, Charlie +1 more>");
  });

  it("summarizes empty WhatsApp contact cards with a count", () => {
    const body = extractText({
      contactsArrayMessage: {
        contacts: [{}, {}],
      },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(body).toBe("<contacts: 2 contacts>");
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

  it("extracts WhatsApp location messages", () => {
    const location = extractLocationData({
      locationMessage: {
        degreesLatitude: 48.858844,
        degreesLongitude: 2.294351,
        name: "Eiffel Tower",
        address: "Champ de Mars, Paris",
        accuracyInMeters: 12,
        comment: "Meet here",
      },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(location).toEqual({
      latitude: 48.858844,
      longitude: 2.294351,
      accuracy: 12,
      name: "Eiffel Tower",
      address: "Champ de Mars, Paris",
      caption: "Meet here",
      source: "place",
      isLive: false,
    });
  });

  it("extracts WhatsApp live location messages", () => {
    const location = extractLocationData({
      liveLocationMessage: {
        degreesLatitude: 37.819929,
        degreesLongitude: -122.478255,
        accuracyInMeters: 20,
        caption: "On the move",
      },
    } as unknown as import("@whiskeysockets/baileys").proto.IMessage);
    expect(location).toEqual({
      latitude: 37.819929,
      longitude: -122.478255,
      accuracy: 20,
      caption: "On the move",
      source: "live",
      isLive: true,
    });
  });
});
