import { describe, expect, it } from "vitest";
import { resolveMemorySearchConfig } from "../../../agents/memory-search.js";
import { resolveDefaultAgentWorkspaceDir } from "../../../agents/workspace-default.js";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import type { OpenClawConfigWithLegacyRoster } from "../../../config/legacy.roster.js";
import { validateConfigObjectRaw } from "../../../config/validation.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";

const migrate = (raw: unknown) => migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
const apply = (raw: unknown) =>
  applyLegacyDoctorMigrations(raw, { sourceConfigBeforeMigrations: raw });
const mediaConfig = (media: Record<string, unknown>) => ({ tools: { media } });
function expectIdempotent(raw: unknown) {
  expect(migrate(raw)).toEqual({ config: null, changes: [] });
}
function expectValid(raw: unknown) {
  const validation = validateConfigObjectRaw(raw);
  expect(validation.ok, JSON.stringify(validation)).toBe(true);
  if (!validation.ok) {
    throw new Error("Expected a valid migrated config");
  }
  return validation.config;
}

describe("legacy config migration end to end", () => {
  it.each([
    { prefsPath: "/tmp/synthetic-tts.json" },
    { personas: { narrator: { prompt: { style: "Synthetic instruction" } } } },
  ])("converges legacy TTS ownership without replacing its model: %j", (tts) => {
    const raw = { messages: { tts: { ...tts, summaryModel: "anthropic/claude-sonnet-4-5" } } };
    const result = migrate(raw);
    expect(result.partiallyValid).toBeUndefined();
    expectValid(result.config);
    expect(result.config).not.toHaveProperty("messages.tts");
    expect(result.config).not.toHaveProperty("tts.prefsPath");
    expect(result.config).not.toHaveProperty("tts.personas.narrator.prompt");
    expect(result.config?.tts?.summaryModel).toBe("anthropic/claude-sonnet-4-5");
    expectIdempotent(result.config);
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
      name: "malformed media model rows",
      raw: mediaConfig({
        models: [null, "invalid", 42, false, [], { provider: "openai", model: "whisper-1" }],
        audio: {
          models: [null, "invalid", 42, false, [], { provider: "deepgram", model: "nova-2" }],
        },
      }),
      expected: mediaConfig({
        models: [
          { provider: "deepgram", model: "nova-2", capabilities: ["audio"] },
          { provider: "openai", model: "whisper-1" },
        ],
      }),
    },
    {
      name: "Deepgram options before media consolidation",
      raw: mediaConfig({
        audio: {
          models: [{ provider: "deepgram", model: "nova-2", deepgram: { punctuate: true } }],
        },
      }),
      expected: mediaConfig({
        models: [
          {
            provider: "deepgram",
            model: "nova-2",
            providerOptions: { deepgram: { punctuate: true } },
            capabilities: ["audio"],
          },
        ],
      }),
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
    const result = migrate(raw);
    expect(result.partiallyValid).toBeUndefined();
    expect(result.config).toMatchObject(expected);
    expectValid(result.config);
    expect(findLegacyConfigIssues(result.sourceConfig)).toEqual([]);
    expectIdempotent(result.config);
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
    const duplicate = apply(duplicateRaw);
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
    expect(apply(duplicate.next)).toEqual({ next: null, changes: [] });

    const canonicalRaw = {
      agents: { entries: { main: { name: "canonical" } }, list: [{ id: "main", name: "old" }] },
    };
    const canonicalWins = apply(canonicalRaw);
    expect(canonicalWins.next).toEqual({ agents: { entries: { main: { name: "canonical" } } } });

    const prototypeRaw = {
      agents: { list: [{ id: "__proto__", name: "prototype-safe" }] },
    };
    const prototypeId = apply(prototypeRaw);
    const prototypeEntries = (prototypeId.next?.agents as { entries?: Record<string, unknown> })
      ?.entries;
    expect(Object.hasOwn(prototypeEntries ?? {}, "__proto__")).toBe(true);

    const normalizedRaw = {
      agents: { list: [{ id: "Team Ops", name: "normalized" }] },
    };
    const normalizedId = apply(normalizedRaw);
    expect(normalizedId.next).toEqual({
      agents: { entries: { "team-ops": { name: "normalized" } } },
    });
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
      const result = migrate(raw);

      expect(result.partiallyValid).toBeUndefined();
      expect(result.config).not.toHaveProperty("agents.defaults.memory");
      const config = expectValid(result.config);
      const resolved = resolveMemorySearchConfig(config, "main");
      expect(resolved).toMatchObject({
        provider: "none",
        rememberAcrossConversations: false,
        sources: expectedSources,
        searchSources: expectedSources,
        extraPaths: expectedPaths,
      });
      expect(config.memory?.search?.experimental?.sessionMemory).toBe(!canonical);
      expectIdempotent(config);
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
    const result = migrate(raw);

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
    expectValid(result.config);
    expect(apply(result.config)).toEqual({ next: null, changes: [] });
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
    const result = migrate(raw);

    expect(result.sourceConfig?.messages).toEqual({ ackReaction: "👀" });
    expect(result.config?.channels?.whatsapp?.ackReaction).toBeUndefined();
    expect(result.changes.join("\n")).toContain(
      "cannot preserve both direct-message and mentioned-group acknowledgements",
    );
  });

  it("preserves canonical OpenAI personality over the retired prompt overlay", () => {
    const raw: OpenClawConfigWithLegacyRoster = {
      agents: { defaults: { promptOverlays: { gpt5: { personality: "off" } } } },
      plugins: { entries: { openai: { config: { personality: "friendly" } } } },
    };
    const result = migrate(raw);

    expect(result.config?.plugins?.entries?.openai?.config?.personality).toBe("friendly");
    expect(result.config?.agents?.defaults).not.toHaveProperty("promptOverlays");
    expect(result.changes).toContain(
      "Removed agents.defaults.promptOverlays.gpt5.personality (plugins.entries.openai.config.personality already set).",
    );
  });

  it.each([
    {
      name: "route and ACP bindings",
      valid: true,
      migrated: 2,
      peers: [
        ["route", "telegram", "dm", "123"],
        ["acp", "discord", "dm", "456"],
        ["route", "telegram", "direct", "789"],
        ["route", "discord", "group", "abc"],
      ],
      expected: ["direct", "direct", "direct", "group"],
    },
    {
      name: "malformed peer kinds",
      valid: false,
      migrated: 1,
      peers: [
        ["route", "telegram", "dm", "exact"],
        ["route", "telegram", "DM", "uppercase"],
        ["route", "telegram", " dm ", "spaced"],
        ["route", "telegram", 42, "number"],
      ],
      expected: ["direct", "DM", " dm ", 42],
    },
  ])(
    "rewrites exact dm aliases in $name through validation",
    ({ peers, expected, valid, migrated }) => {
      const raw = {
        ...(valid ? { agents: { entries: { main: {} } } } : {}),
        bindings: peers.map(([type, channel, kind, id]) => ({
          type,
          agentId: "main",
          match: { channel, peer: { kind, id } },
          ...(type === "acp" ? { acp: { mode: "persistent" } } : {}),
        })),
      };
      expect(findLegacyConfigIssues(raw)).toEqual([expect.objectContaining({ path: "bindings" })]);
      const result = migrate(raw);
      expect(result.config?.bindings?.map((binding) => binding.match.peer?.kind)).toEqual(expected);
      expect(result.changes).toContain(
        `Moved deprecated bindings[].match.peer.kind "dm" → "direct" for ${migrated} binding${migrated === 1 ? "" : "s"}.`,
      );
      expect(result.partiallyValid).toBe(valid ? undefined : true);
      const validation = validateConfigObjectRaw(result.config);
      expect(validation.ok, JSON.stringify(validation)).toBe(valid);
      if (valid) {
        expectIdempotent(result.config);
      }
    },
  );
});
