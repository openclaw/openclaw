import { describe, expect, it } from "vitest";
import { migrateLegacyConfig } from "./legacy-migrate.js";
import type { OpenClawConfig } from "./types.js";
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

  it("does not rewrite removed routing.allowFrom migrations", async () => {
    const res = migrateLegacyConfig({
      routing: { allowFrom: ["+15555550123"] },
      channels: { whatsapp: {} },
    });
    expect(res.changes).toEqual([]);
    expect(res.config).toBeNull();
  });

  it("does not rewrite removed routing.groupChat.requireMention migrations", async () => {
    const res = migrateLegacyConfig({
      routing: { groupChat: { requireMention: false } },
      channels: { whatsapp: {} },
    });
    expect(res.changes).toEqual([]);
    expect(res.config).toBeNull();
  });
  it("does not rewrite removed routing.groupChat.mentionPatterns migrations", async () => {
    const res = migrateLegacyConfig({
      routing: { groupChat: { mentionPatterns: ["@openclaw"] } },
    });
    expect(res.changes).toEqual([]);
    expect(res.config).toBeNull();
  });
  it("does not rewrite removed routing agentToAgent/queue/transcribeAudio migrations", async () => {
    const res = migrateLegacyConfig({
      routing: {
        agentToAgent: { enabled: true, allow: ["main"] },
        queue: { mode: "queue", cap: 3 },
        transcribeAudio: {
          command: ["whisper", "--model", "base"],
          timeoutSeconds: 2,
        },
      },
    });
    expect(res.changes).toEqual([]);
    expect(res.config).toBeNull();
  });
  it("migrates audio.transcription with custom script names", async () => {
    const res = migrateLegacyConfig({
      audio: {
        transcription: {
          command: ["/home/user/.scripts/whisperx-transcribe.sh"],
          timeoutSeconds: 120,
        },
      },
    });
    expect(res.changes).toContain("Moved audio.transcription → tools.media.audio.models.");
    expect(res.config?.tools?.media?.audio).toEqual({
      enabled: true,
      models: [
        {
          command: "/home/user/.scripts/whisperx-transcribe.sh",
          type: "cli",
          timeoutSeconds: 120,
        },
      ],
    });
    expect(res.config?.audio).toBeUndefined();
  });
  it("rejects audio.transcription when command contains non-string parts", async () => {
    const res = migrateLegacyConfig({
      audio: {
        transcription: {
          command: [{}],
          timeoutSeconds: 120,
        },
      },
    });
    expect(res.changes).toContain("Removed audio.transcription (invalid or empty command).");
    expect(res.config?.tools?.media?.audio).toBeUndefined();
    expect(res.config?.audio).toBeUndefined();
  });
  it("does not rewrite removed agent config migrations", async () => {
    const res = migrateLegacyConfig({
      agent: {
        model: "openai/gpt-5.2",
        tools: { allow: ["sessions.list"], deny: ["danger"] },
        elevated: { enabled: true, allowFrom: { discord: ["user:1"] } },
        bash: { timeoutSec: 12 },
        sandbox: { tools: { allow: ["browser.open"] } },
        subagents: { tools: { deny: ["sandbox"] } },
      },
    });
    expect(res.changes).toEqual([]);
    expect(res.config).toBeNull();
  });
  it("migrates top-level memorySearch to agents.defaults.memorySearch", async () => {
    const res = migrateLegacyConfig({
      memorySearch: {
        provider: "local",
        fallback: "none",
        query: { maxResults: 7 },
      },
    });
    expect(res.changes).toContain("Moved memorySearch → agents.defaults.memorySearch.");
    expect(res.config?.agents?.defaults?.memorySearch).toMatchObject({
      provider: "local",
      fallback: "none",
      query: { maxResults: 7 },
    });
    expect((res.config as { memorySearch?: unknown }).memorySearch).toBeUndefined();
  });
  it("merges top-level memorySearch into agents.defaults.memorySearch", async () => {
    const res = migrateLegacyConfig({
      memorySearch: {
        provider: "local",
        fallback: "none",
        query: { maxResults: 7 },
      },
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
          },
        },
      },
    });
    expect(res.changes).toContain(
      "Merged memorySearch → agents.defaults.memorySearch (filled missing fields from legacy; kept explicit agents.defaults values).",
    );
    expect(res.config?.agents?.defaults?.memorySearch).toMatchObject({
      provider: "openai",
      model: "text-embedding-3-small",
      fallback: "none",
      query: { maxResults: 7 },
    });
  });
  it("keeps nested agents.defaults.memorySearch values when merging legacy defaults", async () => {
    const res = migrateLegacyConfig({
      memorySearch: {
        query: {
          maxResults: 7,
          minScore: 0.25,
          hybrid: { enabled: true, textWeight: 0.8, vectorWeight: 0.2 },
        },
      },
      agents: {
        defaults: {
          memorySearch: {
            query: {
              maxResults: 3,
              hybrid: { enabled: false },
            },
          },
        },
      },
    });

    expect(res.config?.agents?.defaults?.memorySearch).toMatchObject({
      query: {
        maxResults: 3,
        minScore: 0.25,
        hybrid: { enabled: false, textWeight: 0.8, vectorWeight: 0.2 },
      },
    });
  });
  it("does not rewrite removed tools.bash migrations", async () => {
    const res = migrateLegacyConfig({
      tools: {
        bash: { timeoutSec: 12 },
      },
    });
    expect(res.changes).toEqual([]);
    expect(res.config).toBeNull();
  });
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
  it("does not rewrite removed gateway.token migrations", async () => {
    const res = migrateLegacyConfig({
      gateway: { token: "legacy-token" },
    });
    expect(res.changes).toEqual([]);
    expect(res.config).toBeNull();
  });
  it("keeps gateway.bind tailnet", async () => {
    const res = migrateLegacyConfig({
      gateway: { bind: "tailnet" as const },
    });
    expect(res.changes).not.toContain("Migrated gateway.bind from 'tailnet' to 'auto'.");
    expect(res.config?.gateway?.bind).toBe("tailnet");
    expect(res.config?.gateway?.controlUi?.allowedOrigins).toEqual([
      "http://localhost:18789",
      "http://127.0.0.1:18789",
    ]);

    const validated = validateConfigObject({ gateway: { bind: "tailnet" as const } });
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.config.gateway?.bind).toBe("tailnet");
    }
  });
  it.each([
    { input: "0.0.0.0", expected: "lan" },
    { input: "::", expected: "lan" },
    { input: "127.0.0.1", expected: "loopback" },
    { input: "localhost", expected: "loopback" },
    { input: "::1", expected: "loopback" },
  ] as const)("normalizes gateway.bind host alias $input", ({ input, expected }) => {
    const res = migrateLegacyConfig({
      gateway: { bind: input },
    });
    expect(res.changes).toContain(`Normalized gateway.bind "${input}" → "${expected}".`);
    expect(res.config?.gateway?.bind).toBe(expected);

    const validated = validateConfigObject(res.config);
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.config.gateway?.bind).toBe(expected);
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
  it("escapes control characters in gateway.bind migration change text", async () => {
    const res = migrateLegacyConfig({
      gateway: { bind: "\r\n0.0.0.0\r\n" },
    });
    expect(res.changes).toContain('Normalized gateway.bind "\\r\\n0.0.0.0\\r\\n" → "lan".');
  });
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
        if (provider === "telegram") {
          expect(channel?.streaming, provider).toBe("partial");
          expect(channel?.streamMode, provider).toBeUndefined();
        }
      }
    },
  );
  it.each([
    {
      name: "top-level off",
      input: { channels: { telegram: { streamMode: "off" } } },
      assert: (config: NonNullable<OpenClawConfig>) => {
        expect(config.channels?.telegram?.streaming).toBe("off");
        expect(config.channels?.telegram?.streamMode).toBeUndefined();
      },
    },
    {
      name: "top-level block",
      input: { channels: { telegram: { streamMode: "block" } } },
      assert: (config: NonNullable<OpenClawConfig>) => {
        expect(config.channels?.telegram?.streaming).toBe("block");
        expect(config.channels?.telegram?.streamMode).toBeUndefined();
      },
    },
    {
      name: "per-account off",
      input: {
        channels: {
          telegram: {
            accounts: {
              ops: {
                streamMode: "off",
              },
            },
          },
        },
      },
      assert: (config: NonNullable<OpenClawConfig>) => {
        expect(config.channels?.telegram?.accounts?.ops?.streaming).toBe("off");
        expect(config.channels?.telegram?.accounts?.ops?.streamMode).toBeUndefined();
      },
    },
  ] as const)("normalizes telegram legacy streamMode alias: $name", ({ input, assert, name }) => {
    const res = validateConfigObject(input);
    expect(res.ok, name).toBe(true);
    if (res.ok) {
      assert(res.config);
    }
  });

  it.each([
    {
      name: "boolean streaming=true",
      input: { channels: { discord: { streaming: true } } },
      expectedChanges: ["Normalized channels.discord.streaming boolean → enum (partial)."],
      expectedStreaming: "partial",
    },
    {
      name: "streamMode with streaming boolean",
      input: { channels: { discord: { streaming: false, streamMode: "block" } } },
      expectedChanges: [
        "Moved channels.discord.streamMode → channels.discord.streaming (block).",
        "Normalized channels.discord.streaming boolean → enum (block).",
      ],
      expectedStreaming: "block",
    },
  ] as const)(
    "normalizes discord streaming fields during legacy migration: $name",
    ({ input, expectedChanges, expectedStreaming, name }) => {
      const res = migrateLegacyConfig(input);
      for (const expectedChange of expectedChanges) {
        expect(res.changes, name).toContain(expectedChange);
      }
      expect(res.config?.channels?.discord?.streaming, name).toBe(expectedStreaming);
      expect(res.config?.channels?.discord?.streamMode, name).toBeUndefined();
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
    "normalizes discord streaming fields during validation: $name",
    ({ input, expectedStreaming, name }) => {
      const res = validateConfigObject(input);
      expect(res.ok, name).toBe(true);
      if (res.ok) {
        expect(res.config.channels?.discord?.streaming, name).toBe(expectedStreaming);
        expect(res.config.channels?.discord?.streamMode, name).toBeUndefined();
      }
    },
  );
  it.each([
    {
      name: "discord account streaming boolean",
      input: {
        channels: {
          discord: {
            accounts: {
              work: {
                streaming: true,
              },
            },
          },
        },
      },
      assert: (config: NonNullable<OpenClawConfig>) => {
        expect(config.channels?.discord?.accounts?.work?.streaming).toBe("partial");
        expect(config.channels?.discord?.accounts?.work?.streamMode).toBeUndefined();
      },
    },
    {
      name: "slack streamMode alias",
      input: {
        channels: {
          slack: {
            streamMode: "status_final",
          },
        },
      },
      assert: (config: NonNullable<OpenClawConfig>) => {
        expect(config.channels?.slack?.streaming).toBe("progress");
        expect(config.channels?.slack?.streamMode).toBeUndefined();
        expect(config.channels?.slack?.nativeStreaming).toBe(true);
      },
    },
    {
      name: "slack streaming boolean legacy",
      input: {
        channels: {
          slack: {
            streaming: false,
          },
        },
      },
      assert: (config: NonNullable<OpenClawConfig>) => {
        expect(config.channels?.slack?.streaming).toBe("off");
        expect(config.channels?.slack?.nativeStreaming).toBe(false);
      },
    },
  ] as const)(
    "normalizes account-level discord/slack streaming alias: $name",
    ({ input, assert, name }) => {
      const res = validateConfigObject(input);
      expect(res.ok, name).toBe(true);
      if (res.ok) {
        assert(res.config);
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
