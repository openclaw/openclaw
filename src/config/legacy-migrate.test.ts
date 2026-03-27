import { describe, expect, it } from "vitest";
import { migrateLegacyConfig } from "./legacy-migrate.js";

describe("legacy migrate audio transcription", () => {
  it("does not rewrite removed routing.transcribeAudio migrations", () => {
    const res = migrateLegacyConfig({
      routing: {
        transcribeAudio: {
          command: ["whisper", "--model", "base"],
          timeoutSeconds: 2,
        },
      },
    });

    expect(res.changes).toEqual([]);
    expect(res.config).toBeNull();
  });

  it("does not rewrite removed routing.transcribeAudio migrations when new config exists", () => {
    const res = migrateLegacyConfig({
      routing: {
        transcribeAudio: {
          command: ["whisper", "--model", "tiny"],
        },
      },
      tools: {
        media: {
          audio: {
            models: [{ command: "existing", type: "cli" }],
          },
        },
      },
    });

    expect(res.changes).toEqual([]);
    expect(res.config).toBeNull();
  });

  it("drops invalid audio.transcription payloads", () => {
    const res = migrateLegacyConfig({
      audio: {
        transcription: {
          command: [{}],
        },
      },
    });

    expect(res.changes).toContain("Removed audio.transcription (invalid or empty command).");
    expect(res.config?.audio).toBeUndefined();
    expect(res.config?.tools?.media?.audio).toBeUndefined();
  });
});

describe("legacy migrate mention routing", () => {
  it("does not rewrite removed routing.groupChat.requireMention migrations", () => {
    const res = migrateLegacyConfig({
      routing: {
        groupChat: {
          requireMention: true,
        },
      },
    });

    expect(res.changes).toEqual([]);
    expect(res.config).toBeNull();
  });

  it("does not rewrite removed channels.telegram.requireMention migrations", () => {
    const res = migrateLegacyConfig({
      channels: {
        telegram: {
          requireMention: false,
        },
      },
    });

    expect(res.changes).toEqual([]);
    expect(res.config).toBeNull();
  });
});

