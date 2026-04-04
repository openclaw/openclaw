import { describe, expect, it } from "vitest";
import {
  getConfigValueAtPath,
  parseConfigPath,
  setConfigValueAtPath,
  unsetConfigValueAtPath,
} from "./config-paths.js";
import { readConfigFileSnapshot, validateConfigObject } from "./config.js";
import { buildWebSearchProviderConfig, withTempHome, writeOpenClawConfig } from "./test-helpers.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("$schema key in config (#14998)", () => {
  it("accepts config with $schema string", () => {
    const result = OpenClawSchema.safeParse({
      $schema: "https://openclaw.ai/config.json",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.$schema).toBe("https://openclaw.ai/config.json");
    }
  });

  it("accepts config without $schema", () => {
    const result = OpenClawSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("rejects non-string $schema", () => {
    const result = OpenClawSchema.safeParse({ $schema: 123 });
    expect(result.success).toBe(false);
  });

  it("accepts $schema during full config validation", () => {
    const result = validateConfigObject({
      $schema: "./schema.json",
      gateway: { port: 18789 },
    });
    expect(result.ok).toBe(true);
  });
});

describe("plugins.slots.contextEngine", () => {
  it("accepts a contextEngine slot id", () => {
    const result = OpenClawSchema.safeParse({
      plugins: {
        slots: {
          contextEngine: "my-context-engine",
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("auth.cooldowns auth_permanent backoff config", () => {
  it("accepts auth_permanent backoff knobs", () => {
    const result = OpenClawSchema.safeParse({
      auth: {
        cooldowns: {
          authPermanentBackoffMinutes: 10,
          authPermanentMaxMinutes: 60,
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("ui.seamColor", () => {
  it("accepts hex colors", () => {
    const res = validateConfigObject({ ui: { seamColor: "#FF4500" } });
    expect(res.ok).toBe(true);
  });

  it("rejects non-hex colors", () => {
    const res = validateConfigObject({ ui: { seamColor: "lobster" } });
    expect(res.ok).toBe(false);
  });

  it("rejects invalid hex length", () => {
    const res = validateConfigObject({ ui: { seamColor: "#FF4500FF" } });
    expect(res.ok).toBe(false);
  });
});

describe("plugins.entries.*.hooks.allowPromptInjection", () => {
  it("accepts boolean values", () => {
    const result = OpenClawSchema.safeParse({
      plugins: {
        entries: {
          "voice-call": {
            hooks: {
              allowPromptInjection: false,
            },
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-boolean values", () => {
    const result = OpenClawSchema.safeParse({
      plugins: {
        entries: {
          "voice-call": {
            hooks: {
              allowPromptInjection: "no",
            },
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("plugins.entries.*.subagent", () => {
  it("accepts trusted subagent override settings", () => {
    const result = OpenClawSchema.safeParse({
      plugins: {
        entries: {
          "voice-call": {
            subagent: {
              allowModelOverride: true,
              allowedModels: ["anthropic/claude-haiku-4-5"],
            },
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid trusted subagent override settings", () => {
    const result = OpenClawSchema.safeParse({
      plugins: {
        entries: {
          "voice-call": {
            subagent: {
              allowModelOverride: "yes",
              allowedModels: [1],
            },
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("web search provider config", () => {
  it("accepts kimi provider and config", () => {
    const res = validateConfigObject(
      buildWebSearchProviderConfig({
        provider: "kimi",
        providerConfig: {
          apiKey: "test-key",
          baseUrl: "https://api.moonshot.ai/v1",
          model: "moonshot-v1-128k",
        },
      }),
    );

    expect(res.ok).toBe(true);
  });
});

describe("talk.voiceAliases", () => {
  it("accepts a string map of voice aliases via legacy talk migration", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        talk: {
          voiceAliases: {
            Clawd: "EXAVITQu4vr4xnSDxMaL",
            Roger: "CwhRBWXzGAHq8TQ4Fs17",
          },
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "talk")).toBe(true);
      expect(snap.sourceConfig.talk?.providers?.elevenlabs?.voiceAliases).toEqual({
        Clawd: "EXAVITQu4vr4xnSDxMaL",
        Roger: "CwhRBWXzGAHq8TQ4Fs17",
      });
    });
  });

  it("rejects non-string voice alias values", () => {
    const res = validateConfigObject({
      talk: {
        voiceAliases: {
          Clawd: 123,
        },
      },
    });
    expect(res.ok).toBe(false);
  });
});

describe("gateway.remote.transport", () => {
  it("accepts direct transport", () => {
    const res = validateConfigObject({
      gateway: {
        remote: {
          transport: "direct",
          url: "wss://gateway.example.ts.net",
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects unknown transport", () => {
    const res = validateConfigObject({
      gateway: {
        remote: {
          transport: "udp",
        },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("gateway.remote.transport");
    }
  });
});

describe("gateway.tools config", () => {
  it("accepts gateway.tools allow and deny lists", () => {
    const res = validateConfigObject({
      gateway: {
        tools: {
          allow: ["gateway"],
          deny: ["sessions_spawn", "sessions_send"],
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects invalid gateway.tools values", () => {
    const res = validateConfigObject({
      gateway: {
        tools: {
          allow: "gateway",
        },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("gateway.tools.allow");
    }
  });
});

describe("gateway.channelHealthCheckMinutes", () => {
  it("accepts zero to disable monitor", () => {
    const res = validateConfigObject({
      gateway: {
        channelHealthCheckMinutes: 0,
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects negative intervals", () => {
    const res = validateConfigObject({
      gateway: {
        channelHealthCheckMinutes: -1,
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("gateway.channelHealthCheckMinutes");
    }
  });

  it("rejects stale thresholds shorter than the health check interval", () => {
    const res = validateConfigObject({
      gateway: {
        channelHealthCheckMinutes: 5,
        channelStaleEventThresholdMinutes: 4,
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("gateway.channelStaleEventThresholdMinutes");
    }
  });

  it("accepts stale thresholds that match or exceed the health check interval", () => {
    const equal = validateConfigObject({
      gateway: {
        channelHealthCheckMinutes: 5,
        channelStaleEventThresholdMinutes: 5,
      },
    });
    expect(equal.ok).toBe(true);

    const greater = validateConfigObject({
      gateway: {
        channelHealthCheckMinutes: 5,
        channelStaleEventThresholdMinutes: 6,
      },
    });
    expect(greater.ok).toBe(true);
  });

  it("rejects stale thresholds shorter than the default health check interval", () => {
    const res = validateConfigObject({
      gateway: {
        channelStaleEventThresholdMinutes: 4,
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("gateway.channelStaleEventThresholdMinutes");
    }
  });
});

describe("cron webhook schema", () => {
  it("accepts cron.webhookToken and legacy cron.webhook", () => {
    const res = OpenClawSchema.safeParse({
      cron: {
        enabled: true,
        webhook: "https://example.invalid/legacy-cron-webhook",
        webhookToken: "secret-token",
      },
    });

    expect(res.success).toBe(true);
  });

  it("accepts cron.webhookToken SecretRef values", () => {
    const res = OpenClawSchema.safeParse({
      cron: {
        webhook: "https://example.invalid/legacy-cron-webhook",
        webhookToken: {
          source: "env",
          provider: "default",
          id: "CRON_WEBHOOK_TOKEN",
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("rejects non-http cron.webhook URLs", () => {
    const res = OpenClawSchema.safeParse({
      cron: {
        webhook: "ftp://example.invalid/legacy-cron-webhook",
      },
    });

    expect(res.success).toBe(false);
  });

  it("accepts cron.retry config", () => {
    const res = OpenClawSchema.safeParse({
      cron: {
        retry: {
          maxAttempts: 5,
          backoffMs: [60000, 120000, 300000],
          retryOn: ["rate_limit", "overloaded", "network"],
        },
      },
    });
    expect(res.success).toBe(true);
  });
});

describe("broadcast", () => {
  it("accepts a broadcast peer map with strategy", () => {
    const res = validateConfigObject({
      agents: {
        list: [{ id: "alfred" }, { id: "baerbel" }],
      },
      broadcast: {
        strategy: "parallel",
        "120363403215116621@g.us": ["alfred", "baerbel"],
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects invalid broadcast strategy", () => {
    const res = validateConfigObject({
      broadcast: { strategy: "nope" },
    });
    expect(res.ok).toBe(false);
  });

  it("rejects non-array broadcast entries", () => {
    const res = validateConfigObject({
      broadcast: { "120363403215116621@g.us": 123 },
    });
    expect(res.ok).toBe(false);
  });
});

describe("model compat config schema", () => {
  it("accepts full openai-completions compat fields", () => {
    const res = validateConfigObject({
      models: {
        providers: {
          local: {
            baseUrl: "http://127.0.0.1:1234/v1",
            api: "openai-completions",
            models: [
              {
                id: "qwen3-32b",
                name: "Qwen3 32B",
                compat: {
                  supportsUsageInStreaming: true,
                  supportsStrictMode: false,
                  thinkingFormat: "qwen",
                  requiresToolResultName: true,
                  requiresAssistantAfterToolResult: false,
                  requiresThinkingAsText: false,
                  requiresMistralToolIds: false,
                  requiresOpenAiAnthropicToolPayload: true,
                },
              },
            ],
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });
});

describe("config paths", () => {
  it("rejects empty and blocked paths", () => {
    expect(parseConfigPath("")).toEqual({
      ok: false,
      error: "Invalid path. Use dot notation (e.g. foo.bar).",
    });
    expect(parseConfigPath("__proto__.polluted").ok).toBe(false);
    expect(parseConfigPath("constructor.polluted").ok).toBe(false);
    expect(parseConfigPath("prototype.polluted").ok).toBe(false);
  });

  it("sets, gets, and unsets nested values", () => {
    const root: Record<string, unknown> = {};
    const parsed = parseConfigPath("foo.bar");
    if (!parsed.ok || !parsed.path) {
      throw new Error("path parse failed");
    }
    setConfigValueAtPath(root, parsed.path, 123);
    expect(getConfigValueAtPath(root, parsed.path)).toBe(123);
    expect(unsetConfigValueAtPath(root, parsed.path)).toBe(true);
    expect(getConfigValueAtPath(root, parsed.path)).toBeUndefined();
  });
});

describe("config strict validation", () => {
  it("rejects unknown fields", async () => {
    const res = validateConfigObject({
      agents: { list: [{ id: "pi" }] },
      customUnknownField: { nested: "value" },
    });
    expect(res.ok).toBe(false);
  });

  it("accepts documented agents.list[].params overrides", () => {
    const res = validateConfigObject({
      agents: {
        list: [
          {
            id: "main",
            model: "anthropic/claude-opus-4-6",
            params: {
              cacheRetention: "none",
              temperature: 0.4,
              maxTokens: 8192,
            },
          },
        ],
      },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.agents?.list?.[0]?.params).toEqual({
        cacheRetention: "none",
        temperature: 0.4,
        maxTokens: 8192,
      });
    }
  });

  it("accepts top-level memorySearch via auto-migration and reports legacyIssues", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        memorySearch: {
          provider: "local",
          fallback: "none",
          query: { maxResults: 7 },
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "memorySearch")).toBe(true);
      expect(snap.sourceConfig.agents?.defaults?.memorySearch).toMatchObject({
        provider: "local",
        fallback: "none",
        query: { maxResults: 7 },
      });
      expect((snap.sourceConfig as { memorySearch?: unknown }).memorySearch).toBeUndefined();
    });
  });

  it("accepts top-level heartbeat agent settings via auto-migration and reports legacyIssues", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        heartbeat: {
          every: "30m",
          model: "anthropic/claude-3-5-haiku-20241022",
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "heartbeat")).toBe(true);
      expect(snap.sourceConfig.agents?.defaults?.heartbeat).toMatchObject({
        every: "30m",
        model: "anthropic/claude-3-5-haiku-20241022",
      });
      expect((snap.sourceConfig as { heartbeat?: unknown }).heartbeat).toBeUndefined();
    });
  });

  it("accepts top-level heartbeat visibility via auto-migration and reports legacyIssues", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        heartbeat: {
          showOk: true,
          showAlerts: false,
          useIndicator: true,
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "heartbeat")).toBe(true);
      expect(snap.sourceConfig.channels?.defaults?.heartbeat).toMatchObject({
        showOk: true,
        showAlerts: false,
        useIndicator: true,
      });
      expect((snap.sourceConfig as { heartbeat?: unknown }).heartbeat).toBeUndefined();
    });
  });

  it("accepts legacy messages.tts provider keys via auto-migration and reports legacyIssues", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        messages: {
          tts: {
            provider: "elevenlabs",
            elevenlabs: {
              apiKey: "test-key",
              voiceId: "voice-1",
            },
          },
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "messages.tts")).toBe(true);
      expect(snap.sourceConfig.messages?.tts?.providers?.elevenlabs).toEqual({
        apiKey: "test-key",
        voiceId: "voice-1",
      });
      expect(
        (snap.sourceConfig.messages?.tts as Record<string, unknown> | undefined)?.elevenlabs,
      ).toBeUndefined();
    });
  });

  it("accepts legacy talk flat fields via auto-migration and reports legacyIssues", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        talk: {
          voiceId: "voice-1",
          modelId: "eleven_v3",
          apiKey: "test-key",
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "talk")).toBe(true);
      expect(snap.sourceConfig.talk?.providers?.elevenlabs).toEqual({
        voiceId: "voice-1",
        modelId: "eleven_v3",
        apiKey: "test-key",
      });
      expect(
        (snap.sourceConfig.talk as Record<string, unknown> | undefined)?.voiceId,
      ).toBeUndefined();
      expect(
        (snap.sourceConfig.talk as Record<string, unknown> | undefined)?.modelId,
      ).toBeUndefined();
      expect(
        (snap.sourceConfig.talk as Record<string, unknown> | undefined)?.apiKey,
      ).toBeUndefined();
    });
  });

  it("accepts legacy sandbox perSession via auto-migration and reports legacyIssues", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        agents: {
          defaults: {
            sandbox: {
              perSession: true,
            },
          },
          list: [
            {
              id: "pi",
              sandbox: {
                perSession: false,
              },
            },
          ],
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "agents.defaults.sandbox")).toBe(
        true,
      );
      expect(snap.legacyIssues.some((issue) => issue.path === "agents.list")).toBe(true);
      expect(snap.sourceConfig.agents?.defaults?.sandbox).toEqual({
        scope: "session",
      });
      expect(snap.sourceConfig.agents?.list?.[0]?.sandbox).toEqual({
        scope: "shared",
      });
    });
  });

  it("accepts legacy x_search auth via auto-migration and reports legacyIssues", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        tools: {
          web: {
            x_search: {
              apiKey: "test-key",
            },
          },
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "tools.web.x_search.apiKey")).toBe(
        true,
      );
      expect(snap.sourceConfig.plugins?.entries?.xai?.config?.webSearch).toMatchObject({
        apiKey: "test-key",
      });
      expect(
        (snap.sourceConfig.tools?.web?.x_search as Record<string, unknown> | undefined)?.apiKey,
      ).toBeUndefined();
    });
  });

  it("accepts legacy thread binding ttlHours via auto-migration and reports legacyIssues", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        session: {
          threadBindings: {
            ttlHours: 24,
          },
        },
        channels: {
          discord: {
            threadBindings: {
              ttlHours: 12,
            },
            accounts: {
              alpha: {
                threadBindings: {
                  ttlHours: 6,
                },
              },
            },
          },
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "session.threadBindings")).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "channels")).toBe(true);
      expect(snap.sourceConfig.session?.threadBindings).toMatchObject({
        idleHours: 24,
      });
      expect(snap.sourceConfig.channels?.discord?.threadBindings).toMatchObject({
        idleHours: 12,
      });
      expect(snap.sourceConfig.channels?.discord?.accounts?.alpha?.threadBindings).toMatchObject({
        idleHours: 6,
      });
      expect(
        (snap.sourceConfig.session?.threadBindings as Record<string, unknown> | undefined)
          ?.ttlHours,
      ).toBeUndefined();
      expect(
        (snap.sourceConfig.channels?.discord?.threadBindings as Record<string, unknown> | undefined)
          ?.ttlHours,
      ).toBeUndefined();
      expect(
        (
          snap.sourceConfig.channels?.discord?.accounts?.alpha?.threadBindings as
            | Record<string, unknown>
            | undefined
        )?.ttlHours,
      ).toBeUndefined();
    });
  });

  it("accepts legacy channel streaming aliases via auto-migration and reports legacyIssues", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        channels: {
          telegram: {
            streamMode: "block",
          },
          discord: {
            streaming: false,
            accounts: {
              work: {
                streamMode: "block",
              },
            },
          },
          googlechat: {
            streamMode: "append",
            accounts: {
              work: {
                streamMode: "replace",
              },
            },
          },
          slack: {
            streaming: true,
          },
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "channels.telegram")).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "channels.discord")).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "channels.discord.accounts")).toBe(
        true,
      );
      expect(snap.legacyIssues.some((issue) => issue.path === "channels.googlechat")).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "channels.googlechat.accounts")).toBe(
        true,
      );
      expect(snap.legacyIssues.some((issue) => issue.path === "channels.slack")).toBe(true);
      expect(snap.sourceConfig.channels?.telegram).toMatchObject({
        streaming: "block",
      });
      expect(
        (snap.sourceConfig.channels?.telegram as Record<string, unknown> | undefined)?.streamMode,
      ).toBeUndefined();
      expect(snap.sourceConfig.channels?.discord).toMatchObject({
        streaming: "off",
      });
      expect(snap.sourceConfig.channels?.discord?.accounts?.work).toMatchObject({
        streaming: "block",
      });
      expect(
        (snap.sourceConfig.channels?.googlechat as Record<string, unknown> | undefined)?.streamMode,
      ).toBeUndefined();
      expect(
        (
          snap.sourceConfig.channels?.googlechat?.accounts?.work as
            | Record<string, unknown>
            | undefined
        )?.streamMode,
      ).toBeUndefined();
      expect(snap.sourceConfig.channels?.slack).toMatchObject({
        streaming: "partial",
        nativeStreaming: true,
      });
    });
  });

  it("accepts legacy nested channel allow aliases via auto-migration and reports legacyIssues", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        channels: {
          slack: {
            channels: {
              ops: {
                allow: false,
              },
            },
            accounts: {
              work: {
                channels: {
                  general: {
                    allow: true,
                  },
                },
              },
            },
          },
          googlechat: {
            groups: {
              "spaces/aaa": {
                allow: false,
              },
            },
            accounts: {
              work: {
                groups: {
                  "spaces/bbb": {
                    allow: true,
                  },
                },
              },
            },
          },
          discord: {
            guilds: {
              "100": {
                channels: {
                  general: {
                    allow: false,
                  },
                },
              },
            },
            accounts: {
              work: {
                guilds: {
                  "200": {
                    channels: {
                      help: {
                        allow: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "channels.slack")).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "channels.slack.accounts")).toBe(
        true,
      );
      expect(snap.legacyIssues.some((issue) => issue.path === "channels.googlechat")).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "channels.googlechat.accounts")).toBe(
        true,
      );
      expect(snap.legacyIssues.some((issue) => issue.path === "channels.discord")).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "channels.discord.accounts")).toBe(
        true,
      );
      expect(snap.sourceConfig.channels?.slack?.channels?.ops).toMatchObject({
        enabled: false,
      });
      expect(snap.sourceConfig.channels?.googlechat?.groups?.["spaces/aaa"]).toMatchObject({
        enabled: false,
      });
      expect(snap.sourceConfig.channels?.discord?.guilds?.["100"]?.channels?.general).toMatchObject(
        {
          enabled: false,
        },
      );
      expect(
        (snap.sourceConfig.channels?.slack?.channels?.ops as Record<string, unknown> | undefined)
          ?.allow,
      ).toBeUndefined();
      expect(
        (
          snap.sourceConfig.channels?.googlechat?.groups?.["spaces/aaa"] as
            | Record<string, unknown>
            | undefined
        )?.allow,
      ).toBeUndefined();
      expect(
        (
          snap.sourceConfig.channels?.discord?.guilds?.["100"]?.channels?.general as
            | Record<string, unknown>
            | undefined
        )?.allow,
      ).toBeUndefined();
    });
  });

  it("accepts telegram groupMentionsOnly via auto-migration and reports legacyIssues", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        channels: {
          telegram: {
            groupMentionsOnly: true,
          },
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(true);
      expect(
        snap.legacyIssues.some((issue) => issue.path === "channels.telegram.groupMentionsOnly"),
      ).toBe(true);
      expect(snap.sourceConfig.channels?.telegram?.groups?.["*"]).toMatchObject({
        requireMention: true,
      });
      expect(
        (snap.sourceConfig.channels?.telegram as Record<string, unknown> | undefined)
          ?.groupMentionsOnly,
      ).toBeUndefined();
    });
  });

  it("accepts legacy plugins.entries.*.config.tts provider keys via auto-migration", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        plugins: {
          entries: {
            "voice-call": {
              config: {
                tts: {
                  provider: "openai",
                  openai: {
                    model: "gpt-4o-mini-tts",
                    voice: "alloy",
                  },
                },
              },
            },
          },
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "plugins.entries")).toBe(true);
      const voiceCallTts = (
        snap.sourceConfig.plugins?.entries as
          | Record<
              string,
              {
                config?: {
                  tts?: {
                    providers?: Record<string, unknown>;
                    openai?: unknown;
                  };
                };
              }
            >
          | undefined
      )?.["voice-call"]?.config?.tts;
      expect(voiceCallTts?.providers?.openai).toEqual({
        model: "gpt-4o-mini-tts",
        voice: "alloy",
      });
      expect(voiceCallTts?.openai).toBeUndefined();
    });
  });

  it("accepts legacy discord voice tts provider keys via auto-migration and reports legacyIssues", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        channels: {
          discord: {
            voice: {
              tts: {
                provider: "elevenlabs",
                elevenlabs: {
                  voiceId: "voice-1",
                },
              },
            },
            accounts: {
              main: {
                voice: {
                  tts: {
                    edge: {
                      voice: "en-US-AvaNeural",
                    },
                  },
                },
              },
            },
          },
        },
      });

      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "channels.discord.voice.tts")).toBe(
        true,
      );
      expect(snap.legacyIssues.some((issue) => issue.path === "channels.discord.accounts")).toBe(
        true,
      );
      expect(snap.sourceConfig.channels?.discord?.voice?.tts?.providers?.elevenlabs).toEqual({
        voiceId: "voice-1",
      });
      expect(
        snap.sourceConfig.channels?.discord?.accounts?.main?.voice?.tts?.providers?.microsoft,
      ).toEqual({
        voice: "en-US-AvaNeural",
      });
      expect(
        (snap.sourceConfig.channels?.discord?.voice?.tts as Record<string, unknown> | undefined)
          ?.elevenlabs,
      ).toBeUndefined();
      expect(
        (
          snap.sourceConfig.channels?.discord?.accounts?.main?.voice?.tts as
            | Record<string, unknown>
            | undefined
        )?.edge,
      ).toBeUndefined();
    });
  });

  it("does not treat resolved-only gateway.bind aliases as source-literal legacy or invalid", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        gateway: { bind: "${OPENCLAW_BIND}" },
      });

      const prev = process.env.OPENCLAW_BIND;
      process.env.OPENCLAW_BIND = "0.0.0.0";
      try {
        const snap = await readConfigFileSnapshot();
        expect(snap.valid).toBe(true);
        expect(snap.legacyIssues).toHaveLength(0);
        expect(snap.issues).toHaveLength(0);
      } finally {
        if (prev === undefined) {
          delete process.env.OPENCLAW_BIND;
        } else {
          process.env.OPENCLAW_BIND = prev;
        }
      }
    });
  });

  it("still marks literal gateway.bind host aliases as legacy", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        gateway: { bind: "0.0.0.0" },
      });

      const snap = await readConfigFileSnapshot();
      expect(snap.valid).toBe(true);
      expect(snap.legacyIssues.some((issue) => issue.path === "gateway.bind")).toBe(true);
    });
  });
});
