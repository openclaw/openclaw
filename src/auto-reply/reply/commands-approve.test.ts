import { describe, expect, it } from "vitest";
import { extractApprovalIdFromReplyBody, parseApproveCommand } from "./commands-approve.js";

describe("parseApproveCommand", () => {
  it("returns null for non-approve commands", () => {
    expect(parseApproveCommand("/status")).toBeNull();
    expect(parseApproveCommand("hello")).toBeNull();
  });

  it("parses /approve <id> <decision>", () => {
    const result = parseApproveCommand("/approve abc-123 allow-once");
    expect(result).toEqual({ ok: true, id: "abc-123", decision: "allow-once" });
  });

  it("parses /approve <decision> <id> (reversed order)", () => {
    const result = parseApproveCommand("/approve deny abc-123");
    expect(result).toEqual({ ok: true, id: "abc-123", decision: "deny" });
  });

  it("parses decision aliases", () => {
    expect(parseApproveCommand("/approve abc once")).toEqual({
      ok: true,
      id: "abc",
      decision: "allow-once",
    });
    expect(parseApproveCommand("/approve abc always")).toEqual({
      ok: true,
      id: "abc",
      decision: "allow-always",
    });
    expect(parseApproveCommand("/approve abc reject")).toEqual({
      ok: true,
      id: "abc",
      decision: "deny",
    });
  });

  it("returns id: null when only decision is provided (for reply-to flow)", () => {
    const result = parseApproveCommand("/approve allow-once");
    expect(result).toEqual({ ok: true, id: null, decision: "allow-once" });
  });

  it("returns id: null for decision aliases as single token", () => {
    expect(parseApproveCommand("/approve once")).toEqual({
      ok: true,
      id: null,
      decision: "allow-once",
    });
    expect(parseApproveCommand("/approve deny")).toEqual({
      ok: true,
      id: null,
      decision: "deny",
    });
    expect(parseApproveCommand("/approve block")).toEqual({
      ok: true,
      id: null,
      decision: "deny",
    });
  });

  it("returns error for single non-decision token", () => {
    const result = parseApproveCommand("/approve some-random-id");
    expect(result).toEqual({
      ok: false,
      error: "Usage: /approve <id> allow-once|allow-always|deny",
    });
  });

  it("returns error for empty /approve", () => {
    const result = parseApproveCommand("/approve");
    expect(result).toEqual({
      ok: false,
      error: "Usage: /approve <id> allow-once|allow-always|deny",
    });
  });

  it("is case-insensitive for decisions", () => {
    expect(parseApproveCommand("/approve ALLOW-ONCE")).toEqual({
      ok: true,
      id: null,
      decision: "allow-once",
    });
    expect(parseApproveCommand("/approve abc DENY")).toEqual({
      ok: true,
      id: "abc",
      decision: "deny",
    });
  });
});

describe("extractApprovalIdFromReplyBody", () => {
  it("extracts UUID from approval request message", () => {
    const body = [
      "🔒 Exec approval required",
      "ID: f0c7503f-30a0-423c-b862-e5e793c7d972",
      "Command: `echo hello`",
      "Reply with: /approve <id> allow-once|allow-always|deny",
    ].join("\n");
    expect(extractApprovalIdFromReplyBody(body)).toBe("f0c7503f-30a0-423c-b862-e5e793c7d972");
  });

  it("extracts ID with varying whitespace", () => {
    expect(extractApprovalIdFromReplyBody("ID:  abc-def-123")).toBe("abc-def-123");
    expect(extractApprovalIdFromReplyBody("ID:abc-def")).toBe("abc-def");
  });

  it("returns null for messages without ID line", () => {
    expect(extractApprovalIdFromReplyBody("No approval here")).toBeNull();
    expect(extractApprovalIdFromReplyBody("")).toBeNull();
    expect(extractApprovalIdFromReplyBody(null)).toBeNull();
    expect(extractApprovalIdFromReplyBody(undefined)).toBeNull();
  });

  it("handles multiline body and finds ID on non-first line", () => {
    const body = "Header line\nID: aaa-bbb-ccc\nFooter";
    expect(extractApprovalIdFromReplyBody(body)).toBe("aaa-bbb-ccc");
  });

  it("is case-insensitive for the ID label", () => {
    expect(extractApprovalIdFromReplyBody("id: abc-123")).toBe("abc-123");
    expect(extractApprovalIdFromReplyBody("Id: abc-123")).toBe("abc-123");
  });
});
