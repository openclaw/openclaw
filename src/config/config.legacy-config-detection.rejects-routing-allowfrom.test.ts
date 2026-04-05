import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

function getChannelConfig(config: unknown, provider: string) {
  const channels = (config as { channels?: Record<string, Record<string, unknown>> } | undefined)
    ?.channels;
  return channels?.[provider];
}

describe("legacy config detection", () => {
  it.each([
    {
      name: "routing.allowFrom",
      input: { routing: { allowFrom: ["+15555550123"] } },
      expectedPath: "",
      expectedMessage: '"routing"',
    },
    {
      name: "routing.groupChat.requireMention",
      input: { routing: { groupChat: { requireMention: false } } },
      expectedPath: "",
      expectedMessage: '"routing"',
    },
  ] as const)(
    "rejects legacy routing key: $name",
    ({ input, expectedPath, expectedMessage, name }) => {
      const res = validateConfigObject(input);
      expect(res.ok, name).toBe(false);
      if (!res.ok) {
        expect(res.issues[0]?.path, name).toBe(expectedPath);
        expect(res.issues[0]?.message, name).toContain(expectedMessage);
      }
    },
  );

  it("accepts per-agent tools.elevated overrides", async () => {
    const res = validateConfigObject({
      tools: {
        elevated: {
          allowFrom: { whatsapp: ["+15555550123"] },
        },
      },
      agents: {
        list: [
          {
            id: "work",
            workspace: "~/openclaw-work",
            tools: {
              elevated: {
                enabled: false,
                allowFrom: { whatsapp: ["+15555550123"] },
              },
            },
          },
        ],
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config?.agents?.list?.[0]?.tools?.elevated).toEqual({
        enabled: false,
        allowFrom: { whatsapp: ["+15555550123"] },
      });
    }
  });
  it("rejects telegram.requireMention", async () => {
    const res = validateConfigObject({
      telegram: { requireMention: true },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("");
      expect(res.issues[0]?.message).toContain('"telegram"');
    }
  });
  it("rejects channels.telegram.groupMentionsOnly", async () => {
    const res = validateConfigObject({
      channels: { telegram: { groupMentionsOnly: true } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((issue) => issue.path === "channels.telegram.groupMentionsOnly")).toBe(
        true,
      );
    }
  });
  it("rejects gateway.token", async () => {
    const res = validateConfigObject({
      gateway: { token: "legacy-token" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("gateway");
    }
  });
  it.each(["0.0.0.0", "::", "127.0.0.1", "localhost", "::1"] as const)(
    "flags gateway.bind host alias as legacy: %s",
    (bind) => {
      const validated = validateConfigObject({ gateway: { bind } });
      expect(validated.ok, bind).toBe(false);
      if (!validated.ok) {
        expect(
          validated.issues.some((issue) => issue.path === "gateway.bind"),
          bind,
        ).toBe(true);
      }
    },
  );
  it.each([
    {
      provider: "telegram",
      allowFrom: ["123456789"],
      expectedIssuePath: "channels.telegram.allowFrom",
    },
    {
      provider: "whatsapp",
      allowFrom: ["+15555550123"],
      expectedIssuePath: "channels.whatsapp.allowFrom",
    },
    {
      provider: "signal",
      allowFrom: ["+15555550123"],
      expectedIssuePath: "channels.signal.allowFrom",
    },
    {
      provider: "imessage",
      allowFrom: ["+15555550123"],
      expectedIssuePath: "channels.imessage.allowFrom",
    },
  ] as const)(
    'enforces dmPolicy="open" allowFrom wildcard for $provider',
    ({ provider, allowFrom, expectedIssuePath }) => {
      const res = validateConfigObject({
        channels: {
          [provider]: { dmPolicy: "open", allowFrom },
        },
      });
      expect(res.ok, provider).toBe(false);
      if (!res.ok) {
        expect(res.issues[0]?.path, provider).toBe(expectedIssuePath);
      }
    },
    180_000,
  );

  it.each(["telegram", "whatsapp", "signal"] as const)(
    'accepts dmPolicy="open" with wildcard for %s',
    (provider) => {
      const res = validateConfigObject({
        channels: { [provider]: { dmPolicy: "open", allowFrom: ["*"] } },
      });
      expect(res.ok, provider).toBe(true);
      if (res.ok) {
        const channel = getChannelConfig(res.config, provider);
        expect(channel?.dmPolicy, provider).toBe("open");
      }
    },
  );

  it.each(["telegram", "whatsapp", "signal"] as const)(
    "defaults dm/group policy for configured provider %s",
    (provider) => {
      const res = validateConfigObject({ channels: { [provider]: {} } });
      expect(res.ok, provider).toBe(true);
      if (res.ok) {
        const channel = getChannelConfig(res.config, provider);
        expect(channel?.dmPolicy, provider).toBe("pairing");
        expect(channel?.groupPolicy, provider).toBe("allowlist");
      }
    },
  );
  it.each([
    {
      name: "streaming=true",
      input: { channels: { discord: { streaming: true } } },
      expectedStreaming: "partial",
    },
    {
      name: "streaming=false",
      input: { channels: { discord: { streaming: false } } },
      expectedStreaming: "off",
    },
    {
      name: "streamMode overrides streaming boolean",
      input: { channels: { discord: { streamMode: "block", streaming: false } } },
      expectedStreaming: "block",
    },
  ] as const)(
    "rejects legacy discord streaming fields during validation: $name",
    ({ input, name }) => {
      const res = validateConfigObject(input);
      expect(res.ok, name).toBe(false);
      if (!res.ok) {
        expect(res.issues[0]?.path, name).toBe("channels.discord");
        expect(res.issues[0]?.message, name).toContain(
          "channels.discord.streamMode and boolean channels.discord.streaming are legacy",
        );
      }
    },
  );
  it("accepts historyLimit overrides per provider and account", async () => {
    const res = validateConfigObject({
      messages: { groupChat: { historyLimit: 12 } },
      channels: {
        whatsapp: { historyLimit: 9, accounts: { work: { historyLimit: 4 } } },
        telegram: { historyLimit: 8, accounts: { ops: { historyLimit: 3 } } },
        slack: { historyLimit: 7, accounts: { ops: { historyLimit: 2 } } },
        signal: { historyLimit: 6 },
        imessage: { historyLimit: 5 },
        msteams: { historyLimit: 4 },
        discord: { historyLimit: 3 },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.channels?.whatsapp?.historyLimit).toBe(9);
      expect(res.config.channels?.whatsapp?.accounts?.work?.historyLimit).toBe(4);
      expect(res.config.channels?.telegram?.historyLimit).toBe(8);
      expect(res.config.channels?.telegram?.accounts?.ops?.historyLimit).toBe(3);
      expect(res.config.channels?.slack?.historyLimit).toBe(7);
      expect(res.config.channels?.slack?.accounts?.ops?.historyLimit).toBe(2);
      expect(res.config.channels?.signal?.historyLimit).toBe(6);
      expect(res.config.channels?.imessage?.historyLimit).toBe(5);
      expect(res.config.channels?.msteams?.historyLimit).toBe(4);
      expect(res.config.channels?.discord?.historyLimit).toBe(3);
    }
  });
});