describe("legacy migrate heartbeat config", () => {
  it("moves top-level heartbeat into agents.defaults.heartbeat", () => {
    const res = migrateLegacyConfig({
      heartbeat: {
        model: "anthropic/claude-3-5-haiku-20241022",
        every: "30m",
      },
    });

    expect(res.changes).toContain("Moved heartbeat → agents.defaults.heartbeat.");
    expect(res.config?.agents?.defaults?.heartbeat).toEqual({
      model: "anthropic/claude-3-5-haiku-20241022",
      every: "30m",
    });
    expect((res.config as { heartbeat?: unknown } | null)?.heartbeat).toBeUndefined();
  });

  it("moves top-level heartbeat visibility into channels.defaults.heartbeat", () => {
    const res = migrateLegacyConfig({
      heartbeat: {
        showOk: true,
        showAlerts: false,
        useIndicator: false,
      },
    });

    expect(res.changes).toContain("Moved heartbeat visibility → channels.defaults.heartbeat.");
    expect(res.config?.channels?.defaults?.heartbeat).toEqual({
      showOk: true,
      showAlerts: false,
      useIndicator: false,
    });
    expect((res.config as { heartbeat?: unknown } | null)?.heartbeat).toBeUndefined();
  });

  it("keeps explicit agents.defaults.heartbeat values when merging top-level heartbeat", () => {
    const res = migrateLegacyConfig({
      heartbeat: {
        model: "anthropic/claude-3-5-haiku-20241022",
        every: "30m",
      },
      agents: {
        defaults: {
          heartbeat: {
            every: "1h",
            target: "telegram",
          },
        },
      },
    });

    expect(res.changes).toContain(
      "Merged heartbeat → agents.defaults.heartbeat (filled missing fields from legacy; kept explicit agents.defaults values).",
    );
    expect(res.config?.agents?.defaults?.heartbeat).toEqual({
      every: "1h",
      target: "telegram",
      model: "anthropic/claude-3-5-haiku-20241022",
    });
    expect((res.config as { heartbeat?: unknown } | null)?.heartbeat).toBeUndefined();
  });

  it("keeps explicit channels.defaults.heartbeat values when merging top-level heartbeat visibility", () => {
    const res = migrateLegacyConfig({
      heartbeat: {
        showOk: true,
        showAlerts: true,
      },
      channels: {
        defaults: {
          heartbeat: {
            showOk: false,
            useIndicator: false,
          },
        },
      },
    });

    expect(res.changes).toContain(
      "Merged heartbeat visibility → channels.defaults.heartbeat (filled missing fields from legacy; kept explicit channels.defaults values).",
    );
    expect(res.config?.channels?.defaults?.heartbeat).toEqual({
      showOk: false,
      showAlerts: true,
      useIndicator: false,
    });
    expect((res.config as { heartbeat?: unknown } | null)?.heartbeat).toBeUndefined();
  });

  it("preserves agents.defaults.heartbeat precedence over top-level heartbeat legacy key", () => {
    const res = migrateLegacyConfig({
      agents: {
        defaults: {
          heartbeat: {
            every: "1h",
            target: "telegram",
          },
        },
      },
      heartbeat: {
        every: "30m",
        target: "discord",
        model: "anthropic/claude-3-5-haiku-20241022",
      },
    });

    expect(res.config?.agents?.defaults?.heartbeat).toEqual({
      every: "1h",
      target: "telegram",
      model: "anthropic/claude-3-5-haiku-20241022",
    });
    expect((res.config as { heartbeat?: unknown } | null)?.heartbeat).toBeUndefined();
  });

  it("drops blocked prototype keys when migrating top-level heartbeat", () => {
    const res = migrateLegacyConfig(
      JSON.parse(
        '{"heartbeat":{"every":"30m","__proto__":{"polluted":true},"showOk":true}}',
      ) as Record<string, unknown>,
    );

    const heartbeat = res.config?.agents?.defaults?.heartbeat as
      | Record<string, unknown>
      | undefined;
    expect(heartbeat?.every).toBe("30m");
    expect((heartbeat as { polluted?: unknown } | undefined)?.polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(heartbeat ?? {}, "__proto__")).toBe(false);
    expect(res.config?.channels?.defaults?.heartbeat).toEqual({ showOk: true });
  });

  it("records a migration change when removing empty top-level heartbeat", () => {
    const res = migrateLegacyConfig({
      heartbeat: {},
    });

    expect(res.changes).toContain("Removed empty top-level heartbeat.");
    expect(res.config).not.toBeNull();
    expect((res.config as { heartbeat?: unknown } | null)?.heartbeat).toBeUndefined();
  });
});

describe("legacy migrate controlUi.allowedOrigins seed (issue #29385)", () => {
  it("seeds allowedOrigins for bind=lan with no existing controlUi config", () => {
    const res = migrateLegacyConfig({
      gateway: {
        bind: "lan",
        auth: { mode: "token", token: "tok" },
      },
    });
    expect(res.config?.gateway?.controlUi?.allowedOrigins).toEqual([
      "http://localhost:18789",
      "http://127.0.0.1:18789",
    ]);
    expect(res.changes.some((c) => c.includes("gateway.controlUi.allowedOrigins"))).toBe(true);
    expect(res.changes.some((c) => c.includes("bind=lan"))).toBe(true);
  });

  it("seeds allowedOrigins using configured port", () => {
    const res = migrateLegacyConfig({
      gateway: {
        bind: "lan",
        port: 9000,
        auth: { mode: "token", token: "tok" },
      },
    });
    expect(res.config?.gateway?.controlUi?.allowedOrigins).toEqual([
      "http://localhost:9000",
      "http://127.0.0.1:9000",
    ]);
  });

  it("seeds allowedOrigins including custom bind host for bind=custom", () => {
    const res = migrateLegacyConfig({
      gateway: {
        bind: "custom",
        customBindHost: "192.168.1.100",
        auth: { mode: "token", token: "tok" },
      },
    });
    expect(res.config?.gateway?.controlUi?.allowedOrigins).toContain("http://192.168.1.100:18789");
    expect(res.config?.gateway?.controlUi?.allowedOrigins).toContain("http://localhost:18789");
  });

  it("does not overwrite existing allowedOrigins — returns null (no migration needed)", () => {
    // When allowedOrigins already exists, the migration is a no-op.
    // applyLegacyMigrations returns next=null when changes.length===0, so config is null.
    const res = migrateLegacyConfig({
      gateway: {
        bind: "lan",
        auth: { mode: "token", token: "tok" },
        controlUi: { allowedOrigins: ["https://control.example.com"] },
      },
    });
    expect(res.config).toBeNull();
    expect(res.changes).toHaveLength(0);
  });

  it("does not migrate when dangerouslyAllowHostHeaderOriginFallback is set — returns null", () => {
    const res = migrateLegacyConfig({
      gateway: {
        bind: "lan",
        auth: { mode: "token", token: "tok" },
        controlUi: { dangerouslyAllowHostHeaderOriginFallback: true },
      },
    });
    expect(res.config).toBeNull();
    expect(res.changes).toHaveLength(0);
  });

  it("seeds allowedOrigins when existing entries are blank strings", () => {
    const res = migrateLegacyConfig({
      gateway: {
        bind: "lan",
        auth: { mode: "token", token: "tok" },
        controlUi: { allowedOrigins: ["", "   "] },
      },
    });
    expect(res.config?.gateway?.controlUi?.allowedOrigins).toEqual([
      "http://localhost:18789",
      "http://127.0.0.1:18789",
    ]);
    expect(res.changes.some((c) => c.includes("gateway.controlUi.allowedOrigins"))).toBe(true);
  });

  it("does not migrate loopback bind — returns null", () => {
    const res = migrateLegacyConfig({
      gateway: {
        bind: "loopback",
        auth: { mode: "token", token: "tok" },
      },
    });
    expect(res.config).toBeNull();
    expect(res.changes).toHaveLength(0);
  });

  it("preserves existing controlUi fields when seeding allowedOrigins", () => {
    const res = migrateLegacyConfig({
      gateway: {
        bind: "lan",
        auth: { mode: "token", token: "tok" },
        controlUi: { basePath: "/app" },
      },
    });
    expect(res.config?.gateway?.controlUi?.basePath).toBe("/app");
    expect(res.config?.gateway?.controlUi?.allowedOrigins).toEqual([
      "http://localhost:18789",
      "http://127.0.0.1:18789",
    ]);
  });
});

