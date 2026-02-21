import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveChannelModelOverride } from "./model-overrides.js";

describe("resolveChannelModelOverride", () => {
  it("matches parent group id when topic suffix is present", () => {
    const cfg = {
      channels: {
        modelByChannel: {
          telegram: {
            "-100123": "openai/gpt-4.1",
          },
        },
      },
    } as unknown as OpenClawConfig;
    const resolved = resolveChannelModelOverride({
      cfg,
      channel: "telegram",
      groupId: "-100123:topic:99",
    });

    expect(resolved?.model).toBe("openai/gpt-4.1");
    expect(resolved?.matchKey).toBe("-100123");
  });

  it("prefers topic-specific match over parent group id", () => {
    const cfg = {
      channels: {
        modelByChannel: {
          telegram: {
            "-100123": "openai/gpt-4.1",
            "-100123:topic:99": "anthropic/claude-sonnet-4-6",
          },
        },
      },
    } as unknown as OpenClawConfig;
    const resolved = resolveChannelModelOverride({
      cfg,
      channel: "telegram",
      groupId: "-100123:topic:99",
    });

    expect(resolved?.model).toBe("anthropic/claude-sonnet-4-6");
    expect(resolved?.matchKey).toBe("-100123:topic:99");
  });

  it("falls back to parent session key when thread id does not match", () => {
    const cfg = {
      channels: {
        modelByChannel: {
          discord: {
            "123": "openai/gpt-4.1",
          },
        },
      },
    } as unknown as OpenClawConfig;
    const resolved = resolveChannelModelOverride({
      cfg,
      channel: "discord",
      groupId: "999",
      parentSessionKey: "agent:main:discord:channel:123:thread:456",
    });

    expect(resolved?.model).toBe("openai/gpt-4.1");
    expect(resolved?.matchKey).toBe("123");
  });
});
