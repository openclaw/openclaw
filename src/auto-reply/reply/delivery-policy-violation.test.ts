import { describe, expect, it } from "vitest";
import {
  evaluateDeliveryPolicyViolation,
  formatDeliveryPolicyViolationLog,
} from "./delivery-policy-violation.js";

describe("evaluateDeliveryPolicyViolation", () => {
  const baseParams = {
    suppressDelivery: true,
    sendPolicyDenied: false,
    sourceReplyDeliveryMode: "message_tool_only" as const,
  };

  it("flags substantive final text suppressed under message_tool_only (regression: #80647)", () => {
    const violation = evaluateDeliveryPolicyViolation({
      ...baseParams,
      reply: { text: "Here is the summary of what I did..." },
    });
    expect(violation).toStrictEqual({
      reason: "suppressed-final-text-under-message-tool-only",
      sourceReplyDeliveryMode: "message_tool_only",
      finalTextLength: "Here is the summary of what I did...".length,
    });
  });

  it("does not flag when delivery is not suppressed", () => {
    const violation = evaluateDeliveryPolicyViolation({
      ...baseParams,
      suppressDelivery: false,
      reply: { text: "anything" },
    });
    expect(violation).toBeNull();
  });

  it("does not flag sendPolicy deny suppression (explicit operator deny is not a policy violation)", () => {
    const violation = evaluateDeliveryPolicyViolation({
      ...baseParams,
      sendPolicyDenied: true,
      reply: { text: "anything" },
    });
    expect(violation).toBeNull();
  });

  it("does not flag automatic mode (no tool-only contract to violate)", () => {
    const violation = evaluateDeliveryPolicyViolation({
      ...baseParams,
      sourceReplyDeliveryMode: "automatic",
      reply: { text: "anything" },
    });
    expect(violation).toBeNull();
  });

  it("does not flag empty or whitespace-only final text", () => {
    expect(evaluateDeliveryPolicyViolation({ ...baseParams, reply: { text: "" } })).toBeNull();
    expect(
      evaluateDeliveryPolicyViolation({ ...baseParams, reply: { text: "   \n\t  " } }),
    ).toBeNull();
    expect(evaluateDeliveryPolicyViolation({ ...baseParams, reply: {} })).toBeNull();
  });

  it("does not flag reasoning payloads or compaction notices", () => {
    expect(
      evaluateDeliveryPolicyViolation({
        ...baseParams,
        reply: { text: "thinking...", isReasoning: true },
      }),
    ).toBeNull();
    expect(
      evaluateDeliveryPolicyViolation({
        ...baseParams,
        reply: { text: "compacting...", isCompactionNotice: true },
      }),
    ).toBeNull();
  });

  it("trims whitespace when measuring finalTextLength", () => {
    const violation = evaluateDeliveryPolicyViolation({
      ...baseParams,
      reply: { text: "  hello  " },
    });
    expect(violation?.finalTextLength).toBe("hello".length);
  });
});

describe("formatDeliveryPolicyViolationLog", () => {
  it("emits a structured, grep-friendly line", () => {
    const line = formatDeliveryPolicyViolationLog({
      violation: {
        reason: "suppressed-final-text-under-message-tool-only",
        sourceReplyDeliveryMode: "message_tool_only",
        finalTextLength: 137,
      },
      channel: "telegram",
      sessionKey: "agent:main:main:thread:-1003669328703:2",
    });
    expect(line).toBe(
      "delivery-policy-violation: suppressed-final-text-under-message-tool-only" +
        " channel=telegram" +
        " session=agent:main:main:thread:-1003669328703:2" +
        " sourceReplyDeliveryMode=message_tool_only" +
        " finalTextLength=137",
    );
  });

  it("falls back to unknown for missing channel/session", () => {
    const line = formatDeliveryPolicyViolationLog({
      violation: {
        reason: "suppressed-final-text-under-message-tool-only",
        sourceReplyDeliveryMode: "message_tool_only",
        finalTextLength: 1,
      },
      channel: undefined,
      sessionKey: undefined,
    });
    expect(line).toContain("channel=unknown");
    expect(line).toContain("session=unknown");
  });
});
