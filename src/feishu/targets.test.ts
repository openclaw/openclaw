import { describe, it, expect } from "vitest";
import {
  detectIdType,
  normalizeFeishuTarget,
  formatFeishuTarget,
  resolveReceiveIdType,
  looksLikeFeishuId,
} from "./targets.js";

describe("detectIdType", () => {
  it("detects chat_id", () => expect(detectIdType("oc_abc123")).toBe("chat_id"));
  it("detects open_id", () => expect(detectIdType("ou_xyz789")).toBe("open_id"));
  it("detects user_id", () => expect(detectIdType("some_user")).toBe("user_id"));
  it("returns null for empty string", () => expect(detectIdType("  ")).toBeNull());
});

describe("normalizeFeishuTarget", () => {
  it("strips chat: prefix", () => expect(normalizeFeishuTarget("chat:oc_abc")).toBe("oc_abc"));
  it("strips user: prefix", () => expect(normalizeFeishuTarget("user:ou_abc")).toBe("ou_abc"));
  it("strips open_id: prefix", () => expect(normalizeFeishuTarget("open_id:ou_x")).toBe("ou_x"));
  it("returns bare id unchanged", () => expect(normalizeFeishuTarget("oc_abc")).toBe("oc_abc"));
  it("returns null for empty", () => expect(normalizeFeishuTarget("  ")).toBeNull());
  it("is case-insensitive on prefix", () =>
    expect(normalizeFeishuTarget("Chat:oc_x")).toBe("oc_x"));
});

describe("formatFeishuTarget", () => {
  it("formats chat_id as chat:...", () => expect(formatFeishuTarget("oc_abc")).toBe("chat:oc_abc"));
  it("formats open_id as user:...", () => expect(formatFeishuTarget("ou_abc")).toBe("user:ou_abc"));
  it("uses explicit type override", () =>
    expect(formatFeishuTarget("custom", "chat_id")).toBe("chat:custom"));
  it("returns raw for unknown type", () => expect(formatFeishuTarget("abc123")).toBe("abc123"));
});

describe("resolveReceiveIdType", () => {
  it("returns chat_id for oc_ prefix", () =>
    expect(resolveReceiveIdType("oc_abc")).toBe("chat_id"));
  it("returns open_id for ou_ prefix", () =>
    expect(resolveReceiveIdType("ou_abc")).toBe("open_id"));
  it("returns user_id otherwise", () => expect(resolveReceiveIdType("custom_id")).toBe("user_id"));
});

describe("looksLikeFeishuId", () => {
  it("matches chat: prefix", () => expect(looksLikeFeishuId("chat:oc_abc")).toBe(true));
  it("matches user: prefix", () => expect(looksLikeFeishuId("user:ou_abc")).toBe(true));
  it("matches oc_ prefix", () => expect(looksLikeFeishuId("oc_abc")).toBe(true));
  it("matches ou_ prefix", () => expect(looksLikeFeishuId("ou_abc")).toBe(true));
  it("rejects random string", () => expect(looksLikeFeishuId("hello")).toBe(false));
  it("rejects empty", () => expect(looksLikeFeishuId("  ")).toBe(false));
});
