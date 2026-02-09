import { describe, expect, it } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import { validateSenderIdentity } from "./sender-identity.js";

describe("validateSenderIdentity", () => {
  it("allows direct messages without sender fields", () => {
    const ctx: MsgContext = { ChatType: "direct" };
    expect(validateSenderIdentity(ctx)).toEqual([]);
  });

  it("requires some sender identity for non-direct chats", () => {
    const ctx: MsgContext = { ChatType: "group" };
    expect(validateSenderIdentity(ctx)).toContain(
      "missing sender identity (SenderId/SenderName/SenderUsername/SenderE164)",
    );
  });

  it("validates SenderE164 and SenderUsername shape", () => {
    const ctx: MsgContext = {
      ChatType: "group",
      SenderE164: "123",
      SenderUsername: "@ada lovelace",
    };
    expect(validateSenderIdentity(ctx)).toEqual([
      "invalid SenderE164: 123",
      'SenderUsername should not include "@": @ada lovelace',
      "SenderUsername should not include whitespace: @ada lovelace",
    ]);
  });
});
