import { describe, expect, test } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { deriveSessionTitle } from "./session-title.js";

describe("deriveSessionTitle", () => {
  test("returns undefined for undefined entry", () => {
    expect(deriveSessionTitle(undefined)).toBeUndefined();
  });

  test("prefers displayName when set", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
      displayName: "My Custom Session",
      subject: "Group Chat",
    } as SessionEntry;
    expect(deriveSessionTitle(entry)).toBe("My Custom Session");
  });

  test("falls back to subject when displayName is missing", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
      subject: "Dev Team Chat",
    } as SessionEntry;
    expect(deriveSessionTitle(entry)).toBe("Dev Team Chat");
  });

  test("prefers session label over first user message when present", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
      label: "My App - Dashboard",
    } as SessionEntry;
    expect(deriveSessionTitle(entry, "heartbeat")).toBe("My App - Dashboard");
  });

  test("falls back to origin label before transcript-derived title", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
      origin: { label: "Discord: Engineering" },
    } as SessionEntry;
    expect(deriveSessionTitle(entry, "heartbeat")).toBe("Discord: Engineering");
  });

  test("uses first user message when displayName, subject, and labels are missing", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
    } as SessionEntry;
    expect(deriveSessionTitle(entry, "Hello, how are you?")).toBe("Hello, how are you?");
  });

  test("truncates long first user message to 60 chars with ellipsis", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
    } as SessionEntry;
    const longMsg =
      "This is a very long message that exceeds sixty characters and should be truncated appropriately";
    const result = deriveSessionTitle(entry, longMsg);
    expect(result).toBeDefined();
    expect(result!.length).toBeLessThanOrEqual(60);
    expect(result!.endsWith("…")).toBe(true);
  });

  test("falls back to sessionId prefix with date", () => {
    const entry = {
      sessionId: "abcd1234-5678-90ef-ghij-klmnopqrstuv",
      updatedAt: new Date("2024-03-15T10:30:00Z").getTime(),
    } as SessionEntry;
    expect(deriveSessionTitle(entry)).toBe("abcd1234 (2024-03-15)");
  });
});
