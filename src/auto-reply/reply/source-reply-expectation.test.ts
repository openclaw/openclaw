import { describe, expect, it } from "vitest";
import type { MsgContext } from "../templating.js";
import { resolveSourceReplyExpectation } from "./source-reply-delivery-mode.js";

const ctx: MsgContext = {
  ChatType: "channel",
  Provider: "slack",
  WasMentioned: true,
  MentionSource: "implicit_thread",
};

describe("implicit thread reply expectation", () => {
  it.each([
    { policy: "allow", overrides: {}, expected: "optional" },
    { policy: "disallow", overrides: {}, expected: "required" },
    { policy: undefined, overrides: {}, expected: "required" },
    { policy: "allow", overrides: { MentionSource: "explicit_bot" }, expected: "required" },
    { policy: "allow", overrides: { MentionSource: undefined }, expected: "required" },
    { policy: "allow", overrides: { CommandSource: "native" }, expected: "required" },
    { policy: "allow", overrides: { ChatType: "direct" }, expected: "required" },
  ] as const)(
    "selects $expected for $policy with $overrides",
    ({ policy, overrides, expected }) => {
      expect(
        resolveSourceReplyExpectation({
          ctx: { ...ctx, ...overrides },
          cfg: { surfaces: { slack: { silentReply: { group: policy } } } },
        }),
      ).toBe(expected);
    },
  );
});

describe("exec completion reply expectation", () => {
  const exec = { kind: "internal_system", sourceTool: "exec" } as const;
  it.each([
    {
      name: "webchat exec wake",
      turn: { Provider: "webchat", InputProvenance: exec },
      expected: "optional",
    },
    {
      name: "subagent exec wake",
      turn: { Provider: "webchat", SessionKey: "agent:main:subagent:child", InputProvenance: exec },
      expected: "result-required",
    },
    {
      name: "webchat restart recovery",
      turn: {
        Provider: "webchat",
        InputProvenance: { kind: "internal_system", sourceTool: "main_session_restart_recovery" },
      },
      expected: "result-required",
    },
  ] as const)("selects $expected for $name", ({ turn, expected }) => {
    expect(resolveSourceReplyExpectation({ ctx: turn, cfg: {} })).toBe(expected);
  });
});
