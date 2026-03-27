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
              "demo-group": {
                "-100123": "demo-provider/demo-parent-model",
              },
            },
          },
        } as unknown as OpenClawConfig,
        channel: "demo-group",
        groupId: "-100123:topic:99",
      },
      expected: { model: "demo-provider/demo-parent-model", matchKey: "-100123" },
    },
    {
      name: "prefers topic-specific match over parent group id",
      input: {
        cfg: {
          channels: {
            modelByChannel: {
              "demo-group": {
                "-100123": "demo-provider/demo-parent-model",
                "-100123:topic:99": "demo-provider/demo-topic-model",
              },
            },
          },
        } as unknown as OpenClawConfig,
        channel: "demo-group",
        groupId: "-100123:topic:99",
      },
      expected: { model: "demo-provider/demo-topic-model", matchKey: "-100123:topic:99" },
    },
    {
      name: "falls back to parent session key when thread id does not match",
      input: {
        cfg: {
          channels: {
            modelByChannel: {
              "demo-thread": {
                "123": "demo-provider/demo-parent-model",
              },
            },
          },
        } as unknown as OpenClawConfig,
        channel: "demo-thread",
        groupId: "999",
        parentSessionKey: "agent:main:demo-thread:channel:123:thread:456",
      },
      expected: { model: "demo-provider/demo-parent-model", matchKey: "123" },
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
