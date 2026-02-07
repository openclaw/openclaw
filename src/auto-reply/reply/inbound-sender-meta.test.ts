import { describe, expect, it } from "vitest";
import type { MsgContext } from "../templating.js";
import { formatInboundBodyWithSenderMeta } from "./inbound-sender-meta.js";

describe("formatInboundBodyWithSenderMeta", () => {
  it("returns empty body unchanged", () => {
    const ctx = { ChatType: "group", SenderName: "Alice" } as MsgContext;
    expect(formatInboundBodyWithSenderMeta({ body: "", ctx })).toBe("");
  });

  it("returns body unchanged for direct chat", () => {
    const ctx = { ChatType: "direct", SenderName: "Alice" } as MsgContext;
    expect(formatInboundBodyWithSenderMeta({ body: "hello", ctx })).toBe("hello");
  });

  it("returns body unchanged when no chat type", () => {
    const ctx = {} as MsgContext;
    expect(formatInboundBodyWithSenderMeta({ body: "hello", ctx })).toBe("hello");
  });

  it("appends sender meta for group chat", () => {
    const ctx = {
      ChatType: "group",
      SenderName: "Alice",
    } as MsgContext;
    const result = formatInboundBodyWithSenderMeta({ body: "hello", ctx });
    expect(result).toContain("[from: Alice]");
  });

  it("returns body unchanged when no sender label available", () => {
    const ctx = { ChatType: "group" } as MsgContext;
    expect(formatInboundBodyWithSenderMeta({ body: "hello", ctx })).toBe("hello");
  });

  it("does not duplicate [from:] if already present", () => {
    const ctx = {
      ChatType: "group",
      SenderName: "Alice",
    } as MsgContext;
    const body = "hello\n[from: Alice]";
    expect(formatInboundBodyWithSenderMeta({ body, ctx })).toBe(body);
  });

  it("detects sender prefix in envelope format", () => {
    const ctx = {
      ChatType: "group",
      SenderName: "Bob",
    } as MsgContext;
    const body = "[Signal Group] Bob: hello";
    expect(formatInboundBodyWithSenderMeta({ body, ctx })).toBe(body);
  });
});
