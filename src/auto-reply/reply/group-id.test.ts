import { describe, expect, it } from "vitest";
import { extractExplicitGroupId } from "./group-id.js";

describe("extractExplicitGroupId", () => {
  it("returns undefined for empty/null input", () => {
    expect(extractExplicitGroupId(undefined)).toBeUndefined();
    expect(extractExplicitGroupId(null)).toBeUndefined();
    expect(extractExplicitGroupId("")).toBeUndefined();
    expect(extractExplicitGroupId("  ")).toBeUndefined();
  });

  it("extracts group ID from telegram group format", () => {
    expect(extractExplicitGroupId("telegram:group:-1003776849159")).toBe("-1003776849159");
  });

  it("extracts group ID from telegram forum topic format, stripping topic suffix", () => {
    expect(extractExplicitGroupId("telegram:group:-1003776849159:topic:1264")).toBe(
      "-1003776849159",
    );
  });

  it("extracts group ID from channel format", () => {
    expect(extractExplicitGroupId("telegram:channel:-1001234567890")).toBe("-1001234567890");
  });

  it("extracts group ID from channel format with topic", () => {
    expect(extractExplicitGroupId("telegram:channel:-1001234567890:topic:42")).toBe(
      "-1001234567890",
    );
  });

  it("extracts group ID from bare group: prefix", () => {
    expect(extractExplicitGroupId("group:-1003776849159")).toBe("-1003776849159");
  });

  it("extracts group ID from bare group: prefix with topic", () => {
    expect(extractExplicitGroupId("group:-1003776849159:topic:999")).toBe("-1003776849159");
  });

  it("extracts WhatsApp group ID", () => {
    expect(extractExplicitGroupId("whatsapp:120363123456789@g.us")).toBe("120363123456789@g.us");
  });

  it("returns undefined for unrecognized formats", () => {
    expect(extractExplicitGroupId("user:12345")).toBeUndefined();
    expect(extractExplicitGroupId("just-a-string")).toBeUndefined();
  });
});
