import { describe, expect, it } from "vitest";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { isStrandedMessageToolReply } from "./stranded-source-reply.js";

const base = {
  sourceReplyDeliveryMode: "message_tool_only" as const,
  sendPolicyDenied: false,
  successfulSideEffectDelivery: false,
  finalText: "Here is the answer the user asked for.",
};

describe("isStrandedMessageToolReply", () => {
  it("flags a real final reply that was never delivered via the message tool (#85714)", () => {
    expect(isStrandedMessageToolReply(base)).toBe(true);
  });

  it("does not flag automatic delivery mode (final text is delivered normally)", () => {
    expect(isStrandedMessageToolReply({ ...base, sourceReplyDeliveryMode: "automatic" })).toBe(
      false,
    );
    expect(isStrandedMessageToolReply({ ...base, sourceReplyDeliveryMode: undefined })).toBe(false);
  });

  it("does not flag when the message tool already delivered this turn", () => {
    expect(isStrandedMessageToolReply({ ...base, successfulSideEffectDelivery: true })).toBe(false);
  });

  it("does not flag the silent sentinel (intentional silence)", () => {
    expect(isStrandedMessageToolReply({ ...base, finalText: SILENT_REPLY_TOKEN })).toBe(false);
    expect(isStrandedMessageToolReply({ ...base, finalText: `  ${SILENT_REPLY_TOKEN}  ` })).toBe(
      false,
    );
  });

  it("does not flag empty or whitespace-only final text", () => {
    expect(isStrandedMessageToolReply({ ...base, finalText: "" })).toBe(false);
    expect(isStrandedMessageToolReply({ ...base, finalText: "   \n " })).toBe(false);
  });

  it("does not flag when delivery was intentionally denied by send policy", () => {
    expect(isStrandedMessageToolReply({ ...base, sendPolicyDenied: true })).toBe(false);
  });
});
