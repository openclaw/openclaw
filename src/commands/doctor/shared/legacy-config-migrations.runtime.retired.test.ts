import { describe, expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import type { LegacyConfigMigrationSpec } from "../../../config/legacy.shared.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_CRON } from "./legacy-config-migrations.runtime.cron.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_GATEWAY } from "./legacy-config-migrations.runtime.gateway.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_MCP } from "./legacy-config-migrations.runtime.mcp.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS } from "./legacy-config-migrations.runtime.models.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED } from "./legacy-config-migrations.runtime.retired.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION } from "./legacy-config-migrations.runtime.session.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_SKILLS } from "./legacy-config-migrations.runtime.skills.js";

const runtimeMigrations = [
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_GATEWAY,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_MCP,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_CRON,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS.filter(
    (m) => m.id === "defaultModel->agents.defaults.model",
  ),
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED,
];
const applyAll = (raw: Record<string, unknown>) => applyMigrations(runtimeMigrations, raw);

function applyMigrations(
  migrations: readonly LegacyConfigMigrationSpec[],
  raw: Record<string, unknown>,
) {
  const changes: string[] = [];
  for (const migration of migrations) {
    migration.apply(raw, changes);
  }
  return { raw, changes };
}

function configWithPath(path: string, leaf: unknown = 1): Record<string, unknown> {
  return path
    .split(".")
    .filter(Boolean)
    .reduceRight<unknown>(
      (value, segment) => (segment === "0" ? [value] : { [segment]: value }),
      leaf,
    ) as Record<string, unknown>;
}

