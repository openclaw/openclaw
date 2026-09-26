// Covers silent-reply config normalization and policy behavior.
import { describe, expect, it } from "vitest";
import { resolveSilentReplySettings } from "./silent-reply.js";
import type { OpenClawConfig } from "./types.openclaw.js";

describe("silent reply config resolution", () => {
  it("uses the default direct/group/internal policy", () => {
    expect(resolveSilentReplySettings({ surface: "webchat" }).policy).toBe("disallow");
    expect(
      resolveSilentReplySettings({
        sessionKey: "agent:main:telegram:group:123",
        surface: "telegram",
      }).policy,
    ).toBe("disallow");
    expect(
      resolveSilentReplySettings({
        sessionKey: "agent:main:subagent:abc",
      }).policy,
    ).toBe("allow");
  });

  it("applies configured defaults by conversation type", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          silentReply: {
            group: "allow",
            internal: "disallow",
          },
        },
      },
    };

    expect(resolveSilentReplySettings({ cfg, surface: "webchat" }).policy).toBe("disallow");
    expect(
      resolveSilentReplySettings({
        cfg,
        sessionKey: "agent:main:discord:group:123",
        surface: "discord",
      }).policy,
    ).toBe("allow");
    expect(
      resolveSilentReplySettings({
        cfg,
        sessionKey: "agent:main:subagent:abc",
      }).policy,
    ).toBe("disallow");
  });

  it("lets surface overrides beat the default policy", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          silentReply: {
            group: "allow",
            internal: "allow",
          },
        },
      },
      surfaces: {
        telegram: {
          silentReply: {
            group: "disallow",
          },
        },
      },
    };

    expect(
      resolveSilentReplySettings({
        cfg,
        sessionKey: "agent:main:telegram:group:123",
        surface: "telegram",
      }).policy,
    ).toBe("disallow");
  });
});
