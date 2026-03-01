import { describe, expect, it } from "vitest";
import {
  buildExecApprovalCallbackData,
  extractTelegramChatId,
  parseExecApprovalCallbackData,
} from "./exec-approvals.js";

describe("buildExecApprovalCallbackData", () => {
  it("encodes allow-once decision", () => {
    const result = buildExecApprovalCallbackData(
      "550e8400-e29b-41d4-a716-446655440000",
      "allow-once",
    );
    expect(result).toBe("ea:550e8400-e29b-41d4-a716-446655440000:ao");
  });

  it("encodes allow-always decision", () => {
    const result = buildExecApprovalCallbackData(
      "550e8400-e29b-41d4-a716-446655440000",
      "allow-always",
    );
    expect(result).toBe("ea:550e8400-e29b-41d4-a716-446655440000:aa");
  });

  it("encodes deny decision", () => {
    const result = buildExecApprovalCallbackData("550e8400-e29b-41d4-a716-446655440000", "deny");
    expect(result).toBe("ea:550e8400-e29b-41d4-a716-446655440000:dn");
  });

  it("produces callback_data under 64 bytes", () => {
    const longUuid = "550e8400-e29b-41d4-a716-446655440000";
    const result = buildExecApprovalCallbackData(longUuid, "allow-always");
    expect(result.length).toBeLessThanOrEqual(64);
  });
});

describe("parseExecApprovalCallbackData", () => {
  it("parses allow-once", () => {
    const result = parseExecApprovalCallbackData("ea:550e8400-e29b-41d4-a716-446655440000:ao");
    expect(result).toEqual({
      approvalId: "550e8400-e29b-41d4-a716-446655440000",
      action: "allow-once",
    });
  });

  it("parses allow-always", () => {
    const result = parseExecApprovalCallbackData("ea:550e8400-e29b-41d4-a716-446655440000:aa");
    expect(result).toEqual({
      approvalId: "550e8400-e29b-41d4-a716-446655440000",
      action: "allow-always",
    });
  });

  it("parses deny", () => {
    const result = parseExecApprovalCallbackData("ea:550e8400-e29b-41d4-a716-446655440000:dn");
    expect(result).toEqual({
      approvalId: "550e8400-e29b-41d4-a716-446655440000",
      action: "deny",
    });
  });

  it("returns null for invalid prefix", () => {
    const result = parseExecApprovalCallbackData("invalid:550e8400-e29b-41d4-a716-446655440000:ao");
    expect(result).toBeNull();
  });

  it("returns null for invalid decision code", () => {
    const result = parseExecApprovalCallbackData("ea:550e8400-e29b-41d4-a716-446655440000:xx");
    expect(result).toBeNull();
  });

  it("returns null for malformed data", () => {
    expect(parseExecApprovalCallbackData("ea:invalid")).toBeNull();
    expect(parseExecApprovalCallbackData("")).toBeNull();
    expect(parseExecApprovalCallbackData("ea:")).toBeNull();
  });

  it("round-trips encoding and decoding", () => {
    const approvalId = "550e8400-e29b-41d4-a716-446655440000";
    const decisions = ["allow-once", "allow-always", "deny"] as const;
    for (const decision of decisions) {
      const encoded = buildExecApprovalCallbackData(approvalId, decision);
      const decoded = parseExecApprovalCallbackData(encoded);
      expect(decoded).toEqual({ approvalId, action: decision });
    }
  });
});

describe("extractTelegramChatId", () => {
  it("extracts chatId from dm session key", () => {
    const result = extractTelegramChatId("agent:main:telegram:dm:123456789");
    expect(result).toBe("123456789");
  });

  it("extracts chatId from group session key", () => {
    const result = extractTelegramChatId("agent:main:telegram:group:987654321");
    expect(result).toBe("987654321");
  });

  it("extracts chatId from channel session key", () => {
    const result = extractTelegramChatId("agent:main:telegram:channel:111222333");
    expect(result).toBe("111222333");
  });

  it("returns null for non-telegram session key", () => {
    expect(extractTelegramChatId("agent:main:discord:channel:123456789")).toBeNull();
  });

  it("returns null for malformed session key", () => {
    expect(extractTelegramChatId("agent:main:telegram")).toBeNull();
    expect(extractTelegramChatId("telegram:123456789")).toBeNull();
  });

  it("returns null for null/undefined input", () => {
    expect(extractTelegramChatId(null)).toBeNull();
    expect(extractTelegramChatId(undefined)).toBeNull();
  });
});
