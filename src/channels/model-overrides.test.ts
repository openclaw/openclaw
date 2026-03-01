import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveChannelModelOverride } from "./model-overrides.js";

describe("resolveChannelModelOverride", () => {
  const cases = [
    {
      name: "matches parent group id when topic suffix is present",
      input: {
        cfg: {
          channels: {
            modelByChannel: {
              telegram: {
                "-100123": "openai/gpt-4.1",
              },
            },
          },
        } as unknown as OpenClawConfig,
        channel: "telegram",
        groupId: "-100123:topic:99",
      },
      expected: { model: "openai/gpt-4.1", matchKey: "-100123" },
    },
    {
      name: "prefers topic-specific match over parent group id",
      input: {
        cfg: {
          channels: {
            modelByChannel: {
              telegram: {
                "-100123": "openai/gpt-4.1",
                "-100123:topic:99": "anthropic/claude-sonnet-4-6",
              },
            },
          },
        } as unknown as OpenClawConfig,
        channel: "telegram",
        groupId: "-100123:topic:99",
      },
      expected: { model: "anthropic/claude-sonnet-4-6", matchKey: "-100123:topic:99" },
    },
    {
      name: "falls back to parent session key when thread id does not match",
      input: {
        cfg: {
          channels: {
            modelByChannel: {
              discord: {
                "123": "openai/gpt-4.1",
              },
            },
          },
        } as unknown as OpenClawConfig,
        channel: "discord",
        groupId: "999",
        parentSessionKey: "agent:main:discord:channel:123:thread:456",
      },
      expected: { model: "openai/gpt-4.1", matchKey: "123" },
    },
    {
      name: "prefers discord guild-scoped key over unscoped channel key",
      input: {
        cfg: {
          channels: {
            modelByChannel: {
              discord: {
                "guild-1:123": "anthropic/claude-sonnet-4-6",
                "123": "openai/gpt-4.1",
              },
            },
          },
        } as unknown as OpenClawConfig,
        channel: "discord",
        groupId: "123",
        groupSpace: "guild-1",
      },
      expected: { model: "anthropic/claude-sonnet-4-6", matchKey: "guild-1:123" },
    },
    {
      name: "matches discord guild-scoped slug keys",
      input: {
        cfg: {
          channels: {
            modelByChannel: {
              discord: {
                "guild-1:general": "openai/gpt-4.1",
              },
            },
          },
        } as unknown as OpenClawConfig,
        channel: "discord",
        groupId: "999",
        groupSpace: "guild-1",
        groupChannel: "#general",
      },
      expected: { model: "openai/gpt-4.1", matchKey: "guild-1:general" },
    },
    {
      name: "prefers account-scoped discord key over shared keys",
      input: {
        cfg: {
          channels: {
            modelByChannel: {
              discord: {
                "work:100:200": "anthropic/claude-sonnet-4-6",
                "100:200": "openai/gpt-4.1",
                "200": "openai/gpt-4.1-mini",
              },
            },
          },
        } as unknown as OpenClawConfig,
        channel: "discord",
        accountId: "work",
        groupId: "200",
        groupSpace: "100",
      },
      expected: { model: "anthropic/claude-sonnet-4-6", matchKey: "work:100:200" },
    },
    {
      name: "matches account-scoped unscoped channel key when guild scope is unavailable",
      input: {
        cfg: {
          channels: {
            modelByChannel: {
              discord: {
                "work:general": "openai/gpt-4.1",
                general: "openai/gpt-4.1-mini",
              },
            },
          },
        } as unknown as OpenClawConfig,
        channel: "discord",
        accountId: "work",
        groupChannel: "#general",
      },
      expected: { model: "openai/gpt-4.1", matchKey: "work:general" },
    },
  ] as const;

  for (const testCase of cases) {
    it(testCase.name, () => {
      const resolved = resolveChannelModelOverride(testCase.input);
      expect(resolved?.model).toBe(testCase.expected.model);
      expect(resolved?.matchKey).toBe(testCase.expected.matchKey);
    });
  }
});
