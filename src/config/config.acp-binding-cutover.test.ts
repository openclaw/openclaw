import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("ACP binding cutover schema", () => {
  it("accepts top-level typed ACP bindings with per-agent runtime defaults", () => {
    const parsed = OpenClawSchema.safeParse({
      agents: {
        list: [
          { id: "main", default: true, runtime: { type: "embedded" } },
          {
            id: "coding",
            runtime: {
              type: "acp",
              acp: {
                agent: "codex",
                backend: "acpx",
                mode: "persistent",
                cwd: "/workspace/openclaw",
              },
            },
          },
        ],
      },
      bindings: [
        {
          type: "route",
          agentId: "main",
          match: { channel: "discord", accountId: "default" },
        },
        {
          type: "acp",
          agentId: "coding",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "channel", id: "1478836151241412759" },
          },
          acp: {
            label: "codex-main",
            backend: "acpx",
          },
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects legacy Discord channel-local ACP binding fields", () => {
    const parsed = OpenClawSchema.safeParse({
      channels: {
        discord: {
          guilds: {
            "1459246755253325866": {
              channels: {
                "1478836151241412759": {
                  bindings: {
                    acp: {
                      agentId: "codex",
                      mode: "persistent",
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects legacy Telegram topic-local ACP binding fields", () => {
    const parsed = OpenClawSchema.safeParse({
      channels: {
        telegram: {
          groups: {
            "-1001234567890": {
              topics: {
                "42": {
                  bindings: {
                    acp: {
                      agentId: "codex",
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects ACP bindings without a peer conversation target", () => {
    const parsed = OpenClawSchema.safeParse({
      bindings: [
        {
          type: "acp",
          agentId: "codex",
          match: { channel: "discord", accountId: "default" },
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects ACP bindings on unsupported channels", () => {
    const parsed = OpenClawSchema.safeParse({
      bindings: [
        {
          type: "acp",
          agentId: "codex",
          match: {
            channel: "slack",
            accountId: "default",
            peer: { kind: "channel", id: "C123456" },
          },
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects non-canonical Telegram ACP topic peer IDs", () => {
    const parsed = OpenClawSchema.safeParse({
      bindings: [
        {
          type: "acp",
          agentId: "codex",
          match: {
            channel: "telegram",
            accountId: "default",
            peer: { kind: "group", id: "42" },
          },
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });
});
