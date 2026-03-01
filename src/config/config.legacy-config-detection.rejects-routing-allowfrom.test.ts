import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./config.js";
import { migrateLegacyConfig, validateConfigObject } from "./config.js";

function getLegacyRouting(config: unknown) {
  return (config as { routing?: Record<string, unknown> } | undefined)?.routing;
}

function getChannelConfig(config: unknown, provider: string) {
  const channels = (config as { channels?: Record<string, Record<string, unknown>> } | undefined)
    ?.channels;
  return channels?.[provider];
}

describe("legacy config detection", () => {
  it("rejects legacy routing keys", async () => {
    const cases = [
      {
        name: "routing.allowFrom",
        input: { routing: { allowFrom: ["+15555550123"] } },
        expectedPath: "routing.allowFrom",
      },
      {
        name: "routing.groupChat.requireMention",
        input: { routing: { groupChat: { requireMention: false } } },
        expectedPath: "routing.groupChat.requireMention",
      },
    ] as const;
    for (const testCase of cases) {
      const res = validateConfigObject(testCase.input);
      expect(res.ok, testCase.name).toBe(false);
      if (!res.ok) {
        expect(res.issues[0]?.path, testCase.name).toBe(testCase.expectedPath);
      }
    }
  });

  it("migrates or drops routing.allowFrom based on whatsapp configuration", async () => {
    const cases = [
      {
        name: "whatsapp configured",
        input: { routing: { allowFrom: ["+15555550123"] }, channels: { whatsapp: {} } },
        expectedChange: "Moved routing.allowFrom → channels.whatsapp.allowFrom.",
        expectWhatsappAllowFrom: true,
      },
      {
        name: "whatsapp missing",
        input: { routing: { allowFrom: ["+15555550123"] } },
        expectedChange: "Removed routing.allowFrom (channels.whatsapp not configured).",
        expectWhatsappAllowFrom: false,
      },
    ] as const;
    for (const testCase of cases) {
      const res = migrateLegacyConfig(testCase.input);
      expect(res.changes, testCase.name).toContain(testCase.expectedChange);
      if (testCase.expectWhatsappAllowFrom) {
        expect(res.config?.channels?.whatsapp?.allowFrom, testCase.name).toEqual(["+15555550123"]);
      } else {
        expect(res.config?.channels?.whatsapp, testCase.name).toBeUndefined();
      }
      expect(getLegacyRouting(res.config)?.allowFrom, testCase.name).toBeUndefined();
    }
  });

  it("migrates routing.groupChat.requireMention to provider group defaults", async () => {
    const cases = [
      {
        name: "whatsapp configured",
        input: { routing: { groupChat: { requireMention: false } }, channels: { whatsapp: {} } },
        expectWhatsapp: true,
      },
      {
        name: "whatsapp missing",
        input: { routing: { groupChat: { requireMention: false } } },
        expectWhatsapp: false,
      },
    ] as const;
    for (const testCase of cases) {
      const res = migrateLegacyConfig(testCase.input);
      expect(res.changes, testCase.name).toContain(
        'Moved routing.groupChat.requireMention → channels.telegram.groups."*".requireMention.',
      );
      expect(res.changes, testCase.name).toContain(
        'Moved routing.groupChat.requireMention → channels.imessage.groups."*".requireMention.',
      );
      if (testCase.expectWhatsapp) {
        expect(res.changes, testCase.name).toContain(
          'Moved routing.groupChat.requireMention → channels.whatsapp.groups."*".requireMention.',
        );
        expect(res.config?.channels?.whatsapp?.groups?.["*"]?.requireMention, testCase.name).toBe(
          false,
        );
      } else {
        expect(res.changes, testCase.name).not.toContain(
          'Moved routing.groupChat.requireMention → channels.whatsapp.groups."*".requireMention.',
        );
        expect(res.config?.channels?.whatsapp, testCase.name).toBeUndefined();
      }
      expect(res.config?.channels?.telegram?.groups?.["*"]?.requireMention, testCase.name).toBe(
        false,
      );
      expect(res.config?.channels?.imessage?.groups?.["*"]?.requireMention, testCase.name).toBe(
        false,
      );
      expect(getLegacyRouting(res.config)?.groupChat, testCase.name).toBeUndefined();
    }
  });
  it("migrates routing.groupChat.mentionPatterns to messages.groupChat.mentionPatterns", async () => {
    const res = migrateLegacyConfig({
      routing: { groupChat: { mentionPatterns: ["@openclaw"] } },
    });
    expect(res.changes).toContain(
      "Moved routing.groupChat.mentionPatterns → messages.groupChat.mentionPatterns.",
    );
    expect(res.config?.messages?.groupChat?.mentionPatterns).toEqual(["@openclaw"]);
    expect(getLegacyRouting(res.config)?.groupChat).toBeUndefined();
  });
  it("migrates routing agentToAgent/queue/transcribeAudio to tools/messages/media", async () => {
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
    expect(res.changes).toContain("Moved routing.agentToAgent → tools.agentToAgent.");
    expect(res.changes).toContain("Moved routing.queue → messages.queue.");
    expect(res.changes).toContain("Moved routing.transcribeAudio → tools.media.audio.models.");
    expect(res.config?.tools?.agentToAgent).toEqual({
      enabled: true,
      allow: ["main"],
    });
    expect(res.config?.messages?.queue).toEqual({
      mode: "queue",
      cap: 3,
    });
    expect(res.config?.tools?.media?.audio).toEqual({
      enabled: true,
      models: [
        {
          command: "whisper",
          type: "cli",
          args: ["--model", "base"],
          timeoutSeconds: 2,
        },
      ],
    });
    expect(getLegacyRouting(res.config)).toBeUndefined();
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
  it("migrates agent config into agents.defaults and tools", async () => {
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
    expect(res.changes).toContain("Moved agent.tools.allow → tools.allow.");
    expect(res.changes).toContain("Moved agent.tools.deny → tools.deny.");
    expect(res.changes).toContain("Moved agent.elevated → tools.elevated.");
    expect(res.changes).toContain("Moved agent.bash → tools.exec.");
    expect(res.changes).toContain("Moved agent.sandbox.tools → tools.sandbox.tools.");
    expect(res.changes).toContain("Moved agent.subagents.tools → tools.subagents.tools.");
    expect(res.changes).toContain("Moved agent → agents.defaults.");
    expect(res.config?.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.2",
      fallbacks: [],
    });
    expect(res.config?.tools?.allow).toEqual(["sessions.list"]);
    expect(res.config?.tools?.deny).toEqual(["danger"]);
    expect(res.config?.tools?.elevated).toEqual({
      enabled: true,
      allowFrom: { discord: ["user:1"] },
    });
    expect(res.config?.tools?.exec).toEqual({ timeoutSec: 12 });
    expect(res.config?.tools?.sandbox?.tools).toEqual({
      allow: ["browser.open"],
    });
    expect(res.config?.tools?.subagents?.tools).toEqual({
      deny: ["sandbox"],
    });
    expect((res.config as { agent?: unknown }).agent).toBeUndefined();
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
  it("migrates tools.bash to tools.exec", async () => {
    const res = migrateLegacyConfig({
      tools: {
        bash: { timeoutSec: 12 },
      },
    });
    expect(res.changes).toContain("Moved tools.bash → tools.exec.");
    expect(res.config?.tools?.exec).toEqual({ timeoutSec: 12 });
    expect((res.config?.tools as { bash?: unknown } | undefined)?.bash).toBeUndefined();
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
      expect(res.issues.some((issue) => issue.path === "telegram.requireMention")).toBe(true);
    }
  });
  it("rejects gateway.token", async () => {
    const res = validateConfigObject({
      gateway: { token: "legacy-token" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("gateway.token");
    }
  });
  it("migrates gateway.token to gateway.auth.token", async () => {
    const res = migrateLegacyConfig({
      gateway: { token: "legacy-token" },
    });
    expect(res.changes).toContain("Moved gateway.token → gateway.auth.token.");
    expect(res.config?.gateway?.auth?.token).toBe("legacy-token");
    expect(res.config?.gateway?.auth?.mode).toBe("token");
    expect((res.config?.gateway as { token?: string })?.token).toBeUndefined();
  });
  it("keeps gateway.bind tailnet", async () => {
    const res = migrateLegacyConfig({
      gateway: { bind: "tailnet" as const },
    });
    expect(res.changes).not.toContain("Migrated gateway.bind from 'tailnet' to 'auto'.");
    expect(res.config).toBeNull();

    const validated = validateConfigObject({ gateway: { bind: "tailnet" as const } });
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.config.gateway?.bind).toBe("tailnet");
    }
  });
  it('enforces dmPolicy="open" allowFrom wildcard for supported providers', async () => {
    const cases = [
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
    ] as const;
    for (const testCase of cases) {
      const res = validateConfigObject({
        channels: {
          [testCase.provider]: { dmPolicy: "open", allowFrom: testCase.allowFrom },
        },
      });
      expect(res.ok, testCase.provider).toBe(false);
      if (!res.ok) {
        expect(res.issues[0]?.path, testCase.provider).toBe(testCase.expectedIssuePath);
      }
    }
  });

  it('accepts dmPolicy="open" when allowFrom includes wildcard', async () => {
    const providers = ["telegram", "whatsapp", "signal"] as const;
    for (const provider of providers) {
      const res = validateConfigObject({
        channels: { [provider]: { dmPolicy: "open", allowFrom: ["*"] } },
      });
      expect(res.ok, provider).toBe(true);
      if (res.ok) {
        const channel = getChannelConfig(res.config, provider);
        expect(channel?.dmPolicy, provider).toBe("open");
      }
    }
  });

  it("defaults dm/group policy for configured providers", async () => {
    const providers = ["telegram", "whatsapp", "signal"] as const;
    for (const provider of providers) {
      const res = validateConfigObject({ channels: { [provider]: {} } });
      expect(res.ok, provider).toBe(true);
      if (res.ok) {
        const channel = getChannelConfig(res.config, provider);
        expect(channel?.dmPolicy, provider).toBe("pairing");
        expect(channel?.groupPolicy, provider).toBe("allowlist");
        if (provider === "telegram") {
          expect(channel?.streaming, provider).toBe("off");
          expect(channel?.streamMode, provider).toBeUndefined();
        }
      }
    }
  });
  it("normalizes telegram legacy streamMode aliases", async () => {
    const cases = [
      {
        name: "top-level off",
        input: { channels: { telegram: { streamMode: "off" } } },
        expectedTopLevel: "off",
      },
      {
        name: "top-level block",
        input: { channels: { telegram: { streamMode: "block" } } },
        expectedTopLevel: "block",
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
        expectedAccountStreaming: "off",
      },
    ] as const;
    for (const testCase of cases) {
      const res = validateConfigObject(testCase.input);
      expect(res.ok, testCase.name).toBe(true);
      if (res.ok) {
        if ("expectedTopLevel" in testCase && testCase.expectedTopLevel !== undefined) {
          expect(res.config.channels?.telegram?.streaming, testCase.name).toBe(
            testCase.expectedTopLevel,
          );
          expect(res.config.channels?.telegram?.streamMode, testCase.name).toBeUndefined();
        }
        if (
          "expectedAccountStreaming" in testCase &&
          testCase.expectedAccountStreaming !== undefined
        ) {
          expect(res.config.channels?.telegram?.accounts?.ops?.streaming, testCase.name).toBe(
            testCase.expectedAccountStreaming,
          );
          expect(
            res.config.channels?.telegram?.accounts?.ops?.streamMode,
            testCase.name,
          ).toBeUndefined();
        }
      }
    }
  });

  it("normalizes discord streaming fields during legacy migration", async () => {
    const cases = [
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
    ] as const;
    for (const testCase of cases) {
      const res = migrateLegacyConfig(testCase.input);
      for (const expectedChange of testCase.expectedChanges) {
        expect(res.changes, testCase.name).toContain(expectedChange);
      }
      expect(res.config?.channels?.discord?.streaming, testCase.name).toBe(
        testCase.expectedStreaming,
      );
      expect(res.config?.channels?.discord?.streamMode, testCase.name).toBeUndefined();
    }
  });

  it("normalizes discord streaming fields during validation", async () => {
    const cases = [
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
    ] as const;
    for (const testCase of cases) {
      const res = validateConfigObject(testCase.input);
      expect(res.ok, testCase.name).toBe(true);
      if (res.ok) {
        expect(res.config.channels?.discord?.streaming, testCase.name).toBe(
          testCase.expectedStreaming,
        );
        expect(res.config.channels?.discord?.streamMode, testCase.name).toBeUndefined();
      }
    }
  });
  it("normalizes account-level discord and slack streaming aliases", async () => {
    const cases = [
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
    ] as const;
    for (const testCase of cases) {
      const res = validateConfigObject(testCase.input);
      expect(res.ok, testCase.name).toBe(true);
      if (res.ok) {
        testCase.assert(res.config);
      }
    }
  });
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
