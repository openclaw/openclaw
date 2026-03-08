import { describe, expect, it } from "vitest";
import { resolveAllowlistMatchSimple } from "./allowlist-match.js";

describe("resolveAllowlistMatchSimple", () => {
  it("matches wildcard", () => {
    const result = resolveAllowlistMatchSimple({
      allowFrom: ["*"],
      senderId: "123",
    });
    expect(result).toEqual({ allowed: true, matchKey: "*", matchSource: "wildcard" });
  });

  it("matches exact sender id", () => {
    const result = resolveAllowlistMatchSimple({
      allowFrom: ["123"],
      senderId: "123",
    });
    expect(result).toEqual({ allowed: true, matchKey: "123", matchSource: "id" });
  });

  it("rejects when no match", () => {
    const result = resolveAllowlistMatchSimple({
      allowFrom: ["456"],
      senderId: "123",
    });
    expect(result).toEqual({ allowed: false });
  });

  it("matches domain pattern against sender email", () => {
    const result = resolveAllowlistMatchSimple({
      allowFrom: ["@example.com"],
      senderId: "123",
      senderEmail: "jane@example.com",
    });
    expect(result).toEqual({ allowed: true, matchKey: "@example.com", matchSource: "domain" });
  });

  it("matches domain pattern case-insensitively", () => {
    const result = resolveAllowlistMatchSimple({
      allowFrom: ["@Example.COM"],
      senderId: "123",
      senderEmail: "Jane@example.com",
    });
    expect(result).toEqual({ allowed: true, matchKey: "@example.com", matchSource: "domain" });
  });

  it("rejects domain pattern when email does not match", () => {
    const result = resolveAllowlistMatchSimple({
      allowFrom: ["@example.com"],
      senderId: "123",
      senderEmail: "jane@other.com",
    });
    expect(result).toEqual({ allowed: false });
  });

  it("rejects domain pattern when no email provided", () => {
    const result = resolveAllowlistMatchSimple({
      allowFrom: ["@example.com"],
      senderId: "123",
    });
    expect(result).toEqual({ allowed: false });
  });

  it("prefers wildcard over domain match", () => {
    const result = resolveAllowlistMatchSimple({
      allowFrom: ["*", "@example.com"],
      senderId: "123",
      senderEmail: "jane@example.com",
    });
    expect(result.matchSource).toBe("wildcard");
  });

  it("prefers domain match over id match", () => {
    const result = resolveAllowlistMatchSimple({
      allowFrom: ["@example.com", "123"],
      senderId: "123",
      senderEmail: "jane@example.com",
    });
    expect(result.matchSource).toBe("domain");
  });
});
