import { describe, expect, it } from "vitest";
import { resolveRunTypingPolicy } from "./typing-policy.js";

describe("resolveRunTypingPolicy", () => {
  it.each([
    {
      name: "forces heartbeat policy for heartbeat runs",
      input: { requestedPolicy: "user_message", isHeartbeat: true },
      typingPolicy: "heartbeat",
      suppressTyping: true,
    },
    {
      name: "forces internal webchat policy",
      input: { requestedPolicy: "user_message", originatingChannel: "webchat" },
      typingPolicy: "internal_webchat",
      suppressTyping: true,
    },
    {
      name: "forces system event policy for routed turns",
      input: {
        requestedPolicy: "user_message",
        systemEvent: true,
        originatingChannel: "quietchat",
      },
      typingPolicy: "system_event",
      suppressTyping: true,
    },
    {
      name: "preserves requested policy for regular user turns",
      input: { requestedPolicy: "user_message", originatingChannel: "quietchat" },
      typingPolicy: "user_message",
      suppressTyping: false,
    },
    {
      name: "respects explicit suppressTyping",
      input: { requestedPolicy: "auto", originatingChannel: "quietchat", suppressTyping: true },
      typingPolicy: "auto",
      suppressTyping: true,
    },
  ] as const)("$name", ({ input, typingPolicy, suppressTyping }) => {
    expect(resolveRunTypingPolicy(input)).toEqual({ typingPolicy, suppressTyping });
  });
});