describe("retired runtime config migrations", () => {
  it("detects and removes an explicitly false tool-error preference", () => {
    const raw = { messages: { suppressToolErrors: false, ackReaction: "👀" } };
    expect(findLegacyConfigIssues(raw)).toContainEqual(
      expect.objectContaining({
        path: "messages.suppressToolErrors",
        message: expect.stringContaining("doctor --fix"),
      }),
    );
    expect(applyAll(raw).changes).toHaveLength(1);
    expect(raw).toEqual({ messages: { ackReaction: "👀" } });
    expect(findLegacyConfigIssues(raw)).toEqual([]);
    expect(applyAll(raw).changes).toEqual([]);
  });

  it("removes hook registrations while retaining canonical discovery", () => {
    const canonical = {
      enabled: true,
      entries: { canonical: { enabled: true } },
      load: { extraDirs: ["/opt/openclaw/hooks"] },
      sibling: "preserved",
    };
    const raw = {
      hooks: {
        internal: {
          ...structuredClone(canonical),
          handlers: [{ event: "command:new", module: "hooks/legacy.js" }],
        },
      },
    };
    expect(findLegacyConfigIssues(raw)).toContainEqual(
      expect.objectContaining({
        path: "hooks.internal.handlers",
        message: expect.stringContaining("does not materialize executable files"),
      }),
    );
    applyAll(raw);
    expect(raw.hooks.internal).toEqual(canonical);
  });

  it("removes legacy-only enablement without enabling broad hook discovery", () => {
    const raw = {
      hooks: {
        internal: {
          enabled: true,
          handlers: [],
          entries: {},
          load: { extraDirs: ["  "] },
        },
      },
    };
    applyAll(raw);
    expect(raw.hooks.internal).toEqual({ entries: {}, load: { extraDirs: ["  "] } });
  });

  it.each([{ enabled: true, load: { extraDirs: ["/opt/openclaw/hooks"] } }, { enabled: false }])(
    "preserves explicit hook discovery: %j",
    (expected) => {
      const raw = { hooks: { internal: { ...structuredClone(expected), handlers: null } } };
      applyAll(raw);
      expect(raw.hooks.internal).toEqual(expected);
      expect(applyAll(raw).changes).toEqual([]);
    },
  );

  it.each([
    { enabled: true, expected: { maxActiveTranscriptBytes: "20mb" } },
    { enabled: false, expected: {} },
  ])("preserves compaction opt-in=$enabled", ({ enabled, expected }) => {
    const raw = configWithPath("agents.defaults.compaction", {
      truncateAfterCompaction: enabled,
      maxActiveTranscriptBytes: "20mb",
    });
    applyAll(raw);
    expect(raw).toHaveProperty("agents.defaults.compaction", expected);
    expect(applyAll(raw).changes).toEqual([]);
  });

  it("removes even an explicitly disabled retired device-auth bypass", () => {
    const raw = { gateway: { controlUi: { dangerouslyDisableDeviceAuth: false } } };
    expect(findLegacyConfigIssues(raw)).toContainEqual(
      expect.objectContaining({
        path: "gateway.controlUi.dangerouslyDisableDeviceAuth",
      }),
    );
    applyAll(raw);
    expect(raw).toEqual({ gateway: { controlUi: {} } });
  });

  it("tags and deduplicates modality models without conflating capabilities", () => {
    const shared = { provider: "openai", model: "shared", capabilities: ["image"] };
    const local = { provider: "local", model: "same", timeoutSeconds: 20 };
    const audio = { provider: "deepgram", model: "nova-3" };
    const raw = {
      tools: {
        media: {
          models: [structuredClone(shared)],
          image: { enabled: true, models: [{ provider: "openai", model: "shared" }] },
          audio: { timeoutSeconds: 20, models: structuredClone([audio, audio, local]) },
          video: { models: [structuredClone(local)] },
        },
      },
    };
    applyAll(raw);
    expect(raw.tools.media).toEqual({
      models: [
        shared,
        { ...audio, capabilities: ["audio"] },
        { ...local, capabilities: ["audio"] },
        { ...local, capabilities: ["video"] },
        shared,
      ],
      image: { enabled: true },
      audio: { timeoutSeconds: 20 },
    });
  });

  it("preserves independent fallback order across capability lists", () => {
    const model = (id: string) => ({ provider: "p", model: id });
    const raw = {
      tools: {
        media: {
          image: { models: ["a", "b", "c"].map(model) },
          audio: { models: ["c", "b", "a"].map(model) },
        },
      },
    };
    applyAll(raw);
    expect(raw.tools.media).toEqual({
      models: [
        ...["a", "b", "c"].map((id) => ({ provider: "p", model: id, capabilities: ["image"] })),
        ...["c", "b", "a"].map((id) => ({ provider: "p", model: id, capabilities: ["audio"] })),
      ],
    });
  });

  it("preserves explicit legacy capability filtering", () => {
    const raw = {
      tools: {
        media: {
          image: {
            models: [
              { provider: "skip", model: "audio-only", capabilities: ["audio"] },
              { provider: "keep", model: "image-first", capabilities: ["image", "audio"] },
            ],
          },
        },
      },
    };
    applyAll(raw);
    expect(raw.tools.media).toEqual({
      models: [{ provider: "keep", model: "image-first", capabilities: ["image"] }],
    });
  });

  it.each([
    "systemAgent",
    "browser.tabCleanup.idleMinutes",
    "agents.list.0.contextPruning.softTrimRatio",
  ])("strips retired tuning paths through each scope: %s", (path) => {
    const result = applyAll(configWithPath(path));
    expect(result.raw).not.toHaveProperty(path);
    expect(result.changes).toContain(
      `Removed retired runtime tuning knobs: ${path.replace("agents.list.0.", "agents.list[0].")}; built-in defaults now apply.`,
    );
  });

  it("preserves agent entries while pruning emptied named descendants", () => {
    const path = "agents.entries";
    const result = applyAll(
      configWithPath(path, {
        keep: { contextPruning: { softTrim: { maxChars: 1 }, mode: "cache-ttl" } },
        prune: { contextPruning: { softTrim: { maxChars: 1 } } },
        malformed: null,
      }),
    );
    expect(result.raw).toEqual(
      configWithPath(path, {
        keep: { contextPruning: { mode: "cache-ttl" } },
        prune: {},
        malformed: null,
      }),
    );
  });

  it.each([
    {
      channel: "googlechat",
      legacy: "serviceAccountRef",
      canonical: "serviceAccount",
      winner: "legacy-z",
    },
    { channel: "slack", legacy: "identity", canonical: "postAs", winner: "canonical-z" },
  ])(
    "migrates $channel roots and accounts with its precedence rules",
    ({ channel, legacy, canonical, winner }) => {
      const result = applyAll({
        channels: {
          [channel]: {
            [legacy]: "root",
            accounts: {
              z: { [legacy]: "legacy-z", [canonical]: "canonical-z" },
              malformed: 42,
              a: { [legacy]: "a" },
            },
          },
        },
      });
      expect(result.raw).toEqual({
        channels: {
          [channel]: {
            [canonical]: "root",
            accounts: { z: { [canonical]: winner }, malformed: 42, a: { [canonical]: "a" } },
          },
        },
      });
    },
  );

  it("removes iMessage coalescing at root and account scopes", () => {
    const result = applyAll({
      channels: {
        imessage: {
          coalesceSameSenderDms: true,
          accounts: {
            z: { coalesceSameSenderDms: true },
            malformed: false,
            a: { coalesceSameSenderDms: true },
          },
        },
      },
    });
    expect(result.raw).toEqual({
      channels: { imessage: { accounts: { z: {}, malformed: false, a: {} } } },
    });
  });

  it("migrates presentation, agent limits and the selected WhatsApp debounce", () => {
    const result = applyAll({
      ui: {
        prefs: {
          chatMessageMaxWidth: "82%",
          textScale: 125,
          sidebarLiveActivity: false,
          showAdvancedSettings: true,
        },
      },
      skills: { load: { watch: true, watchDebounceMs: 500 } },
      agents: {
        defaults: {
          typingIntervalSeconds: 6,
          contextLimits: {
            memoryGetMaxChars: 12_000,
            memoryGetDefaultLines: 180,
            toolResultMaxChars: 24_000,
          },
        },
        entries: {
          writer: {
            typingMode: "message",
            typingIntervalSeconds: 8,
            contextLimits: { toolResultMaxChars: 8_000 },
          },
        },
        list: [
          { id: "legacy", typingIntervalSeconds: 10, contextLimits: { memoryGetDefaultLines: 80 } },
        ],
      },
      channels: {
        whatsapp: {
          defaultAccount: "Work",
          debounceMs: 2_000,
          accounts: {
            default: { debounceMs: 3_000 },
            work: { debounceMs: 4_000 },
          },
        },
      },
    });
    expect(result.raw).toMatchObject({
      skills: { load: { watch: true } },
      agents: {
        defaults: { typingIntervalSeconds: 6, contextLimits: { memoryGetMaxChars: 12_000 } },
        entries: { writer: { typingMode: "message" } },
        list: [{ id: "legacy" }],
      },
      messages: { inbound: { byChannel: { whatsapp: 4_000 } } },
    });
    for (const path of [
      "ui",
      "channels.whatsapp.debounceMs",
      "channels.whatsapp.accounts.default.debounceMs",
      "channels.whatsapp.accounts.work.debounceMs",
    ]) {
      expect(result.raw).not.toHaveProperty(path);
    }
  });

  it("keeps a canonical WhatsApp debounce over all legacy sources", () => {
    const result = applyAll({
      messages: { inbound: { byChannel: { whatsapp: 900 } } },
      channels: { whatsapp: { debounceMs: 2_000, accounts: { work: { debounceMs: 4_000 } } } },
    });
    expect(result.raw).toEqual({
      messages: { inbound: { byChannel: { whatsapp: 900 } } },
      channels: { whatsapp: { accounts: { work: {} } } },
    });
  });

  it("preserves accounts.default debounce inheritance for a named default", () => {
    const result = applyAll({
      channels: {
        whatsapp: {
          defaultAccount: "work",
          debounceMs: 2_000,
          accounts: { default: { debounceMs: 3_000 }, work: { name: "Work" } },
        },
      },
    });
    expect(result.raw).toHaveProperty("messages.inbound.byChannel.whatsapp", 3_000);
  });

  it("moves aliases and strips dead keys", () => {
    const result = applyAll({
      tui: { footer: { showRemoteHost: true } },
      defaultModel: "openai/gpt-5.6",
      commands: { modelsWrite: true },
      messages: { messagePrefix: "[wa]" },
      cron: { webhook: "https://example.com", webhookToken: "keep" },
      session: { maintenance: { pruneDays: 7 }, resetByType: { dm: { mode: "idle" } } },
      talk: { realtime: { voice: "alloy" } },
      mcp: { servers: { docs: { connectTimeout: 2, timeout: 3 } } },
      nodeHost: { mcp: { servers: { local: { connect_timeout: 4 } } } },
      tools: {
        media: {
          asyncCompletion: { directSend: true },
          audio: { deepgram: { smartFormat: true } },
        },
        message: { allowCrossContextSend: true },
      },
    });
    expect(result.raw).toMatchObject({
      channels: { whatsapp: { responsePrefix: "[wa]" } },
      agents: { defaults: { model: "openai/gpt-5.6" } },
      cron: { webhookToken: "keep" },
      session: { maintenance: { pruneAfter: 7 }, resetByType: { direct: { mode: "idle" } } },
      talk: { realtime: { speakerVoice: "alloy" } },
      mcp: { servers: { docs: { connectionTimeoutMs: 2000, requestTimeoutMs: 3000 } } },
      nodeHost: { mcp: { servers: { local: { connectionTimeoutMs: 4000 } } } },
      tools: {
        media: {},
        message: { crossContext: { allowWithinProvider: true, allowAcrossProviders: true } },
      },
    });
    expect(result.raw).not.toHaveProperty("tui");
    expect(result.raw).not.toHaveProperty("commands.modelsWrite");
  });

  it("keeps evidence mismatches while stripping canonical conflict aliases", () => {
    const result = applyAll({
      session: { threadBindings: { enabled: true } },
      tools: { media: { audio: { baseUrl: "https://provider-required.example" } } },
      proxy: { enabled: false, proxyUrl: "http://disabled-proxy.example" },
      discovery: { wideArea: { enabled: false, domain: "disabled.example" } },
      channels: {
        telegram: { threadBindings: { enabled: false } },
        googlechat: { serviceAccount: "plain", serviceAccountRef: { source: "env" } },
        whatsapp: { enabled: true },
      },
      web: { enabled: false },
    });
    expect(result.raw).toHaveProperty("channels.telegram.threadBindings.enabled", false);
    expect(result.raw).toHaveProperty(
      "tools.media.audio.baseUrl",
      "https://provider-required.example",
    );
    expect(result.raw).toHaveProperty("proxy", {
      enabled: false,
      proxyUrl: "http://disabled-proxy.example",
    });
    expect(result.raw).not.toHaveProperty("discovery.wideArea.domain");
    expect(result.raw).not.toHaveProperty("channels.googlechat.serviceAccountRef");
    expect(result.raw).toHaveProperty("channels.googlechat.serviceAccount", { source: "env" });
    expect(result.raw).not.toHaveProperty("web");
  });

  it("keeps nonrepresentable exec and inherited memory policies", () => {
    const result = applyAll({
      tools: { exec: { security: "allowlist", ask: "always" } },
      memory: { search: { provider: "openai", store: { vector: { enabled: false } } } },
      agents: {
        entries: {
          malformed: { tools: { exec: { security: "deny " } } },
          onMissFull: { tools: { exec: { security: "full", ask: "on-miss" } } },
        },
      },
    });
    expect(result.raw).toHaveProperty("tools.exec.ask", "always");
    expect(result.raw).not.toHaveProperty("tools.exec.mode");
    expect(result.raw).toHaveProperty("agents.entries.malformed.tools.exec.security", "deny ");
    expect(result.raw).toHaveProperty("agents.entries.onMissFull.tools.exec.ask", "on-miss");
    expect(result.raw).not.toHaveProperty("agents.entries.onMissFull.tools.exec.mode");
    expect(result.raw).toHaveProperty("memory.search.provider", "openai");
    expect(result.raw).toHaveProperty("memory.search.store.vector.enabled", false);
    expect(result.changes).toEqual([]);
  });

  it("uses the inherited exec policy for a partial agent override", () => {
    const result = applyAll({
      tools: { exec: { security: "allowlist", ask: "on-miss" } },
      agents: { entries: { nonInteractive: { tools: { exec: { ask: "off" } } } } },
    });
    expect(result.raw).toHaveProperty("tools.exec", { mode: "ask" });
    expect(result.raw).toHaveProperty("agents.entries.nonInteractive.tools.exec", {
      mode: "allowlist",
    });
  });

  it("strips core TTS persona prompts without entering opaque provider config", () => {
    const providers = { custom: { tts: { personas: { voice: { prompt: { owned: true } } } } } };
    const result = applyAll({
      tts: {
        personas: { alfred: { prompt: { style: "dry" }, providers: structuredClone(providers) } },
      },
      agents: {
        entries: { voice: { tts: { personas: { narrator: { prompt: { pacing: "slow" } } } } } },
      },
    });
    expect(result.raw).toHaveProperty("tts.personas.alfred", { providers });
    expect(result.raw).not.toHaveProperty("agents.entries.voice.tts.personas.narrator.prompt");
    expect(result.changes.join("\n")).toContain("prepareSynthesis");
  });

  it("strips compaction instructions while preserving section selection", () => {
    const result = applyAll({
      agents: {
        defaults: {
          compaction: {
            customInstructions: "Keep decisions.",
            identifierPolicy: "custom",
            identifierInstructions: "Keep ticket IDs.",
            postCompactionSections: ["Red Lines"],
            memoryFlush: { prompt: "Write memory.", systemPrompt: "Be careful." },
          },
        },
      },
    });
    expect(result.raw).toHaveProperty("agents.defaults.compaction", {
      identifierPolicy: "strict",
      postCompactionSections: ["Red Lines"],
      memoryFlush: {},
    });
    expect(result.changes.join("\n")).toContain("summarize()");
    expect(result.changes.join("\n")).toContain("before_prompt_build");
  });

  it("copies responsePrefix while retaining the custom-channel fallback", () => {
    const result = applyAll({
      messages: { responsePrefix: "[bot]" },
      channels: { buzz: {}, custom: { enabled: true } },
    });
    expect(result.raw).toHaveProperty("channels.buzz.responsePrefix", "[bot]");
    expect(result.raw).toHaveProperty("messages.responsePrefix", "[bot]");
    expect(applyAll(result.raw).changes).toEqual([]);
  });
});

