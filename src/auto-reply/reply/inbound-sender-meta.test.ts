import { describe, expect, it } from "vitest";

import type { MsgContext } from "../templating.js";
import { formatInboundBodyWithSenderMeta } from "./inbound-sender-meta.js";

describe("formatInboundBodyWithSenderMeta", () => {
  it("does nothing for direct messages", () => {
    const ctx: MsgContext = { ChatType: "direct", SenderName: "Alice", SenderId: "A1" };
    expect(formatInboundBodyWithSenderMeta({ ctx, body: "[X] hi" })).toBe("[X] hi");
  });

  it("appends a sender meta line for non-direct messages", () => {
    const ctx: MsgContext = { ChatType: "group", SenderName: "Alice", SenderId: "A1" };
    expect(formatInboundBodyWithSenderMeta({ ctx, body: "[X] hi" })).toBe(
      "[X] hi\n[from: Alice (A1)]",
    );
  });

  it("prefers SenderE164 in the label when present", () => {
    const ctx: MsgContext = {
      ChatType: "group",
      SenderName: "Bob",
      SenderId: "bob@s.whatsapp.net",
      SenderE164: "+222",
    };
    expect(formatInboundBodyWithSenderMeta({ ctx, body: "[X] hi" })).toBe(
      "[X] hi\n[from: Bob (+222)]",
    );
  });

  it("appends with a real newline even if the body contains literal \\\\n", () => {
    const ctx: MsgContext = { ChatType: "group", SenderName: "Bob", SenderId: "+222" };
    expect(formatInboundBodyWithSenderMeta({ ctx, body: "[X] one\\n[X] two" })).toBe(
      "[X] one\\n[X] two\n[from: Bob (+222)]",
    );
  });

  it("does not duplicate a sender meta line when one is already present", () => {
    const ctx: MsgContext = { ChatType: "group", SenderName: "Alice", SenderId: "A1" };
    expect(formatInboundBodyWithSenderMeta({ ctx, body: "[X] hi\n[from: Alice (A1)]" })).toBe(
      "[X] hi\n[from: Alice (A1)]",
    );
  });

  it("does not append when the body already includes a sender prefix", () => {
    const ctx: MsgContext = { ChatType: "group", SenderName: "Alice", SenderId: "A1" };
    expect(formatInboundBodyWithSenderMeta({ ctx, body: "Alice (A1): hi" })).toBe(
      "Alice (A1): hi",
    );
  });
});
