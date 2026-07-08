import { describe, expect, it } from "vitest";
import {
  CONVERSATION_READ_POLICY_V1,
  normalizeConversationReadInvocationOrigin,
  supportsConversationReadPolicyV1,
} from "./conversation-read-origin.js";

describe("normalizeConversationReadInvocationOrigin", () => {
  it.each([
    [undefined, "delegated"],
    [null, "delegated"],
    ["delegated", "delegated"],
    ["DIRECT-OPERATOR", "delegated"],
    ["unknown", "delegated"],
    [{}, "delegated"],
    ["direct-operator", "direct-operator"],
  ] as const)("normalizes %j to %s", (value, expected) => {
    expect(normalizeConversationReadInvocationOrigin(value)).toBe(expected);
  });
});

describe("supportsConversationReadPolicyV1", () => {
  it.each([
    [CONVERSATION_READ_POLICY_V1, true],
    [undefined, false],
    ["unknown", false],
  ])("normalizes %j to %s", (value, expected) => {
    expect(supportsConversationReadPolicyV1(value)).toBe(expected);
  });
});
