import { describe, expect, it } from "vitest";
import {
  stripSenderPrefix,
  parseExplicitElevatedAllowEntry,
  addFormattedTokens,
  EXPLICIT_ELEVATED_ALLOW_FIELDS,
} from "./elevated-allowlist-matcher.js";

describe("stripSenderPrefix", () => {
  it("strips channel prefixes", () => {
    expect(stripSenderPrefix("telegram:123456")).toBe("123456");
    expect(stripSenderPrefix("discord:user#1234")).toBe("user#1234");
    expect(stripSenderPrefix("slack:U123456")).toBe("U123456");
  });

  it("strips internal prefixes", () => {
    expect(stripSenderPrefix("internal:admin")).toBe("admin");
    expect(stripSenderPrefix("user:john")).toBe("john");
    expect(stripSenderPrefix("group:admins")).toBe("admins");
  });

  it("handles values without prefixes", () => {
    expect(stripSenderPrefix("plainvalue")).toBe("plainvalue");
    expect(stripSenderPrefix("123456")).toBe("123456");
  });

  it("handles empty/undefined input", () => {
    expect(stripSenderPrefix("")).toBe("");
    expect(stripSenderPrefix(undefined)).toBe("");
  });

  it("is case insensitive for prefixes", () => {
    expect(stripSenderPrefix("TELEGRAM:123")).toBe("123");
    expect(stripSenderPrefix("Telegram:123")).toBe("123");
  });
});

describe("parseExplicitElevatedAllowEntry", () => {
  it("parses valid field:value entries", () => {
    expect(parseExplicitElevatedAllowEntry("id:123456")).toEqual({
      field: "id",
      value: "123456",
    });
    expect(parseExplicitElevatedAllowEntry("username:john_doe")).toEqual({
      field: "username",
      value: "john_doe",
    });
    expect(parseExplicitElevatedAllowEntry("name:John Doe")).toEqual({
      field: "name",
      value: "John Doe",
    });
  });

  it("handles all valid field types", () => {
    EXPLICIT_ELEVATED_ALLOW_FIELDS.forEach((field) => {
      const result = parseExplicitElevatedAllowEntry(`${field}:testvalue`);
      expect(result).not.toBeNull();
      expect(result?.field).toBe(field);
    });
  });

  it("returns null for invalid fields", () => {
    expect(parseExplicitElevatedAllowEntry("invalid:value")).toBeNull();
    expect(parseExplicitElevatedAllowEntry("foo:bar")).toBeNull();
    expect(parseExplicitElevatedAllowEntry("unknown:test")).toBeNull();
  });

  it("returns null for missing value", () => {
    expect(parseExplicitElevatedAllowEntry("id:")).toBeNull();
    expect(parseExplicitElevatedAllowEntry("username:   ")).toBeNull();
  });

  it("returns null for entries without separator", () => {
    expect(parseExplicitElevatedAllowEntry("justavalue")).toBeNull();
    expect(parseExplicitElevatedAllowEntry("123456")).toBeNull();
  });

  it("trims whitespace from field and value", () => {
    expect(parseExplicitElevatedAllowEntry("  id  :  123  ")).toEqual({
      field: "id",
      value: "123",
    });
  });

  it("is case insensitive for fields", () => {
    expect(parseExplicitElevatedAllowEntry("ID:value")).toEqual({
      field: "id",
      value: "value",
    });
    expect(parseExplicitElevatedAllowEntry("USERNAME:test")).toEqual({
      field: "username",
      value: "test",
    });
  });
});

describe("addFormattedTokens", () => {
  it("adds formatted values to token set", () => {
    const tokens = new Set<string>();
    const formatter = (values: string[]) => values.map((v) => v.toLowerCase());
    
    addFormattedTokens({ formatAllowFrom: formatter, values: ["A", "B", "C"], tokens });
    
    expect(tokens.has("a")).toBe(true);
    expect(tokens.has("b")).toBe(true);
    expect(tokens.has("c")).toBe(true);
  });

  it("handles empty values array", () => {
    const tokens = new Set<string>();
    const formatter = (values: string[]) => values;
    
    addFormattedTokens({ formatAllowFrom: formatter, values: [], tokens });
    
    expect(tokens.size).toBe(0);
  });

  it("handles formatter that returns empty", () => {
    const tokens = new Set<string>();
    const formatter = () => [];
    
    addFormattedTokens({ formatAllowFrom: formatter, values: ["a", "b"], tokens });
    
    expect(tokens.size).toBe(0);
  });

  it("preserves existing tokens", () => {
    const tokens = new Set<string>(["existing"]);
    const formatter = (values: string[]) => values;
    
    addFormattedTokens({ formatAllowFrom: formatter, values: ["new"], tokens });
    
    expect(tokens.has("existing")).toBe(true);
    expect(tokens.has("new")).toBe(true);
  });

  it("handles formatter with custom logic", () => {
    const tokens = new Set<string>();
    const formatter = (values: string[]) =>
      values.flatMap((v) => [v, v.toUpperCase(), v.toLowerCase()]);
    
    addFormattedTokens({ formatAllowFrom: formatter, values: ["Test"], tokens });
    
    expect(tokens.has("Test")).toBe(true);
    expect(tokens.has("TEST")).toBe(true);
    expect(tokens.has("test")).toBe(true);
  });
});