it.each([
  { enabled: true, mode: "propose" },
  { enabled: false, mode: "off" },
])("migrates Skill Workshop enabled=$enabled to $mode", ({ enabled, mode }) => {
  const result = applyMigrations(LEGACY_CONFIG_MIGRATIONS_RUNTIME_SKILLS, {
    skills: { workshop: { autonomous: { enabled } } },
  });
  expect(result.raw).toEqual({ skills: { workshop: { autonomous: { mode } } } });
});

it("retires Skill Workshop symlink write permission", () => {
  const result = applyMigrations(LEGACY_CONFIG_MIGRATIONS_RUNTIME_SKILLS, {
    skills: { workshop: { allowSymlinkTargetWrites: true, autonomous: { mode: "auto" } } },
  });
  expect(result.raw).toEqual({ skills: { workshop: { autonomous: { mode: "auto" } } } });
});

it.each([
  {
    ui: { seamColor: "#ff4500", assistant: { name: "UI name", avatar: "avatars/ui.png" } },
    expected: { ui: { seamColor: "#ff4500" } },
  },
  { ui: { assistant: { name: "OpenClaw", avatar: "🦞" } }, expected: {} },
])("removes UI identity without creating or changing agent identity: $ui", ({ ui, expected }) => {
  const migration = LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED.filter(
    (entry) => entry.id === "runtime.ui-assistant-identity",
  );
  const agents = {
    list: [
      { id: "worker", identity: { name: "Worker" } },
      { id: "primary", default: true, identity: { name: "Main", emoji: "🦞" } },
    ],
  };
  const raw = "seamColor" in ui ? { ui, agents: structuredClone(agents) } : { ui };
  const result = applyMigrations(migration, raw);
  expect(result.raw).toEqual("seamColor" in ui ? { ...expected, agents } : expected);
});

