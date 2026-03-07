import { describe, expect, it } from "vitest";
import type { SessionSendPolicyConfig } from "../config/types.base.js";
import { classifyContinuitySource, isContinuityScopeAllowed } from "./scope.js";

describe("classifyContinuitySource", () => {
  it("classifies direct, grouped, and agent-scoped continuity sources", () => {
    expect(classifyContinuitySource()).toBe("main_direct");
    expect(classifyContinuitySource("main")).toBe("main_direct");
    expect(classifyContinuitySource("telegram:direct:alice")).toBe("paired_direct");
    expect(classifyContinuitySource("discord:group:team-room")).toBe("group");
    expect(classifyContinuitySource("slack:channel:eng-updates")).toBe("channel");
    expect(classifyContinuitySource("agent:alpha:discord:direct:bob")).toBe("paired_direct");
    expect(classifyContinuitySource("agent:alpha:discord:work:direct:bob")).toBe("paired_direct");
    expect(classifyContinuitySource("agent:alpha:subagent:task-123")).toBe("channel");
    expect(classifyContinuitySource("agent:main:cron:job-1:run:run-1")).toBe("channel");
  });
});

describe("isContinuityScopeAllowed", () => {
  it("allows everything when no recall scope is configured", () => {
    expect(isContinuityScopeAllowed(undefined, "discord:channel:general")).toBe(true);
  });

  it("matches normalized key prefixes against agent-scoped direct sessions", () => {
    const scope = {
      default: "deny",
      rules: [
        {
          action: "allow",
          match: {
            chatType: "direct",
            channel: "discord",
            keyPrefix: "discord",
          },
        },
      ],
    } satisfies SessionSendPolicyConfig;

    expect(isContinuityScopeAllowed(scope, "agent:alpha:discord:direct:bob")).toBe(true);
    expect(isContinuityScopeAllowed(scope, "agent:alpha:discord:work:direct:bob")).toBe(true);
    expect(isContinuityScopeAllowed(scope, "agent:alpha:discord:group:bob")).toBe(false);
  });

  it("supports raw-key matching and legacy raw keyPrefix rules", () => {
    const rawScope = {
      default: "deny",
      rules: [
        {
          action: "allow",
          match: {
            chatType: "direct",
            rawKeyPrefix: "agent:alpha:",
          },
        },
      ],
    } satisfies SessionSendPolicyConfig;
    const legacyScope = {
      default: "deny",
      rules: [
        {
          action: "allow",
          match: {
            chatType: "direct",
            keyPrefix: "agent:alpha:discord:direct",
          },
        },
      ],
    } satisfies SessionSendPolicyConfig;

    expect(isContinuityScopeAllowed(rawScope, "agent:alpha:discord:direct:bob")).toBe(true);
    expect(isContinuityScopeAllowed(rawScope, "agent:beta:discord:direct:bob")).toBe(false);
    expect(isContinuityScopeAllowed(legacyScope, "agent:alpha:discord:direct:bob")).toBe(true);
    expect(isContinuityScopeAllowed(legacyScope, "agent:beta:discord:direct:bob")).toBe(false);
  });

  it("falls back to the default action when subagent sessions cannot be normalized", () => {
    const scope = {
      default: "deny",
      rules: [
        {
          action: "allow",
          match: {
            chatType: "direct",
          },
        },
      ],
    } satisfies SessionSendPolicyConfig;

    expect(isContinuityScopeAllowed(scope, "agent:alpha:subagent:task-123")).toBe(false);
    expect(
      isContinuityScopeAllowed(
        {
          default: "allow",
          rules: [],
        },
        "agent:alpha:subagent:task-123",
      ),
    ).toBe(true);
  });

  it("does not match unknown internal session keys as direct", () => {
    const scope = {
      default: "deny",
      rules: [
        {
          action: "allow",
          match: {
            chatType: "direct",
          },
        },
      ],
    } satisfies SessionSendPolicyConfig;

    expect(isContinuityScopeAllowed(scope, "agent:main:cron:job-1:run:run-1")).toBe(false);
  });

  it("skips empty rules and handles legacy group and channel session formats", () => {
    const scope = {
      default: "deny",
      rules: [
        undefined,
        {
          action: "allow",
          match: {
            keyPrefix: "discord:owner:direct",
          },
        },
      ],
    } as unknown as SessionSendPolicyConfig;

    expect(isContinuityScopeAllowed(scope, "discord:owner:group:team-room")).toBe(false);
    expect(isContinuityScopeAllowed(scope, "discord:owner:channel:ops")).toBe(false);
    expect(isContinuityScopeAllowed(scope, "   ")).toBe(false);
  });
});
