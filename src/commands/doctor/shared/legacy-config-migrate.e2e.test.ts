import { describe, expect, it } from "vitest";
import { resolveMemorySearchConfig } from "../../../agents/memory-search.js";
import { resolveDefaultAgentWorkspaceDir } from "../../../agents/workspace-default.js";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { validateConfigObjectRaw } from "../../../config/validation.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";

describe("legacy config migration end to end", () => {
  it.each([
    { prefsPath: "/tmp/synthetic-tts.json" },
    { personas: { narrator: { prompt: { style: "Synthetic instruction" } } } },
  ])("converges legacy TTS ownership and retirement in one pass: %j", (tts) => {
    const raw = { messages: { tts: { ...tts, summaryModel: "anthropic/claude-sonnet-4-5" } } };
    const result = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
    expect(result.partiallyValid).toBeUndefined();
    const validation = validateConfigObjectRaw(result.config);
    expect(validation.ok, JSON.stringify(validation)).toBe(true);
    expect(result.config).not.toHaveProperty("messages.tts");
    expect(result.config).not.toHaveProperty("tts.prefsPath");
    expect(result.config).not.toHaveProperty("tts.personas.narrator.prompt");
    expect(result.config?.tts?.summaryModel).toBe("anthropic/claude-sonnet-4-6");
    expect(
      migrateLegacyConfig(result.config, { sourceConfigBeforeMigrations: result.config }),
    ).toEqual({ config: null, changes: [] });
  });

  it.each([
    {
      name: "port repair before origin seeding",
      raw: { gateway: { bind: "lan", port: 70000 } },
      expected: {
        gateway: {
          controlUi: { allowedOrigins: expect.arrayContaining(["http://localhost:18789"]) },
        },
      },
    },
    {
      name: "Deepgram options before media consolidation",
      raw: {
        tools: {
          media: {
            audio: {
              models: [{ provider: "deepgram", model: "nova-2", deepgram: { punctuate: true } }],
            },
          },
        },
      },
      expected: {
        tools: {
          media: {
            models: [
              {
                provider: "deepgram",
                model: "nova-2",
                providerOptions: { deepgram: { punctuate: true } },
                capabilities: ["audio"],
              },
            ],
          },
        },
      },
    },
    {
      name: "memory owner before QMD collections",
      raw: {
        agents: {
          defaults: {
            memorySearch: {
              provider: "none",
              qmd: { extraCollections: [{ path: "/synthetic/qmd", pattern: "**/*.md" }] },
            },
          },
          list: [{ id: "main" }],
        },
      },
      expected: {
        memory: {
          search: {
            provider: "none",
            extraPaths: [{ path: "/synthetic/qmd", pattern: "**/*.md" }],
          },
        },
      },
    },
    {
      name: "session aliases before validation",
      raw: {
        session: {
          maintenance: { pruneDays: 7 },
          resetByType: { dm: { mode: "idle", idleMinutes: 45 } },
        },
      },
      expected: {
        session: {
          maintenance: { pruneAfter: 7 },
          resetByType: { direct: { mode: "idle", idleMinutes: 45 } },
        },
      },
    },
  ])("converges $name in one pass", ({ raw, expected }) => {
    const result = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
    expect(result.partiallyValid).toBeUndefined();
    expect(result.config).toMatchObject(expected);
    expect(validateConfigObjectRaw(result.config).ok).toBe(true);
    expect(findLegacyConfigIssues(result.sourceConfig)).toEqual([]);
    expect(
      migrateLegacyConfig(result.config, { sourceConfigBeforeMigrations: result.config }),
    ).toEqual({ config: null, changes: [] });
  });

  it("reshapes duplicate agent ids deterministically and keeps canonical entries", () => {
    const duplicateRaw = {
      agents: {
        list: [
          { id: "main", name: "first" },
          { id: "main", name: "second" },
        ],
      },
    };
    const duplicate = applyLegacyDoctorMigrations(duplicateRaw, {
      sourceConfigBeforeMigrations: duplicateRaw,
    });
    expect(duplicate.next).toEqual({
      agents: {
        ownership: "explicit",
        defaults: {
          systemAgent: { agentId: "main" },
          heartbeat: { agentId: "main" },
        },
        entries: {
          main: { name: "first", workspace: resolveDefaultAgentWorkspaceDir() },
          "main-2": { name: "second" },
        },
      },
    });
    expect(
      applyLegacyDoctorMigrations(duplicate.next, { sourceConfigBeforeMigrations: duplicate.next }),
    ).toEqual({ next: null, changes: [] });

    const canonicalRaw = {
      agents: { entries: { main: { name: "canonical" } }, list: [{ id: "main", name: "old" }] },
    };
    const canonicalWins = applyLegacyDoctorMigrations(canonicalRaw, {
      sourceConfigBeforeMigrations: canonicalRaw,
    });
    expect(canonicalWins.next).toEqual({ agents: { entries: { main: { name: "canonical" } } } });

    const prototypeRaw = {
      agents: { list: [{ id: "__proto__", name: "prototype-safe" }] },
    };
    const prototypeId = applyLegacyDoctorMigrations(prototypeRaw, {
      sourceConfigBeforeMigrations: prototypeRaw,
    });
    const prototypeEntries = (prototypeId.next?.agents as { entries?: Record<string, unknown> })
      ?.entries;
    expect(Object.hasOwn(prototypeEntries ?? {}, "__proto__")).toBe(true);

    const normalizedRaw = {
      agents: { list: [{ id: "Team Ops", name: "normalized" }] },
    };
    const normalizedId = applyLegacyDoctorMigrations(normalizedRaw, {
      sourceConfigBeforeMigrations: normalizedRaw,
    });
    expect(normalizedId.next).toEqual({
      agents: { entries: { "team-ops": { name: "normalized" } } },
    });
  });

  it("keeps agents.defaults.tts outside the schema", () => {
    expect(validateConfigObjectRaw({ agents: { defaults: { tts: {} } } }).ok).toBe(false);
  });

  it.each([
    {
      name: "defaults-only QMD session indexing",
      canonical: undefined,
      defaults: {
        provider: "none",
        rememberAcrossConversations: false,
        extraPaths: ["/defaults-existing"],
      },
      expectedSources: ["memory", "sessions"],
      expectedPaths: ["/defaults-existing", "/defaults-qmd"],
    },
    {
      name: "explicit canonical privacy and indexing policy",
      canonical: {
        provider: "none",
        rememberAcrossConversations: false,
        experimental: { sessionMemory: false },
        sources: ["memory"],
        extraPaths: ["/canonical"],
      },
      defaults: {
        provider: "openai",
        rememberAcrossConversations: true,
        experimental: { sessionMemory: true },
        extraPaths: ["/defaults-existing"],
      },
      expectedSources: ["memory"],
      expectedPaths: ["/canonical", "/defaults-qmd"],
    },
  ])(
    "migrates $name into validated effective memory settings",
    ({ canonical, defaults, expectedSources, expectedPaths }) => {
      const raw = {
        ...(canonical ? { memory: { search: canonical } } : {}),
        session: { dmScope: "per-peer" },
        agents: {
          entries: { main: {} },
          defaults: {
            memory: {
              search: {
                ...defaults,
                qmd: {
                  sessions: { enabled: true },
                  extraCollections: [{ path: "/defaults-qmd" }],
                },
              },
            },
          },
        },
      };
      const result = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });

      expect(result.partiallyValid).toBeUndefined();
      expect(result.config).not.toHaveProperty("agents.defaults.memory");
      const validation = validateConfigObjectRaw(result.config);
      expect(validation.ok, validation.ok ? undefined : JSON.stringify(validation.issues)).toBe(
        true,
      );
      if (!validation.ok) {
        return;
      }
      const resolved = resolveMemorySearchConfig(validation.config, "main");
      expect(resolved).toMatchObject({
        provider: "none",
        rememberAcrossConversations: false,
        sources: expectedSources,
        searchSources: expectedSources,
        extraPaths: expectedPaths,
      });
      expect(validation.config.memory?.search?.experimental?.sessionMemory).toBe(!canonical);
      expect(
        migrateLegacyConfig(validation.config, { sourceConfigBeforeMigrations: validation.config }),
      ).toEqual({ config: null, changes: [] });
    },
  );

  it("canonicalizes a multi-family legacy config and is idempotent", () => {
    const raw = {
      env: { shellEnv: { enabled: true }, API_ORIGIN: "https://example.test" },
      agents: {
        defaults: {
          pdfMaxBytesMb: 12,
          imageGenerationModel: "openai/image-1",
          promptOverlays: { gpt5: { personality: "off" } },
          envelopeTimestamp: "off",
          sandbox: { browser: { enableNoVnc: false } },
        },
        list: [{ id: "main", name: "Main", tools: { exec: { timeoutSec: 45 } } }],
      },
      tools: { exec: { timeoutSec: 30 } },
      media: { ttlHours: 24, preserveFilenames: true },
      audit: { enabled: false, messages: "direct" },
      diagnostics: {
        otel: { captureContent: { enabled: false, toolInputs: true } },
        cacheTrace: { enabled: true, filePath: "/tmp/trace.jsonl", includePrompt: false },
      },
      browser: {
        color: "#ffffff",
        ssrfPolicy: { allowedHostnames: ["localhost"], hostnameAllowlist: ["*.example.com"] },
        profiles: { chrome: { driver: "extension", color: "#000000" } },
      },
      gateway: {
        reload: { mode: "hot" },
        nodes: {
          skills: { enabled: false },
          allowCommands: ["camera.snap"],
          denyCommands: ["system.run"],
        },
        controlUi: { chatMessageMaxWidth: "82%" },
      },
      logging: { consoleStyle: "compact" },
      cron: { failureDestination: { channel: "telegram", to: "123" } },
      messages: {
        statusReactions: { enabled: true, emojis: { done: "✅" } },
        removeAckAfterReply: true,
      },
      channels: {
        defaults: { heartbeat: { showOk: true } },
        slack: {
          identity: "user",
          groupPolicy: "allowlist",
          dmPolicy: "pairing",
          mode: "socket",
          webhookPath: "/slack/events",
          userTokenReadOnly: true,
          socketMode: { clientPingTimeout: 1000 },
        },
        whatsapp: {
          dmPolicy: "pairing",
          groupPolicy: "allowlist",
          mediaMaxMb: 50,
          debounceMs: 0,
          messagePrefix: "[wa]",
          ackReaction: { emoji: "👀", direct: false, group: "mentions" },
        },
        imessage: {
          dmPolicy: "pairing",
          groupPolicy: "allowlist",
          coalesceSameSenderDms: true,
        },
      },
      mcp: {
        servers: {
          docs: {
            command: "docs",
            workingDirectory: "/tmp/docs",
            supports_parallel_tool_calls: true,
            ssl_verify: false,
            codex: { default_tools_approval_mode: "prompt" },
          },
        },
      },
    };
    const result = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });

    expect(result.partiallyValid).toBeUndefined();
    expect(result.config).toMatchObject({
      env: { shellEnv: { enabled: true }, vars: { API_ORIGIN: "https://example.test" } },
      agents: {
        defaults: { pdfMaxMb: 12, mediaModels: { image: "openai/image-1" } },
        entries: { main: { name: "Main", tools: { exec: { timeoutSeconds: 45 } } } },
      },
      plugins: { entries: { openai: { config: { personality: "off" } } } },
      tools: { exec: { timeoutSeconds: 30 } },
      attachments: { ttlHours: 24 },
      logging: { consoleStyle: "pretty", audit: { enabled: false, messages: "direct" } },
      diagnostics: { otel: { captureContent: false }, cacheTrace: { enabled: true } },
      gateway: {
        reload: { mode: "hybrid" },
        nodes: { allowSkills: false, commands: { allow: ["camera.snap"], deny: ["system.run"] } },
      },
      cron: { failureAlert: { channel: "telegram", to: "123" } },
      messages: { inbound: { byChannel: { whatsapp: 0 } } },
      channels: {
        defaults: { heartbeatVisibility: { showOk: true } },
        slack: { postAs: "user" },
        whatsapp: { responsePrefix: "[wa]" },
      },
      mcp: {
        servers: {
          docs: {
            command: "docs",
            cwd: "/tmp/docs",
            supportsParallelToolCalls: true,
            sslVerify: false,
            codex: { defaultToolsApprovalMode: "prompt" },
          },
        },
      },
    });
    expect(result.changes).toContain(
      "Moved agents.defaults.promptOverlays.gpt5.personality → plugins.entries.openai.config.personality.",
    );
    const validation = validateConfigObjectRaw(result.config);
    expect(validation.ok, validation.ok ? undefined : JSON.stringify(validation.issues)).toBe(true);
    expect(
      applyLegacyDoctorMigrations(result.config, { sourceConfigBeforeMigrations: result.config }),
    ).toEqual({ next: null, changes: [] });
    const serialized = JSON.stringify(result.config);
    for (const key of [
      "pdfMaxBytesMb",
      "timeoutSec",
      "hostnameAllowlist",
      "enableNoVnc",
      "preserveFilenames",
      "ownerDisplay",
      "removeAckAfterReply",
    ]) {
      expect(serialized).not.toContain(`"${key}"`);
    }
  });

  it("loads WhatsApp-owned acknowledgement migration guidance", () => {
    const raw = {
      channels: {
        whatsapp: {
          ackReaction: { emoji: "👀", direct: true, group: "mentions" },
        },
      },
    };
    const result = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });

    expect(result.sourceConfig?.messages).toEqual({ ackReaction: "👀" });
    expect(result.config?.channels?.whatsapp?.ackReaction).toBeUndefined();
    expect(result.changes.join("\n")).toContain(
      "cannot preserve both direct-message and mentioned-group acknowledgements",
    );
  });

  it("preserves canonical OpenAI personality over the retired prompt overlay", () => {
    const raw = {
      agents: { defaults: { promptOverlays: { gpt5: { personality: "off" } } } },
      plugins: { entries: { openai: { config: { personality: "friendly" } } } },
    };
    const result = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });

    expect(result.config?.plugins?.entries?.openai?.config?.personality).toBe("friendly");
    expect(result.config?.agents?.defaults?.promptOverlays).toBeUndefined();
    expect(result.changes).toContain(
      "Removed agents.defaults.promptOverlays.gpt5.personality (plugins.entries.openai.config.personality already set).",
    );
  });

  it("repairs unsupported OTel grpc once and is then a no-op", () => {
    const raw = {
      diagnostics: {
        otel: {
          enabled: true,
          traces: false,
          metrics: false,
          logs: true,
          logsExporter: "stdout",
          protocol: "grpc",
        },
      },
    };
    const result = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });

    expect(result.config?.diagnostics?.otel).toEqual({
      enabled: true,
      traces: false,
      metrics: false,
      logs: true,
      logsExporter: "stdout",
    });
    expect(validateConfigObjectRaw(result.config).ok).toBe(true);
    expect(
      applyLegacyDoctorMigrations(result.config, { sourceConfigBeforeMigrations: result.config }),
    ).toEqual({ next: null, changes: [] });
  });

  it("migrates route and ACP dm peer kinds through validation and is idempotent", () => {
    const raw = {
      agents: { entries: { main: {} } },
      bindings: [
        {
          type: "route",
          agentId: "main",
          match: { channel: "telegram", peer: { kind: "dm", id: "123" } },
        },
        {
          type: "acp",
          agentId: "main",
          match: { channel: "discord", peer: { kind: "dm", id: "456" } },
          acp: { mode: "persistent" },
        },
        {
          type: "route",
          agentId: "main",
          match: { channel: "telegram", peer: { kind: "direct", id: "789" } },
        },
        {
          type: "route",
          agentId: "main",
          match: { channel: "discord", peer: { kind: "group", id: "abc" } },
        },
      ],
    };

    expect(findLegacyConfigIssues(raw)).toEqual([expect.objectContaining({ path: "bindings" })]);

    const res = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
    const bindings = res.config?.bindings as Array<{ match?: { peer?: { kind?: unknown } } }>;
    expect(bindings.map((binding) => binding.match?.peer?.kind)).toEqual([
      "direct",
      "direct",
      "direct",
      "group",
    ]);
    expect(res.changes).toContain(
      'Moved deprecated bindings[].match.peer.kind "dm" → "direct" for 2 bindings.',
    );
    expect(res.partiallyValid).toBeUndefined();
    const validation = validateConfigObjectRaw(res.config);
    expect(validation.ok, validation.ok ? undefined : JSON.stringify(validation.issues)).toBe(true);
    expect(migrateLegacyConfig(res.config, { sourceConfigBeforeMigrations: res.config })).toEqual({
      config: null,
      changes: [],
    });
  });

  it("rewrites only exact dm values and leaves malformed peer kinds visible to validation", () => {
    const raw = {
      bindings: [
        {
          type: "route",
          agentId: "main",
          match: { channel: "telegram", peer: { kind: "dm", id: "exact" } },
        },
        {
          type: "route",
          agentId: "main",
          match: { channel: "telegram", peer: { kind: "DM", id: "uppercase" } },
        },
        {
          type: "route",
          agentId: "main",
          match: { channel: "telegram", peer: { kind: " dm ", id: "spaced" } },
        },
        {
          type: "route",
          agentId: "main",
          match: { channel: "telegram", peer: { kind: 42, id: "number" } },
        },
      ],
    };

    expect(findLegacyConfigIssues(raw)).toEqual([expect.objectContaining({ path: "bindings" })]);

    const res = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
    const bindings =
      (
        res.config as {
          bindings?: Array<{ match?: { peer?: { kind?: unknown } } }>;
        }
      )?.bindings ?? [];
    expect(bindings.map((binding) => binding.match?.peer?.kind)).toEqual([
      "direct",
      "DM",
      " dm ",
      42,
    ]);
    expect(res.changes).toContain(
      'Moved deprecated bindings[].match.peer.kind "dm" → "direct" for 1 binding.',
    );
    expect(res.partiallyValid).toBe(true);
    expect(validateConfigObjectRaw(res.config).ok).toBe(false);
  });
});
