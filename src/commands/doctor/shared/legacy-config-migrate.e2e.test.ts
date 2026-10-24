import { describe, expect, it } from "vitest";
import { resolveMemorySearchConfig } from "../../../agents/memory-search.js";
import { resolveDefaultAgentWorkspaceDir } from "../../../agents/workspace-default.js";
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
      expected: config({
        "gateway.controlUi.allowedOrigins": expect.arrayContaining(["http://localhost:18789"]),
      }),
    },
    {
      name: "malformed media model rows",
      raw: mediaConfig({
        models: [null, "invalid", 42, false, [], openai],
        audio: { models: [null, "invalid", 42, false, [], deepgram] },
      }),
      expected: mediaConfig({
        models: [{ ...deepgram, capabilities: ["audio"] }, openai],
      }),
    },
    {
      name: "Deepgram options before media consolidation",
      raw: mediaConfig({
        audio: { models: [{ ...deepgram, deepgram: { punctuate: true } }] },
      }),
      expected: mediaConfig({
        models: [
          {
            ...deepgram,
            providerOptions: { deepgram: { punctuate: true } },
            capabilities: ["audio"],
          },
        ],
      }),
    },
    {
      name: "memory owner before QMD collections",
      raw: config({
        "agents.defaults.memorySearch": {
          provider: "none",
          qmd: { extraCollections: [{ path: "/synthetic/qmd", pattern: "**/*.md" }] },
        },
        "agents.list": [{ id: "main" }],
      }),
      expected: config({
        "memory.search": {
          provider: "none",
          extraPaths: [{ path: "/synthetic/qmd", pattern: "**/*.md" }],
        },
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

  it("reshapes duplicate agent ids deterministically and preserves prototype-named ids", () => {
    const duplicate = apply(
      config({
        "agents.list": [
          { id: "main", name: "first" },
          { id: "main", name: "second" },
        ],
      }),
    );
    expect(duplicate.next).toEqual({
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: {
          main: { name: "first", workspace: resolveDefaultAgentWorkspaceDir() },
          "main-2": { name: "second" },
        },
      },
    });
    expect(apply(duplicate.next)).toEqual({ next: null, changes: [] });

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
        "agents.defaults.memory.search": {
          ...(canonical
            ? {
                provider: "openai",
                rememberAcrossConversations: true,
                experimental: { sessionMemory: true },
              }
            : privacy),
          extraPaths: ["/defaults-existing"],
          qmd: { sessions: { enabled: true }, extraCollections: [{ path: "/defaults-qmd" }] },
        },
      });
      const result = migrate(raw);

      expect(result.partiallyValid).toBeUndefined();
      expect(result.config).not.toHaveProperty("agents.defaults.memory");
      const validated = expectValid(result.config);
      const resolved = resolveMemorySearchConfig(validated, "main");
      const sources = canonical ? ["memory"] : ["memory", "sessions"];
      expect(resolved).toMatchObject({
        ...privacy,
        sources,
        searchSources: sources,
        extraPaths: [canonical ? "/canonical" : "/defaults-existing", "/defaults-qmd"],
      });
      expect(validated.memory?.search?.experimental?.sessionMemory).toBe(!canonical);
      expectIdempotent(validated);
    },
  );

  it("canonicalizes a multi-family legacy config and is idempotent", () => {
    const channelPolicy = { dmPolicy: "pairing", groupPolicy: "allowlist" };
    const raw = config({
      env: { shellEnv: { enabled: true }, API_ORIGIN: "https://example.test" },
      "agents.defaults.pdfMaxBytesMb": 12,
      "agents.defaults.imageGenerationModel": "openai/image-1",
      "agents.defaults.promptOverlays.gpt5.personality": "off",
      "agents.defaults.envelopeTimestamp": "off",
      "agents.defaults.sandbox.browser.enableNoVnc": false,
      "agents.list": [{ id: "main", name: "Main", tools: { exec: { timeoutSec: 45 } } }],
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
      "channels.slack": {
        ...channelPolicy,
        identity: "user",
        mode: "socket",
        webhookPath: "/slack/events",
        userTokenReadOnly: true,
        socketMode: { clientPingTimeout: 1000 },
      },
      "channels.whatsapp": {
        ...channelPolicy,
        mediaMaxMb: 50,
        debounceMs: 0,
        messagePrefix: "[wa]",
        ackReaction: { emoji: "👀", direct: false, group: "mentions" },
      },
      "channels.imessage": { ...channelPolicy, coalesceSameSenderDms: true },
      "mcp.servers.docs": {
        command: "docs",
        workingDirectory: "/tmp/docs",
        supports_parallel_tool_calls: true,
        ssl_verify: false,
        codex: { default_tools_approval_mode: "prompt" },
      },
    });
    const result = migrate(raw);

    expect(result.config).toMatchObject(
      config({
        env: { shellEnv: { enabled: true }, vars: { API_ORIGIN: "https://example.test" } },
        "agents.defaults": { pdfMaxMb: 12, mediaModels: { image: "openai/image-1" } },
        "agents.entries.main": { name: "Main", tools: { exec: { timeoutSeconds: 45 } } },
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
        "channels.slack.postAs": "user",
        "channels.whatsapp.responsePrefix": "[wa]",
        "mcp.servers.docs": {
          command: "docs",
          cwd: "/tmp/docs",
          supportsParallelToolCalls: true,
          sslVerify: false,
          codex: { defaultToolsApprovalMode: "prompt" },
        },
      }),
    );
    expect(result.changes).toContain(
      "Moved agents.defaults.promptOverlays.gpt5.personality → plugins.entries.openai.config.personality.",
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

  it("loads WhatsApp-owned acknowledgement migration guidance", () => {
    const result = migrate(
      config({
        "channels.whatsapp.ackReaction": { emoji: "👀", direct: true, group: "mentions" },
      }),
    );

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