describe("legacy migrate TTS config", () => {
  it("moves messages.tts.microsoft into messages.tts.providers.microsoft", () => {
    const res = migrateLegacyConfig({
      messages: {
        tts: {
          microsoft: {
            enabled: true,
            voice: "en-US-AriaNeural",
            lang: "en-US",
          },
        },
      },
    });

    expect(res.changes).toContain(
      "Moved messages.tts.microsoft → messages.tts.providers.microsoft.",
    );
    expect(res.config?.messages?.tts?.providers?.microsoft).toEqual({
      enabled: true,
      voice: "en-US-AriaNeural",
      lang: "en-US",
    });
    expect(
      (res.config?.messages?.tts as { microsoft?: unknown } | null)?.microsoft,
    ).toBeUndefined();
  });

  it("moves messages.tts.edge into messages.tts.providers.microsoft", () => {
    const res = migrateLegacyConfig({
      messages: {
        tts: {
          edge: {
            enabled: true,
            voice: "en-US-JennyNeural",
          },
        },
      },
    });

    expect(res.changes).toContain("Moved messages.tts.edge → messages.tts.providers.microsoft.");
    expect(res.config?.messages?.tts?.providers?.microsoft).toEqual({
      enabled: true,
      voice: "en-US-JennyNeural",
    });
    expect((res.config?.messages?.tts as { edge?: unknown } | null)?.edge).toBeUndefined();
  });

  it("moves messages.tts.openai into messages.tts.providers.openai", () => {
    const res = migrateLegacyConfig({
      messages: {
        tts: {
          openai: {
            apiKey: "sk-test",
            voice: "alloy",
          },
        },
      },
    });

    expect(res.changes).toContain("Moved messages.tts.openai → messages.tts.providers.openai.");
    expect(res.config?.messages?.tts?.providers?.openai).toEqual({
      apiKey: "sk-test",
      voice: "alloy",
    });
    expect((res.config?.messages?.tts as { openai?: unknown } | null)?.openai).toBeUndefined();
  });

  it("moves messages.tts.elevenlabs into messages.tts.providers.elevenlabs", () => {
    const res = migrateLegacyConfig({
      messages: {
        tts: {
          elevenlabs: {
            apiKey: "xi-test",
            voiceId: "voice-123",
          },
        },
      },
    });

    expect(res.changes).toContain(
      "Moved messages.tts.elevenlabs → messages.tts.providers.elevenlabs.",
    );
    expect(res.config?.messages?.tts?.providers?.elevenlabs).toEqual({
      apiKey: "xi-test",
      voiceId: "voice-123",
    });
    expect(
      (res.config?.messages?.tts as { elevenlabs?: unknown } | null)?.elevenlabs,
    ).toBeUndefined();
  });

  it("merges legacy TTS config with existing providers", () => {
    const res = migrateLegacyConfig({
      messages: {
        tts: {
          providers: {
            microsoft: {
              voice: "existing-voice",
            },
          },
          microsoft: {
            enabled: true,
            voice: "legacy-voice",
            lang: "en-US",
          },
        },
      },
    });

    expect(res.changes).toContain(
      "Moved messages.tts.microsoft → messages.tts.providers.microsoft.",
    );
    // Existing config should be authoritative; legacy fills gaps
    expect(res.config?.messages?.tts?.providers?.microsoft).toEqual({
      voice: "existing-voice", // Kept from existing
      enabled: true, // Filled from legacy
      lang: "en-US", // Filled from legacy
    });
  });

  it("does not migrate when no legacy TTS keys exist — returns null", () => {
    const res = migrateLegacyConfig({
      messages: {
        tts: {
          providers: {
            microsoft: {
              enabled: true,
            },
          },
        },
      },
    });

    expect(res.config).toBeNull();
    expect(res.changes).toHaveLength(0);
  });

  it("moves channels.discord.voice.tts.microsoft into channels.discord.voice.tts.providers.microsoft", () => {
    const res = migrateLegacyConfig({
      channels: {
        discord: {
          voice: {
            tts: {
              microsoft: {
                enabled: true,
                voice: "en-US-AriaNeural",
              },
            },
          },
        },
      },
    });

    expect(res.changes).toContain(
      "Moved channels.discord.voice.tts.microsoft → channels.discord.voice.tts.providers.microsoft.",
    );
    expect(res.config?.channels?.discord?.voice?.tts?.providers?.microsoft).toEqual({
      enabled: true,
      voice: "en-US-AriaNeural",
    });
    expect(
      (res.config?.channels?.discord?.voice?.tts as { microsoft?: unknown } | null)?.microsoft,
    ).toBeUndefined();
  });

  it("moves channels.discord.voice.tts.edge into channels.discord.voice.tts.providers.microsoft", () => {
    const res = migrateLegacyConfig({
      channels: {
        discord: {
          voice: {
            tts: {
              edge: {
                enabled: true,
                voice: "en-US-JennyNeural",
              },
            },
          },
        },
      },
    });

    expect(res.changes).toContain(
      "Moved channels.discord.voice.tts.edge → channels.discord.voice.tts.providers.microsoft.",
    );
    expect(res.config?.channels?.discord?.voice?.tts?.providers?.microsoft).toEqual({
      enabled: true,
      voice: "en-US-JennyNeural",
    });
    expect(
      (res.config?.channels?.discord?.voice?.tts as { edge?: unknown } | null)?.edge,
    ).toBeUndefined();
  });

  it("moves channels.discord.voice.tts.openai into channels.discord.voice.tts.providers.openai", () => {
    const res = migrateLegacyConfig({
      channels: {
        discord: {
          voice: {
            tts: {
              openai: {
                apiKey: "sk-test",
                voice: "alloy",
              },
            },
          },
        },
      },
    });

    expect(res.changes).toContain(
      "Moved channels.discord.voice.tts.openai → channels.discord.voice.tts.providers.openai.",
    );
    expect(res.config?.channels?.discord?.voice?.tts?.providers?.openai).toEqual({
      apiKey: "sk-test",
      voice: "alloy",
    });
    expect(
      (res.config?.channels?.discord?.voice?.tts as { openai?: unknown } | null)?.openai,
    ).toBeUndefined();
  });

  it("moves channels.discord.voice.tts.elevenlabs into channels.discord.voice.tts.providers.elevenlabs", () => {
    const res = migrateLegacyConfig({
      channels: {
        discord: {
          voice: {
            tts: {
              elevenlabs: {
                apiKey: "xi-test",
                voiceId: "voice-123",
              },
            },
          },
        },
      },
    });

    expect(res.changes).toContain(
      "Moved channels.discord.voice.tts.elevenlabs → channels.discord.voice.tts.providers.elevenlabs.",
    );
    expect(res.config?.channels?.discord?.voice?.tts?.providers?.elevenlabs).toEqual({
      apiKey: "xi-test",
      voiceId: "voice-123",
    });
    expect(
      (res.config?.channels?.discord?.voice?.tts as { elevenlabs?: unknown } | null)?.elevenlabs,
    ).toBeUndefined();
  });

  it("merges legacy Discord voice TTS config with existing providers", () => {
    const res = migrateLegacyConfig({
      channels: {
        discord: {
          voice: {
            tts: {
              providers: {
                microsoft: {
                  voice: "existing-voice",
                },
              },
              microsoft: {
                enabled: true,
                voice: "legacy-voice",
                lang: "en-US",
              },
            },
          },
        },
      },
    });

    expect(res.changes).toContain(
      "Moved channels.discord.voice.tts.microsoft → channels.discord.voice.tts.providers.microsoft.",
    );
    // Existing config should be authoritative; legacy fills gaps
    expect(res.config?.channels?.discord?.voice?.tts?.providers?.microsoft).toEqual({
      voice: "existing-voice", // Kept from existing
      enabled: true, // Filled from legacy
      lang: "en-US", // Filled from legacy
    });
  });

  it("moves channels.discord.accounts.{id}.voice.tts.microsoft into providers", () => {
    const res = migrateLegacyConfig({
      channels: {
        discord: {
          accounts: {
            work: {
              voice: {
                tts: {
                  microsoft: {
                    enabled: true,
                    voice: "en-US-AriaNeural",
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(res.changes).toContain(
      "Moved channels.discord.accounts.work.voice.tts.microsoft → channels.discord.accounts.work.voice.tts.providers.microsoft.",
    );
    expect(res.config?.channels?.discord?.accounts?.work?.voice?.tts?.providers?.microsoft).toEqual(
      {
        enabled: true,
        voice: "en-US-AriaNeural",
      },
    );
    expect(
      (res.config?.channels?.discord?.accounts?.work?.voice?.tts as { microsoft?: unknown } | null)
        ?.microsoft,
    ).toBeUndefined();
  });

  it("moves channels.discord.accounts.{id}.voice.tts.edge into providers", () => {
    const res = migrateLegacyConfig({
      channels: {
        discord: {
          accounts: {
            work: {
              voice: {
                tts: {
                  edge: {
                    enabled: true,
                    voice: "en-US-JennyNeural",
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(res.changes).toContain(
      "Moved channels.discord.accounts.work.voice.tts.edge → channels.discord.accounts.work.voice.tts.providers.microsoft.",
    );
    expect(res.config?.channels?.discord?.accounts?.work?.voice?.tts?.providers?.microsoft).toEqual(
      {
        enabled: true,
        voice: "en-US-JennyNeural",
      },
    );
    expect(
      (res.config?.channels?.discord?.accounts?.work?.voice?.tts as { edge?: unknown } | null)
        ?.edge,
    ).toBeUndefined();
  });

  it("detects legacy TTS keys at account level", () => {
    const res = migrateLegacyConfig({
      channels: {
        discord: {
          accounts: {
            ops: {
              voice: {
                tts: {
                  openai: {
                    apiKey: "sk-test",
                    voice: "alloy",
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(res.changes).toContain(
      "Moved channels.discord.accounts.ops.voice.tts.openai → channels.discord.accounts.ops.voice.tts.providers.openai.",
    );
    expect(res.config?.channels?.discord?.accounts?.ops?.voice?.tts?.providers?.openai).toEqual({
      apiKey: "sk-test",
      voice: "alloy",
    });
  });

  it("does not trigger migration when Discord accounts have only providers", () => {
    const res = migrateLegacyConfig({
      channels: {
        discord: {
          accounts: {
            work: {
              voice: {
                tts: {
                  providers: {
                    microsoft: {
                      enabled: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    // Should return null (no changes) since there are no legacy keys
    expect(res.config).toBeNull();
    expect(res.changes).toHaveLength(0);
  });

  it("does not flag valid TTS config fields as legacy keys", () => {
    const res = migrateLegacyConfig({
      channels: {
        discord: {
          accounts: {
            work: {
              voice: {
                tts: {
                  enabled: true,
                  auto: true,
                  mode: "fallback",
                  provider: "microsoft",
                  providers: {
                    microsoft: {
                      enabled: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    // Should return null (no changes) since enabled, auto, mode, provider are valid TTS config fields
    expect(res.config).toBeNull();
    expect(res.changes).toHaveLength(0);
  });
});
