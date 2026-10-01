// Covers silent-reply config normalization and policy behavior.
import { describe, expect, it } from "vitest";
import { resolveSilentReplySettings } from "./silent-reply.js";
import type { OpenClawConfig } from "./types.openclaw.js";

describe("silent reply config resolution", () => {
  it("requires a reply by default for every conversation type", () => {
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
    ).toBe("disallow");
  });

  it("applies configured group defaults only to group conversations", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          silentReply: {
            group: "allow",
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
    expect(resolveSilentReplySettings({ cfg, sessionKey: "agent:main:subagent:abc" }).policy).toBe(
      "disallow",
    );
  });

  it("lets surface overrides beat the default policy", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          silentReply: {
            group: "allow",
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
