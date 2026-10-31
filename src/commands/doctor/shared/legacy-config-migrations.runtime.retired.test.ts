import { expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { mergeMissing } from "../../../config/merge-missing.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_CRON } from "./legacy-config-migrations.runtime.cron.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_GATEWAY } from "./legacy-config-migrations.runtime.gateway.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_MCP } from "./legacy-config-migrations.runtime.mcp.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS } from "./legacy-config-migrations.runtime.models.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED } from "./legacy-config-migrations.runtime.retired.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION } from "./legacy-config-migrations.runtime.session.js";

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
function applyAll(raw: Record<string, unknown>) {
  const changes: string[] = [];
  for (const migration of runtimeMigrations) {
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

const migratePath = (path: string, value: unknown) => applyAll(configWithPath(path, value));

function config(paths: Record<string, unknown>) {
  const raw = {};
  for (const [path, value] of Object.entries(paths)) {
    mergeMissing(raw, configWithPath(path, value));
  }
  return raw;
}
const migrate = (paths: Record<string, unknown>) => applyAll(config(paths));

function expectIssue(raw: Record<string, unknown>, path: string, message?: string) {
  expect(findLegacyConfigIssues(raw)).toContainEqual(
    expect.objectContaining({
      path,
      ...(message && { message: expect.stringContaining(message) }),
    }),
  );
}

it.each<[string, unknown]>([
  ["channels.discord", { voice: { realtime: { voice: null } } }],
  [
    "channels.discord",
    { accounts: { work: { voice: { realtime: { voice: false } } }, malformed: 42 } },
  ],
  ["tools.media", { models: [null, { deepgram: false }] }],
  ["tools.media", { audio: { deepgram: null } }],
  ["tools.media", { video: { models: [42, { deepgram: null }] } }],
])("reports malformed-but-present legacy media settings in %s: %j", (path, value) => {
  const raw = configWithPath(path, value);
  const original = structuredClone(raw);
  expectIssue(raw, path);
  expect(raw).toEqual(original);
});

it("removes hook registrations while retaining canonical discovery", () => {
  const canonical = {
    enabled: true,
    entries: { canonical: { enabled: true } },
    load: { extraDirs: ["/opt/openclaw/hooks"] },
    sibling: "preserved",
  };
  const raw = configWithPath("hooks.internal", {
    ...structuredClone(canonical),
    handlers: [{ event: "command:new", module: "hooks/legacy.js" }],
  });
  expectIssue(raw, "hooks.internal.handlers", "does not materialize executable files");
  applyAll(raw);
  expect(raw).toHaveProperty("hooks.internal", canonical);
});

it("removes a memory flush model override without changing the active fallback chain", () => {
  const selection = { primary: "ollama/active", fallbacks: ["ollama/backup"] };
  const flush = { enabled: false, softThresholdTokens: 1234 };
  const raw = config({
    "agents.defaults.model": selection,
    "agents.defaults.compaction.memoryFlush": { ...flush, model: "ollama/retired-override" },
  });
  expectIssue(raw, "agents.defaults.compaction.memoryFlush.model", "active session model");
  const result = applyAll(raw);
  expect(result.raw).toEqual({
    agents: { defaults: { model: selection, compaction: { memoryFlush: flush } } },
  });
  expect(findLegacyConfigIssues(result.raw)).toEqual([]);
  expect(applyAll(result.raw).changes).toEqual([]);
});

it("tags and deduplicates modality models without conflating capabilities", () => {
  const shared = { provider: "openai", model: "shared", capabilities: ["image"] };
  const local = { provider: "local", model: "same", timeoutSeconds: 20 };
  const audio = { provider: "deepgram", model: "nova-3" };
  const { raw } = migratePath("tools.media", {
    models: [structuredClone(shared)],
    image: { enabled: true, models: [{ provider: "openai", model: "shared" }] },
    audio: { timeoutSeconds: 20, models: structuredClone([audio, audio, local]) },
    video: { models: [structuredClone(local)] },
  });
  expect(raw).toHaveProperty("tools.media", {
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

it("preserves explicit legacy capability filtering", () => {
  const { raw } = migratePath("tools.media.image", {
    models: [
      { provider: "skip", model: "audio-only", capabilities: ["audio"] },
      { provider: "keep", model: "image-first", capabilities: ["image", "audio"] },
    ],
  });
  expect(raw).toHaveProperty("tools.media", {
    models: [{ provider: "keep", model: "image-first", capabilities: ["image"] }],
  });
});

it.each(["browser.tabCleanup.idleMinutes", "agents.list.0.contextPruning.softTrimRatio"])(
  "strips retired tuning paths through each scope: %s",
  (path) => {
    const result = applyAll(configWithPath(path));
    expect(result.raw).not.toHaveProperty(path);
  },
);

it.each([
  ["googlechat", "serviceAccountRef", "serviceAccount", "legacy-z"],
  ["slack", "identity", "postAs", "canonical-z"],
])(
  "migrates %s roots and accounts with its precedence rules",
  (channel, legacy, canonical, winner) => {
    const result = migratePath(`channels.${channel}`, {
      [legacy]: "root",
      accounts: {
        z: { [legacy]: "legacy-z", [canonical]: "canonical-z" },
        malformed: 42,
        a: { [legacy]: "a" },
      },
    });
    expect(result.raw).toEqual(
      configWithPath(`channels.${channel}`, {
        [canonical]: "root",
        accounts: { z: { [canonical]: winner }, malformed: 42, a: { [canonical]: "a" } },
      }),
    );
  },
);

it("migrates presentation and agent limits at each scope", () => {
  const result = migrate({
    "ui.prefs.chatMessageMaxWidth": "82%",
    "skills.load": { watch: true, watchDebounceMs: 500 },
    "agents.defaults.typingIntervalSeconds": 6,
    "agents.defaults.contextLimits": { memoryGetMaxChars: 12_000, toolResultMaxChars: 24_000 },
    "agents.entries.writer": {
      typingMode: "message",
      typingIntervalSeconds: 8,
      contextLimits: { toolResultMaxChars: 8_000 },
    },
    "agents.list": [
      { id: "legacy", typingIntervalSeconds: 10, contextLimits: { memoryGetDefaultLines: 80 } },
    ],
  });
  expect(result.raw).toMatchObject(
    config({
      "skills.load.watch": true,
      "agents.defaults": {
        typingIntervalSeconds: 6,
        contextLimits: { memoryGetMaxChars: 12_000 },
      },
      "agents.entries.writer.typingMode": "message",
      "agents.list": [{ id: "legacy" }],
    }),
  );
  expect(result.raw).not.toHaveProperty("ui");
});

it.each<[number | undefined, Record<string, unknown>, number]>([
  [undefined, { default: { debounceMs: 3000 }, work: { debounceMs: 4000 } }, 4000],
  [900, { work: { debounceMs: 4000 } }, 900],
  [undefined, { default: { debounceMs: 3000 }, work: { name: "Work" } }, 3000],
])(
  "selects the WhatsApp debounce with canonical value %s and accounts %j",
  (canonical, accounts, expected) => {
    const { raw } = migrate({
      ...(canonical === undefined ? {} : { "messages.inbound.byChannel.whatsapp": canonical }),
      "channels.whatsapp": { defaultAccount: "Work", debounceMs: 2000, accounts },
    });
    expect(raw).toHaveProperty("messages.inbound.byChannel.whatsapp", expected);
    expect(raw).not.toHaveProperty("channels.whatsapp.debounceMs");
    for (const id of Object.keys(accounts)) {
      expect(raw).not.toHaveProperty(`channels.whatsapp.accounts.${id}.debounceMs`);
    }
  },
);

it.each<[string, unknown, string, unknown]>([
  ["defaultModel", "openai/gpt-5.6", "agents.defaults.model", "openai/gpt-5.6"],
  ["messages.messagePrefix", "[wa]", "channels.whatsapp.responsePrefix", "[wa]"],
  ["cron", { webhook: "https://example.com", webhookToken: "keep" }, "cron.webhookToken", "keep"],
  ["session.maintenance.pruneDays", 7, "session.maintenance.pruneAfter", 7],
  ["session.resetByType.dm.mode", "idle", "session.resetByType.direct.mode", "idle"],
  ["talk.realtime.voice", "alloy", "talk.realtime.speakerVoice", "alloy"],
  [
    "mcp.servers.docs",
    { connectTimeout: 2, timeout: 3 },
    "mcp.servers.docs",
    { connectionTimeoutMs: 2000, requestTimeoutMs: 3000 },
  ],
  [
    "nodeHost.mcp.servers.local.connect_timeout",
    4,
    "nodeHost.mcp.servers.local.connectionTimeoutMs",
    4000,
  ],
  [
    "tools.media.audio.deepgram.smartFormat",
    true,
    "tools.media.audio.providerOptions.deepgram.smart_format",
    true,
  ],
])("moves alias %s", (path, value, canonical, expected) => {
  expect(migratePath(path, value).raw).toHaveProperty(canonical, expected);
});

it.each(["tui", "commands.modelsWrite", "tools.media.asyncCompletion"])(
  "strips dead key %s",
  (path) => expect(migratePath(path, true).raw).not.toHaveProperty(path),
);

it("keeps evidence mismatches while stripping canonical conflict aliases", () => {
  const preserved = {
    "tools.media.audio.baseUrl": "https://provider-required.example",
    proxy: { enabled: false, proxyUrl: "http://disabled-proxy.example" },
    "channels.telegram.threadBindings.enabled": false,
  };
  const result = migrate({
    ...structuredClone(preserved),
    "session.threadBindings.enabled": true,
    "discovery.wideArea": { enabled: false, domain: "disabled.example" },
    "channels.googlechat": { serviceAccount: "plain", serviceAccountRef: { source: "env" } },
    "channels.whatsapp.enabled": true,
    "web.enabled": false,
  });
  expect(result.raw).toMatchObject(config(preserved));
  expect(result.raw).toHaveProperty("proxy", preserved.proxy);
  expect(result.raw).toHaveProperty("channels.googlechat.serviceAccount", { source: "env" });
  for (const path of [
    "discovery.wideArea.domain",
    "channels.googlechat.serviceAccountRef",
    "web",
  ]) {
    expect(result.raw).not.toHaveProperty(path);
  }
});

it("keeps nonrepresentable exec and inherited memory policies", () => {
  const raw = config({
    "tools.exec": { security: "allowlist", ask: "always" },
    "memory.search": { provider: "openai", store: { vector: { enabled: false } } },
    "agents.entries.malformed.tools.exec": { security: "deny " },
    "agents.entries.onMissFull.tools.exec": { security: "full", ask: "on-miss" },
  });
  expect(applyAll(structuredClone(raw))).toEqual({ raw, changes: [] });
});

it("uses the inherited exec policy for a partial agent override", () => {
  const result = migrate({
    "tools.exec": { security: "allowlist", ask: "on-miss" },
    "agents.entries.nonInteractive.tools.exec": { ask: "off" },
  });
  expect(result.raw).toHaveProperty("tools.exec", { mode: "ask" });
  expect(result.raw).toHaveProperty("agents.entries.nonInteractive.tools.exec", {
    mode: "allowlist",
  });
});

it("strips core TTS persona prompts without entering opaque provider config", () => {
  const providers = { custom: { tts: { personas: { voice: { prompt: { owned: true } } } } } };
  const result = migrate({
    "tts.personas.alfred": { prompt: { style: "dry" }, providers: structuredClone(providers) },
    "agents.entries.voice.tts.personas.narrator.prompt": { pacing: "slow" },
  });
  expect(result.raw).toHaveProperty("tts.personas.alfred", { providers });
  expect(result.raw).not.toHaveProperty("agents.entries.voice.tts.personas.narrator.prompt");
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
it.each<[string, Record<string, unknown>, Record<string, unknown>, string?]>([
  [
    "messages",
    { suppressToolErrors: false, ackReaction: "👀" },
    { ackReaction: "👀" },
    "messages.suppressToolErrors",
  ],
  [
    "gateway.controlUi",
    { dangerouslyDisableDeviceAuth: false },
    {},
    "gateway.controlUi.dangerouslyDisableDeviceAuth",
  ],
  [
    "hooks.internal",
    { enabled: true, handlers: [], entries: {}, load: { extraDirs: ["  "] } },
    { entries: {}, load: { extraDirs: ["  "] } },
  ],
  [
    "agents.defaults.compaction",
    { truncateAfterCompaction: false, maxActiveTranscriptBytes: "20mb" },
    {},
  ],
  ["", { ui: { assistant: { name: "OpenClaw", avatar: "🦞" } } }, {}],
  [
    "agents.defaults.compaction",
    {
      customInstructions: "Keep decisions.",
      identifierPolicy: "custom",
      identifierInstructions: "Keep ticket IDs.",
      postCompactionSections: ["Red Lines"],
      memoryFlush: { prompt: "Write memory.", systemPrompt: "Be careful." },
    },
    { identifierPolicy: "strict", postCompactionSections: ["Red Lines"], memoryFlush: {} },
  ],
  ["tools", { experimental: { planTool: false } }, { updatePlan: false }],
  ["tools", { updatePlan: true, experimental: { planTool: false } }, { updatePlan: true }],
  ["tools.exec", { mode: "deny", security: "full", ask: "off" }, { mode: "deny" }],
  ["session.maintenance", { pruneDays: 7, pruneAfter: false }, { pruneAfter: false }],
  [
    "channels.discord",
    config({
      "voice.realtime": { voice: "alloy", speakerVoice: "marin" },
      "accounts.work.voice.realtime": { voice: "cedar", enabled: true },
      "accounts.malformed": null,
    }),
    config({
      "voice.realtime.speakerVoice": "marin",
      "accounts.work.voice.realtime": { speakerVoice: "cedar", enabled: true },
      "accounts.malformed": null,
    }),
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
  ["nodeHost.mcp.servers.local", { workingDirectory: "/node" }, { cwd: "/node" }],
  ["", { web: { enabled: false } }, { channels: { whatsapp: { enabled: false } } }],
])("migrates %s: %j", (path, value, expected, issue) => {
  const raw = configWithPath(path, value);
  if (issue) {
    expectIssue(raw, issue);
  }
  expect(applyAll(raw).raw).toEqual(configWithPath(path, expected));
  expect(applyAll(raw).changes).toEqual([]);
});