it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
  ["tools", { experimental: { planTool: false } }, { updatePlan: false }],
  ["tools", { updatePlan: true, experimental: { planTool: false } }, { updatePlan: true }],
  ["tools", { experimental: {} }, {}],
  ["tools.exec", { mode: "deny", security: "full", ask: "off" }, { mode: "deny" }],
  ["session", { idleMinutes: 45 }, { reset: { mode: "idle", idleMinutes: 45 } }],
  ["session", { idleMinutes: 45, reset: { idleMinutes: 90 } }, { reset: { idleMinutes: 90 } }],
  ["session.maintenance", { pruneDays: 7, pruneAfter: false }, { pruneAfter: false }],
  [
    "session.resetByType",
    { dm: { mode: "idle" }, direct: { mode: "daily" } },
    { direct: { mode: "daily" } },
  ],
  [
    "channels.discord",
    {
      voice: { realtime: { voice: "alloy", speakerVoice: "marin" } },
      accounts: {
        work: { voice: { realtime: { voice: "cedar", enabled: true } } },
        malformed: null,
      },
    },
    {
      voice: { realtime: { speakerVoice: "marin" } },
      accounts: {
        work: { voice: { realtime: { speakerVoice: "cedar", enabled: true } } },
        malformed: null,
      },
    },
  ],
  [
    "channels.signal",
    { httpHost: "::1", httpPort: 9090 },
    { httpUrl: "http://[::1]:9090", autoStart: true },
  ],
  [
    "channels.signal",
    { httpUrl: "http://signal.example:8080", accounts: { work: { httpPort: 9090 } } },
    { httpUrl: "http://signal.example:8080", accounts: { work: {} } },
  ],
  [
    "channels.signal",
    { httpHost: "10.0.0.5", httpPort: 8080, accounts: { work: { httpPort: 9090 } } },
    {
      httpUrl: "http://10.0.0.5:8080",
      autoStart: true,
      accounts: { work: { httpUrl: "http://10.0.0.5:9090", autoStart: true } },
    },
  ],
  [
    "",
    {
      tts: { prefsPath: "/global/tts.json" },
      agents: { entries: { voice: { tts: { prefsPath: "/voice/tts.json" } } } },
    },
    { agents: { entries: { voice: { tts: { prefsPath: "/voice/tts.json" } } } } },
  ],
  ["mcp.servers.docs", { cwd: "/canonical", workingDirectory: "/legacy" }, { cwd: "/canonical" }],
  ["nodeHost.mcp.servers.local", { workingDirectory: "/node" }, { cwd: "/node" }],
  ["", { web: { enabled: false } }, { channels: { whatsapp: { enabled: false } } }],
  ["discovery.wideArea", { enabled: true, domain: "example.test" }, { domain: "example.test" }],
])("migrates %s: %j", (path, raw, expected) => {
  expect(applyAll(configWithPath(path, raw)).raw).toEqual(configWithPath(path, expected));
});
