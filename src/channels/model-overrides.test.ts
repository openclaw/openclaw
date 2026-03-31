import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveChannelModelOverride } from "./model-overrides.js";

describe("resolveChannelModelOverride", () => {
  it.each([
    {
      name: "matches parent group id when topic suffix is present",
      input: {
        cfg: {
          channels: {
            modelByChannel: {
              telegram: {
                "-100123": "demo-provider/demo-parent-model",
              },
            },
          },
        } as unknown as OpenClawConfig,
        channel: "telegram",
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
              telegram: {
                "-100123": "demo-provider/demo-parent-model",
                "-100123:topic:99": "demo-provider/demo-topic-model",
              },
            },
          },
        } as unknown as OpenClawConfig,
        channel: "telegram",
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
    {
      name: "preserves feishu topic ids for direct matches",
      input: {
        cfg: {
          channels: {
            modelByChannel: {
              feishu: {
                "oc_group_chat:topic:om_topic_root": "demo-provider/demo-feishu-topic-model",
              },
            },
          },
        } as unknown as OpenClawConfig,
        channel: "feishu",
        groupId: "oc_group_chat:topic:om_topic_root",
      },
      expected: {
        model: "demo-provider/demo-feishu-topic-model",
        matchKey: "oc_group_chat:topic:om_topic_root",
      },
    },
    {
      name: "preserves feishu topic ids when falling back from parent session key",
      input: {
        cfg: {
          channels: {
            modelByChannel: {
              feishu: {
                "oc_group_chat:topic:om_topic_root": "demo-provider/demo-feishu-topic-model",
              },
            },
          },
        } as unknown as OpenClawConfig,
        channel: "feishu",
        groupId: "unrelated",
        parentSessionKey:
          "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      },
      expected: {
        model: "demo-provider/demo-feishu-topic-model",
        matchKey: "oc_group_chat:topic:om_topic_root",
      },
    },
  ] as const)("$name", ({ input, expected }) => {
    const resolved = resolveChannelModelOverride(input);
    expect(resolved?.model).toBe(expected.model);
    expect(resolved?.matchKey).toBe(expected.matchKey);
  });
});
