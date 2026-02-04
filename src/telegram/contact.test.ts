import type { Message } from "@grammyjs/types";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractTelegramContact, formatContactText } from "./bot/helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const vcardFixture = readFileSync(resolve(__dirname, "fixtures/contact.vcf"), "utf-8");

/**
 * Build a minimal Telegram Message with a contact field.
 * The shape matches the Telegram Bot API spec (via @grammyjs/types).
 */
function buildContactMessage(contact: Message["contact"], overrides?: Partial<Message>): Message {
  return {
    message_id: 1,
    date: 1736380800,
    chat: { id: 42, type: "private" as const, first_name: "Test" },
    contact,
    ...overrides,
  } as Message;
}

describe("extractTelegramContact", () => {
  it("returns null when message has no contact", () => {
    const msg = buildContactMessage(undefined);
    expect(extractTelegramContact(msg)).toBeNull();
  });

  it("extracts basic contact fields (phone, name)", () => {
    const msg = buildContactMessage({
      phone_number: "+5551999887766",
      first_name: "Nei",
      last_name: "Cardoso",
      user_id: 521158006,
    });
    const result = extractTelegramContact(msg);
    expect(result).toEqual({
      phoneNumber: "+5551999887766",
      firstName: "Nei",
      lastName: "Cardoso",
      userId: 521158006,
      vcard: undefined,
    });
  });

  it("extracts contact with vCard data from fixture", () => {
    const msg = buildContactMessage({
      phone_number: "+5551999887766",
      first_name: "Nei",
      last_name: "Cardoso",
      user_id: 521158006,
      vcard: vcardFixture,
    });
    const result = extractTelegramContact(msg);
    expect(result).not.toBeNull();
    expect(result!.vcard).toBe(vcardFixture);
    expect(result!.phoneNumber).toBe("+5551999887766");
  });

  it("handles contact without last_name or user_id", () => {
    const msg = buildContactMessage({
      phone_number: "+1234567890",
      first_name: "Alice",
    });
    const result = extractTelegramContact(msg);
    expect(result).toEqual({
      phoneNumber: "+1234567890",
      firstName: "Alice",
      lastName: undefined,
      userId: undefined,
      vcard: undefined,
    });
  });
});

describe("formatContactText", () => {
  it("formats a basic contact without vCard", () => {
    const text = formatContactText({
      phoneNumber: "+5551999887766",
      firstName: "Nei",
      lastName: "Cardoso",
      userId: 521158006,
    });
    expect(text).toBe("[Contact: Nei Cardoso]\nPhone: +5551999887766\nTelegram ID: 521158006");
  });

  it("formats a contact with first name only", () => {
    const text = formatContactText({
      phoneNumber: "+1234567890",
      firstName: "Alice",
    });
    expect(text).toBe("[Contact: Alice]\nPhone: +1234567890");
    expect(text).not.toContain("Telegram ID");
  });

  it("parses real vCard fixture and includes all fields", () => {
    const text = formatContactText({
      phoneNumber: "+5551999887766",
      firstName: "Nei",
      lastName: "Cardoso",
      userId: 521158006,
      vcard: vcardFixture,
    });

    expect(text).toContain("[Contact: Nei Cardoso]");
    expect(text).toContain("Phone: +5551999887766");
    expect(text).toContain("Telegram ID: 521158006");
    expect(text).toContain("Email: nei@neurohive.ai");
    expect(text).toContain("Birthday: 1990-06-15");
    expect(text).toContain("Organization: NeuroHIVE");
    expect(text).toContain("Title: Founder");
    expect(text).toContain("URL: https://neurohive.ai");
    expect(text).toContain("Address:");
    expect(text).toContain("Porto Alegre");
    expect(text).toContain("Note: AI consultancy and engineering");
  });

  it("handles vCard with only some fields", () => {
    const sparseVcard = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Bob Smith",
      "EMAIL:bob@example.com",
      "END:VCARD",
    ].join("\n");

    const text = formatContactText({
      phoneNumber: "+9876543210",
      firstName: "Bob",
      lastName: "Smith",
      vcard: sparseVcard,
    });

    expect(text).toContain("Email: bob@example.com");
    expect(text).not.toContain("Birthday");
    expect(text).not.toContain("Organization");
    expect(text).not.toContain("Address");
  });
});
