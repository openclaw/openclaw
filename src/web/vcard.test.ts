import { describe, expect, it } from "vitest";
import { parseVcard } from "./vcard.js";

describe("parseVcard", () => {
  it("returns empty result for undefined input", () => {
    expect(parseVcard(undefined)).toEqual({ phones: [] });
  });

  it("returns empty result for empty string", () => {
    expect(parseVcard("")).toEqual({ phones: [] });
  });

  it("parses FN (formatted name)", () => {
    const vcard = "BEGIN:VCARD\nFN:John Doe\nEND:VCARD";
    expect(parseVcard(vcard)).toEqual({ name: "John Doe", phones: [] });
  });

  it("parses N (structured name) with semicolons", () => {
    const vcard = "BEGIN:VCARD\nN:Doe;John;;;\nEND:VCARD";
    const result = parseVcard(vcard);
    expect(result.name).toBe("Doe John");
  });

  it("prefers FN over N", () => {
    const vcard = "BEGIN:VCARD\nFN:John Doe\nN:Doe;John;;;\nEND:VCARD";
    expect(parseVcard(vcard).name).toBe("John Doe");
  });

  it("parses phone numbers", () => {
    const vcard = "BEGIN:VCARD\nTEL:+1234567890\nTEL:+0987654321\nEND:VCARD";
    expect(parseVcard(vcard).phones).toEqual(["+1234567890", "+0987654321"]);
  });

  it("strips tel: prefix from phone values", () => {
    const vcard = "BEGIN:VCARD\nTEL:tel:+1234567890\nEND:VCARD";
    expect(parseVcard(vcard).phones).toEqual(["+1234567890"]);
  });

  it("handles TEL with parameters", () => {
    const vcard = "BEGIN:VCARD\nTEL;TYPE=CELL:+1234567890\nEND:VCARD";
    expect(parseVcard(vcard).phones).toEqual(["+1234567890"]);
  });

  it("handles grouped keys (e.g. item1.TEL)", () => {
    const vcard = "BEGIN:VCARD\nitem1.TEL:+1111\nEND:VCARD";
    expect(parseVcard(vcard).phones).toEqual(["+1111"]);
  });

  it("ignores unknown keys", () => {
    const vcard = "BEGIN:VCARD\nEMAIL:test@example.com\nFN:Test\nEND:VCARD";
    const result = parseVcard(vcard);
    expect(result.name).toBe("Test");
    expect(result.phones).toEqual([]);
  });

  it("handles Windows-style line endings", () => {
    const vcard = "BEGIN:VCARD\r\nFN:Test\r\nTEL:+123\r\nEND:VCARD";
    expect(parseVcard(vcard)).toEqual({ name: "Test", phones: ["+123"] });
  });

  it("cleans escaped characters in values", () => {
    const vcard = "BEGIN:VCARD\nFN:John\\, Jr.\nEND:VCARD";
    expect(parseVcard(vcard).name).toBe("John, Jr.");
  });

  it("handles full vcard with all fields", () => {
    const vcard = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Alice Smith",
      "N:Smith;Alice;;;",
      "TEL;TYPE=CELL:+1555000111",
      "TEL;TYPE=HOME:+1555000222",
      "EMAIL:alice@example.com",
      "END:VCARD",
    ].join("\n");
    const result = parseVcard(vcard);
    expect(result.name).toBe("Alice Smith");
    expect(result.phones).toEqual(["+1555000111", "+1555000222"]);
  });
});
