import { describe, expect, it } from "vitest";
import { resolveMemorySearchConfig } from "../../../agents/memory-search.js";
import { setConfigValueAtPath } from "../../../config/config-paths.js";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import type { OpenClawConfigWithLegacyRoster } from "../../../config/legacy.roster.js";
import { validateConfigObjectRaw } from "../../../config/validation.js";
import { projectRetiredHeartbeatConfig } from "../../doctor-heartbeat-legacy.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";

const migrate = (raw: unknown) => migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
const apply = (raw: unknown) =>
  applyLegacyDoctorMigrations(raw, { sourceConfigBeforeMigrations: raw });
const mediaConfig = (media: Record<string, unknown>) => ({ tools: { media } });
const deepgram = { provider: "deepgram", model: "nova-2" };
const openai = { provider: "openai", model: "whisper-1" };
function config(paths: Record<string, unknown>) {
  const raw = {};
  for (const [path, value] of Object.entries(paths)) {
    setConfigValueAtPath(raw, path.split("."), value);
  }
  return raw;
}
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
  it("converges legacy TTS ownership without replacing its model", () => {
    const tts = { personas: { narrator: { prompt: { style: "Synthetic instruction" } } } };
    const raw = { messages: { tts: { ...tts, summaryModel: "anthropic/claude-sonnet-4-5" } } };
    const result = migrate(raw);
    expect(result.partiallyValid).toBeUndefined();
    expectValid(result.config);
    expect(result.config).not.toHaveProperty("messages.tts");
    expect(result.config?.tts?.summaryModel).toBe("anthropic/claude-sonnet-4-5");
    expectIdempotent(result.config);
  });

  it.each([
    {
      name: "port repair before origin seeding",
      raw: { gateway: { bind: "lan", port: 70000 } },
      expected: config({
        "gateway.controlUi.allowedOrigins": expect.arrayContaining(["http://localhost:18789"]),
      }),
    },
    {
      name: "media row filtering and Deepgram options before consolidation",
      raw: mediaConfig({
        models: [null, "invalid", 42, false, [], openai],
        audio: {
          models: [null, "invalid", 42, false, [], { ...deepgram, deepgram: { punctuate: true } }],
        },
      }),
      expected: mediaConfig({
        models: [
          {
            ...deepgram,
            providerOptions: { deepgram: { punctuate: true } },
            capabilities: ["audio"],
          },
          openai,
        ],
      }),
    },
  ])("converges $name in one pass", ({ raw, expected }) => {
    const result = migrate(raw);
    expect(result.partiallyValid).toBeUndefined();
    expect(result.config).toMatchObject(expected);
    expectValid(result.config);
    expect(findLegacyConfigIssues(result.sourceConfig)).toEqual([]);
    expectIdempotent(result.config);
  });

  it("preserves prototype-named agent ids", () => {
    const prototypeId = apply(
      config({ "agents.list": [{ id: "__proto__", name: "prototype-safe" }] }),
    );
    const prototypeEntries = (prototypeId.next?.agents as { entries?: Record<string, unknown> })
      ?.entries;
    expect(Object.hasOwn(prototypeEntries ?? {}, "__proto__")).toBe(true);
  });

  it.each([false, true])(
    "migrates QMD into validated effective memory settings (canonical privacy: %s)",
    (canonical) => {
      const privacy = { provider: "none", rememberAcrossConversations: false };
      const raw = config({
        ...(canonical
          ? {
              "memory.search": {
                ...privacy,
                experimental: { sessionMemory: false },
                sources: ["memory"],
                extraPaths: ["/canonical"],
              },
            }
          : {}),
        "session.dmScope": "per-peer",
        "agents.entries": { main: {} },
        [canonical ? "agents.defaults.memory.search" : "agents.defaults.memorySearch"]: {
          ...(canonical
            ? {
                provider: "openai",
                rememberAcrossConversations: true,
                experimental: { sessionMemory: true },
              }
            : privacy),
          extraPaths: ["/defaults-existing"],
          qmd: {
            sessions: { enabled: true },
            extraCollections: [{ path: "/defaults-qmd", pattern: "**/*.md" }],
          },
        },
      });
      const result = migrate(raw);

      expect(result.partiallyValid).toBeUndefined();
      expect(result.config).not.toHaveProperty("agents.defaults.memory");
      expect(result.config).not.toHaveProperty("agents.defaults.memorySearch");
      const validated = expectValid(result.config);
      const resolved = resolveMemorySearchConfig(validated, "main");
      const sources = canonical ? ["memory"] : ["memory", "sessions"];
      expect(resolved).toMatchObject({
        ...privacy,
        sources,
        searchSources: sources,
        extraPaths: [
          canonical ? "/canonical" : "/defaults-existing",
          { path: "/defaults-qmd", pattern: "**/*.md" },
        ],
      });
      expect(validated.memory?.search?.experimental?.sessionMemory).toBe(!canonical);
      expectIdempotent(validated);
    },
  );

  it("canonicalizes a multi-family legacy config and is idempotent", () => {
    const raw = config({
      env: { shellEnv: { enabled: true }, API_ORIGIN: "https://example.test" },
      "agents.defaults.pdfMaxBytesMb": 12,
      "agents.defaults.promptOverlays.gpt5.personality": "off",
      "agents.defaults.envelopeTimestamp": "off",
      "agents.list": [{ id: "main" }],
      "tools.exec.timeoutSec": 30,
      media: { ttlHours: 24, preserveFilenames: true },
      audit: { enabled: false, messages: "direct" },
      "diagnostics.otel.captureContent": { enabled: false, toolInputs: true },
      "diagnostics.cacheTrace.enabled": true,
      "diagnostics.cacheTrace.filePath": "/tmp/trace.jsonl",
      "diagnostics.cacheTrace.includePrompt": false,
      "browser.color": "#ffffff",
      "browser.ssrfPolicy.allowedHostnames": ["localhost"],
      "browser.ssrfPolicy.hostnameAllowlist": ["*.example.com"],
      "browser.profiles.chrome": { driver: "extension", color: "#000000" },
      "gateway.reload.mode": "hot",
      "gateway.nodes.skills.enabled": false,
      "gateway.nodes.allowCommands": ["camera.snap"],
      "gateway.nodes.denyCommands": ["system.run"],
      "gateway.controlUi.chatMessageMaxWidth": "82%",
      "logging.consoleStyle": "compact",
      "cron.failureDestination": { channel: "telegram", to: "123" },
      "messages.statusReactions": { enabled: true, emojis: { done: "✅" } },
      "messages.removeAckAfterReply": true,
      "channels.defaults.heartbeat": { showOk: true },
      "channels.slack.socketMode.clientPingTimeout": 1000,
      "channels.whatsapp.debounceMs": 0,
      "channels.whatsapp.messagePrefix": "[wa]",
      "channels.whatsapp.ackReaction": { emoji: "👀", direct: false, group: "mentions" },
      "channels.imessage.coalesceSameSenderDms": true,
      "mcp.servers.docs": {
        command: "docs",
        supports_parallel_tool_calls: true,
        ssl_verify: false,
        codex: { default_tools_approval_mode: "prompt" },
      },
    });
    const result = migrate(raw);

    expect(result.config).toMatchObject(
      config({
        env: { shellEnv: { enabled: true }, vars: { API_ORIGIN: "https://example.test" } },
        "agents.defaults.pdfMaxMb": 12,
        "plugins.entries.openai.config.personality": "off",
        "tools.exec.timeoutSeconds": 30,
        attachments: { ttlHours: 24 },
        logging: { consoleStyle: "pretty", audit: { enabled: false, messages: "direct" } },
        diagnostics: { otel: { captureContent: false }, cacheTrace: { enabled: true } },
        "gateway.reload.mode": "hybrid",
        "gateway.nodes": {
          allowSkills: false,
          commands: { allow: ["camera.snap"], deny: ["system.run"] },
        },
        "cron.failureAlert": { channel: "telegram", to: "123" },
        "messages.inbound.byChannel.whatsapp": 0,
        "channels.defaults.heartbeatVisibility": { showOk: true },
        "channels.whatsapp.responsePrefix": "[wa]",
        "mcp.servers.docs": {
          command: "docs",
          supportsParallelToolCalls: true,
          sslVerify: false,
          codex: { defaultToolsApprovalMode: "prompt" },
        },
      }),
    );
    expect(result.partiallyValid).toBe(true);
    if (!result.config) {
      throw new Error("Expected normalized legacy configuration");
    }
    const projected = projectRetiredHeartbeatConfig(result.config);
    expect(projected).not.toHaveProperty("channels.defaults.heartbeatVisibility");
    expectValid(projected);
    expect(apply(result.config)).toEqual({ next: null, changes: [] });
  });

  it("preserves canonical OpenAI personality over the retired prompt overlay", () => {
    const raw: OpenClawConfigWithLegacyRoster = {
      agents: { defaults: { promptOverlays: { gpt5: { personality: "off" } } } },
      plugins: { entries: { openai: { config: { personality: "friendly" } } } },
    };
    const result = migrate(raw);

    expect(result.config?.plugins?.entries?.openai?.config?.personality).toBe("friendly");
    expect(result.config?.agents?.defaults).not.toHaveProperty("promptOverlays");
  });

  it.each([
    {
      name: "route and ACP bindings",
      valid: true,
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
      peers: [
        ["route", "telegram", "dm", "exact"],
        ["route", "telegram", "DM", "uppercase"],
        ["route", "telegram", " dm ", "spaced"],
        ["route", "telegram", 42, "number"],
      ],
      expected: ["direct", "DM", " dm ", 42],
    },
  ])("rewrites exact dm aliases in $name through validation", ({ peers, expected, valid }) => {
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
    expect(result.partiallyValid).toBe(valid ? undefined : true);
    const validation = validateConfigObjectRaw(result.config);
    expect(validation.ok, JSON.stringify(validation)).toBe(valid);
    if (valid) {
      expectIdempotent(result.config);
    }
  });
});
