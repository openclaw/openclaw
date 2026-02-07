import { describe, expect, it } from "vitest";
import type { MsgContext } from "../templating.js";
import { buildInboundDedupeKey } from "./inbound-dedupe.js";

describe("buildInboundDedupeKey", () => {
  it("returns null when provider is missing", () => {
    expect(buildInboundDedupeKey({ MessageSid: "m1", To: "chat1" } as MsgContext)).toBeNull();
  });

  it("returns null when messageId is missing", () => {
    expect(buildInboundDedupeKey({ Provider: "telegram", To: "chat1" } as MsgContext)).toBeNull();
  });

  it("returns null when peerId is missing", () => {
    expect(
      buildInboundDedupeKey({ Provider: "telegram", MessageSid: "m1" } as MsgContext),
    ).toBeNull();
  });

  it("builds key with minimal fields", () => {
    const key = buildInboundDedupeKey({
      Provider: "telegram",
      MessageSid: "msg123",
      To: "chat1",
    } as MsgContext);
    expect(key).toBeTruthy();
    expect(key).toContain("telegram");
    expect(key).toContain("msg123");
    expect(key).toContain("chat1");
  });

  it("includes account and session in key", () => {
    const key = buildInboundDedupeKey({
      Provider: "telegram",
      MessageSid: "m1",
      To: "chat1",
      AccountId: "acct1",
      SessionKey: "sess1",
    } as MsgContext);
    expect(key).toContain("acct1");
    expect(key).toContain("sess1");
  });

  it("includes thread ID when present", () => {
    const key = buildInboundDedupeKey({
      Provider: "telegram",
      MessageSid: "m1",
      To: "chat1",
      MessageThreadId: 42,
    } as MsgContext);
    expect(key).toContain("42");
  });

  it("prefers OriginatingChannel over Provider", () => {
    const key = buildInboundDedupeKey({
      Provider: "telegram",
      OriginatingChannel: "discord",
      MessageSid: "m1",
      To: "chat1",
    } as MsgContext);
    expect(key).toContain("discord");
  });

  it("prefers OriginatingTo as peerId", () => {
    const key = buildInboundDedupeKey({
      Provider: "slack",
      MessageSid: "m1",
      To: "chat1",
      OriginatingTo: "orig-dest",
    } as MsgContext);
    expect(key).toContain("orig-dest");
  });

  it("normalizes provider to lowercase", () => {
    const key = buildInboundDedupeKey({
      Provider: "TELEGRAM",
      MessageSid: "m1",
      To: "chat1",
    } as MsgContext);
    expect(key).toContain("telegram");
    expect(key).not.toContain("TELEGRAM");
  });
});
