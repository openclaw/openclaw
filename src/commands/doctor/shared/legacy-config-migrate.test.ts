// Legacy config migration tests cover generic doctor repair of old config layouts.

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { setConfigValueAtPath } from "../../../config/config-paths.js";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { legacyCodexProviderIdentityKey } from "./codex-route-model-ref.js";
import { pruneBindingsForMissingAgents } from "./legacy-config-binding-repair.js";
import { migrateLegacyConfigForTest as migrate } from "./legacy-config-migrate.apply.test-support.js";
import { collectBlockedLegacyOpenAICodexProviderPlan } from "./legacy-config-migrations.runtime.models.js";

function repairBindingsForTest<T extends object>(config: T) {
  const changes: string[] = [];
  return { config: pruneBindingsForMissingAgents(config, changes), changes };
}

function binding(agentId: string) {
  return { agentId, match: { channel: "discord" } };
}

function issuePaths(raw: unknown) {
  return findLegacyConfigIssues(raw).map((issue) => issue.path);
}

function migratePaths(paths: Record<string, unknown>) {
  return migrate(configAt(paths));
}

function configAt(paths: Record<string, unknown>) {
  const raw: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(paths)) {
    setConfigValueAtPath(raw, path.split("."), value);
  }
  return raw;
}

it("preserves session typing precedence over an existing agent default", () => {
  const res = migratePaths({
    "agents.defaults.typingMode": "message",
    "session.typingMode": "thinking",
  });
  expect(res.config?.agents?.defaults?.typingMode).toBe("thinking");
  expect(res.config?.session).toEqual({});
});

it("removes deprecated session.maintenance.rotateBytes", () => {
  const maintenance = { mode: "enforce", pruneAfter: "30d", maxEntries: 500 };
  const res = migratePaths({ "session.maintenance": { ...maintenance, rotateBytes: "10mb" } });
  expect(res.config?.session?.maintenance).toEqual(maintenance);
});

it("removes cron.runLog while preserving current cron config", () => {
  const raw = { cron: { enabled: true, runLog: { maxBytes: "2mb", keepLines: 100 } } };
  expect(issuePaths(raw)).toContain("cron.runLog");
  expect(migrate(raw).config?.cron).toEqual({ enabled: true });
});

it("collapses split spawn flags per scope and resolves conflicts conservatively", () => {
  const bindings = { spawnSubagentSessions: true, spawnAcpSessions: true };
  const res = migratePaths({
    "channels.discord.threadBindings": { enabled: true, ...bindings },
    "channels.discord.accounts.work.threadBindings": { ...bindings, spawnAcpSessions: false },
  });
  expect(res.config).toHaveProperty("channels.discord.threadBindings", {
    enabled: true,
    spawnSessions: true,
  });
  expect(res.config).toHaveProperty("channels.discord.accounts.work.threadBindings", {
    spawnSessions: false,
  });
});

it("strips explicit bundled discovery mode after machine-state capture", () => {
  expect(
    migrate({ plugins: { allow: ["telegram"], bundledDiscovery: "allowlist" } }).config,
  ).toEqual({ plugins: { allow: ["telegram"] } });
});

it("removes a zero port and its empty gateway section", () => {
  expect(migrate({ gateway: { port: 0 } }).config).toEqual({});
});

it("preserves Qwen params when their destination cannot be written", () => {
  const models = { "vllm/Qwen/model": { params: { qwenThinkingFormat: "chat-template" } } };
  const res = migratePaths({
    "agents.defaults.models": models,
    "models.providers.vllm": "malformed",
  });
  expect(res.config?.models?.providers?.vllm).toBe("malformed");
  expect(res.config?.agents?.defaults?.models).toEqual(models);
});

it("removes only invalid thinking formats across provider catalogs", () => {
  const valid = { id: "valid", compat: { thinkingFormat: "qwen-chat-template" } };
  const res = migrateProviderConfig({
    bailian: {
      models: [
        valid,
        { id: "legacy", compat: { thinkingFormat: "old-bailian", supportsTools: true } },
      ],
    },
  });
  expect(res.config?.models?.providers?.bailian?.models).toEqual([
    valid,
    { id: "legacy", compat: { supportsTools: true } },
  ]);
  expect(migrate(res.config)).toEqual({ config: null, changes: [] });
});

it.each([
  {
    name: "implicit main exists but uppercase MAIN and missing agents are pruned",
    list: [{ id: "ALPHA" }],
    bindings: ["main", "alpha", "MAIN", "ghost"].map(binding),
    expected: ["main", "alpha"].map(binding),
    changes: ["Removed 2 bindings that referenced missing agents.list ids."],
  },
  {
    name: "malformed roster leaves bindings untouched",
    list: [null, { id: 1 }, { id: "alpha" }],
    bindings: ["ghost", "alpha"].map(binding),
    expected: ["ghost", "alpha"].map(binding),
    changes: [],
  },
])("repairs bindings: $name", ({ list, bindings, expected, changes }) => {
  const res = repairBindingsForTest({ agents: { list }, bindings });
  expect(res.config.bindings).toEqual(expected);
  expect(res.changes).toEqual(changes);
});

function migrateProviderConfig(providers: Record<string, unknown>) {
  return migrate({ models: { providers } });
}

function codexProvider(overrides: Record<string, unknown> = {}) {
  return {
    api: "openai-chatgpt-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    ...overrides,
  };
}

function browserSandbox(browser: Record<string, unknown>) {
  return { sandbox: { browser } };
}

function modelMapConfig(models: Record<string, unknown>) {
  return configAt({ "agents.defaults.models": models });
}

const supervision = {
  endpoints: [{ id: "local", transport: "stdio-proxy", command: "codex" }],
  allowRawTranscripts: true,
  allowWriteControls: true,
};

function qwenModel(id: string, thinkingFormat: string, extra: Record<string, unknown> = {}) {
  return { id, reasoning: true, compat: { thinkingFormat }, ...extra };
}

function selection(primary: string, ...fallbacks: string[]) {
  return { primary, fallbacks };
}

describe("legacy Codex provider config migrate", () => {
  it("moves legacy OpenAI Codex provider config to canonical OpenAI provider config", () => {
    const provider = {
      baseUrl: "https://chatgpt.com/backend-api/codex",
      api: "openai-chatgpt-responses",
      models: [{ id: "gpt-5.5", name: "GPT-5.5", api: "openai-chatgpt-responses" }],
    };
    const res = migrateProviderConfig({ "openai-codex": provider });
    expect(res.config?.models?.providers?.openai).toEqual(provider);
    expect(res.config?.models?.providers).not.toHaveProperty("openai-codex");
  });

  it("normalizes moved shipped codex model auto runtime and preserves explicit overrides", () => {
    const res = migrateProviderConfig({
      codex: {
        models: [
          { id: "gpt-missing" },
          { id: "gpt-auto", agentRuntime: { id: "auto" } },
          { id: "gpt-openclaw", agentRuntime: { id: "openclaw" } },
        ],
      },
    });

    expect(res.config?.models?.providers?.openai?.models).toEqual([
      { id: "gpt-missing", agentRuntime: { id: "codex" } },
      { id: "gpt-auto", agentRuntime: { id: "codex" } },
      { id: "gpt-openclaw", agentRuntime: { id: "openclaw" } },
    ]);
    expect(res.config?.models?.providers).not.toHaveProperty("codex");
  });

  it.each([
    {
      name: "provider-scoped auth cannot be moved",
      openai: {
        models: [{ id: "text-embedding-3-small" }],
      },
      codex: {
        auth: "oauth",
        headers: { Authorization: "Bearer synthetic" },
        api: "openai-chatgpt-responses",
        models: [{ id: "gpt-5.6-sol", api: "openai-chatgpt-responses" }],
      },
      warning: "models.providers.codex cannot be merged automatically",
    },
    {
      name: "same-id models are not equivalent",
      openai: {
        apiKey: "placeholder",
        models: [
          {
            id: "gpt-5.6-sol",
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
          },
        ],
      },
      codex: {
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        models: [{ id: "gpt-5.6-sol" }, { id: "gpt-5.4-mini" }],
      },
      warning: "colliding model definitions differ for: gpt-5.6-sol",
    },
  ])(
    "keeps conflicting shipped codex config for manual review: $name",
    ({ openai, codex, warning }) => {
      const res = migrateProviderConfig({ openai, codex });
      expect(res.config?.models?.providers).toEqual({ openai, codex });
      const plan = collectBlockedLegacyOpenAICodexProviderPlan(res.config);
      expect(plan.warning).toEqual(expect.stringContaining(warning));
      expect(plan.blockedModelIdentities).toEqual([
        expectDefined(
          legacyCodexProviderIdentityKey("codex"),
          "blocked provider namespace test invariant",
        ),
      ]);
    },
  );

  it("removes equivalent same-id shipped codex models", () => {
    const model = {
      id: "gpt-5.6-sol",
      ...codexProvider(),
      agentRuntime: { id: "codex" },
    };
    const res = migrateProviderConfig({
      openai: { models: [model] },
      codex: codexProvider({ models: [{ id: "gpt-5.6-sol" }] }),
    });

    expect(res.config?.models?.providers).not.toHaveProperty("codex");
    expect(res.config?.models?.providers?.openai?.models).toEqual([model]);
  });

  it("preserves model-scoped defaults and overrides when merging legacy providers", () => {
    const defaults = codexProvider({
      contextWindow: 200000,
      contextTokens: 180000,
      maxTokens: 8192,
      params: { store: false, reasoning: { effort: "medium" } },
      agentRuntime: { id: "codex" },
    });
    const embedding = {
      id: "text-embedding-3-small",
      name: "Chat",
      api: "openai-chatgpt-responses",
    };
    const res = migrateProviderConfig({
      "openai-codex": {
        ...defaults,
        models: [
          {
            id: "gpt-5.5",
            name: "Chat",
            params: { reasoning: { effort: "high" }, verbosity: "low" },
          },
          { id: "gpt-5.4" },
        ],
      },
      openai: {
        api: "openai-chatgpt-responses",
        baseUrl: "https://api.openai.com/v1",
        models: [embedding],
      },
    });
    expect(res.config?.models?.providers).not.toHaveProperty("openai-codex");
    expect(res.config?.models?.providers?.openai).toEqual({
      api: "openai-chatgpt-responses",
      baseUrl: "https://api.openai.com/v1",
      models: [
        embedding,
        {
          ...defaults,
          id: "gpt-5.5",
          name: "Chat",
          params: { store: false, reasoning: { effort: "high" }, verbosity: "low" },
        },
        { ...defaults, id: "gpt-5.4" },
      ],
    });
  });

  it("preserves legacy models-add metadata marker when merging codex models", () => {
    const model = {
      id: "gpt-5.5",
      api: "openai-chatgpt-responses",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
      contextWindow: 400_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
    };
    const res = migrateProviderConfig({
      openai: {
        api: "openai-chatgpt-responses",
        baseUrl: "https://api.openai.com/v1",
        models: [{ id: "text-embedding-3-small" }],
      },
      "openai-codex": codexProvider({ models: [model] }),
    });

    const openai = res.config?.models?.providers?.openai as Record<string, unknown> | undefined;
    expect(openai?.models).toEqual([
      { id: "text-embedding-3-small" },
      {
        ...model,
        baseUrl: "https://chatgpt.com/backend-api",
        metadataSource: "models-add",
      },
    ]);
    expect(res.config?.models?.providers).not.toHaveProperty("openai-codex");
  });

  it("does not report a fixable legacy issue after blocked codex merge normalization already ran", () => {
    const raw = configAt({
      "models.providers.openai.api": "openai-chatgpt-responses",
      "models.providers.openai.baseUrl": "https://api.openai.com/v1",
      "models.providers.openai.apiKey": "placeholder",
      "models.providers.openai.params.store": true,
      "models.providers.openai.request.retry.maxAttempts": 1,
      "models.providers.openai.models": [{ id: "text-embedding-3-small" }],
      "models.providers.openai-codex.api": "openai-chatgpt-responses",
      "models.providers.openai-codex.baseUrl": "https://chatgpt.com/backend-api",
      "models.providers.openai-codex.models": [{ id: "gpt-5.5", api: "openai-chatgpt-responses" }],
    });
    const res = migrate(raw);

    expect(res.config?.models).toEqual(raw.models);
    expect(res.config?.agents?.defaults?.model).toEqual({
      primary: "openai/text-embedding-3-small",
    });
    expect(collectBlockedLegacyOpenAICodexProviderPlan(res.config).blockedModelIdentities).toEqual([
      expectDefined(legacyCodexProviderIdentityKey("openai-codex"), "blocked legacy namespace"),
    ]);
    expect(migrate(res.config)).toEqual({ config: null, changes: [] });
    expect(issuePaths(raw)).not.toContain("models.providers");
  });
});

it("removes retired silent reply config and preserves channel group policy", () => {
  const res = migratePaths({
    "agents.defaults.silentReply": { group: "allow", internal: "allow" },
    "surfaces.telegram": { silentReply: { group: "disallow", internal: "disallow" } },
  });
  expect(res.config?.agents?.defaults).toEqual({ silentReply: { group: "allow" } });
  expect(res.config?.surfaces?.telegram).toEqual({ silentReply: { group: "disallow" } });
  expect(findLegacyConfigIssues(res.config)).toEqual([]);
  expect(migrate(res.config)).toEqual({ config: null, changes: [] });
});

describe("profile configured tool section migrate", () => {
  it.each([
    {
      name: "configured sections alone",
      tools: {
        profile: "messaging",
        alsoAllow: ["read", "write"],
        exec: { security: "allowlist" },
        fs: { workspaceOnly: true },
        byProvider: { openai: { profile: "messaging" } },
      },
      agents: { list: [{ id: "sage", tools: { exec: { security: "allowlist" } } }] },
    },
    {
      name: "unrelated allowlists and top-level provider profiles",
      tools: {
        profile: "messaging",
        allow: ["message", "sessions_*", "gmail_search"],
        exec: { security: "allowlist" },
        byProvider: { openai: { allow: ["message", "exec", "process"] } },
      },
    },
  ])("does not infer configured-section grants from $name", ({ tools, agents }) => {
    const raw = { tools, ...(agents ? { agents } : {}) };
    expect(migrate(raw)).toEqual({ config: null, changes: [] });
    expect(issuePaths(raw)).not.toContain("tools");
    if (agents) {
      expect(issuePaths(raw)).toContain("agents.list");
    }
  });

  it("repairs explicit grants per scope without broadening wildcard or alsoAllow intent", () => {
    const res = migratePaths({
      "tools.profile": "messaging",
      "tools.allow": ["message", "exec", "process"],
      "tools.alsoAllow": ["browser"],
      "tools.exec": { security: "allowlist" },
      "tools.byProvider": {
        openai: { profile: "messaging", allow: ["message", "exec", "process"] },
      },
      "agents.list": [
        {
          id: "direct",
          tools: { allow: ["message", "exec", "process"], exec: { security: "allowlist" } },
        },
        {
          id: "also",
          tools: { allow: ["message"], alsoAllow: ["exec"], exec: { security: "allowlist" } },
        },
        {
          id: "broad",
          tools: { profile: "messaging", allow: ["*"], exec: { security: "allowlist" } },
        },
      ],
    });
    expect(res.config?.tools).toEqual({
      profile: "full",
      allow: ["message", "browser", "exec", "process"],
      exec: { security: "allowlist" },
      byProvider: { openai: { profile: "full", allow: ["message", "exec", "process"] } },
    });
    expect(res.config?.agents?.entries?.direct?.tools).toEqual({
      profile: "full",
      allow: ["message", "exec", "process"],
      exec: { security: "allowlist" },
    });
    expect(res.config?.agents?.entries?.also?.tools).toEqual({
      profile: "full",
      allow: ["message", "exec"],
      exec: { security: "allowlist" },
    });
    const broad = res.config?.agents?.entries?.broad?.tools;
    expect(broad?.profile).toBe("full");
    expect(broad?.allow).toEqual(expect.arrayContaining(["message", "exec", "process"]));
    expect(broad?.allow).not.toContain("*");
    expect(broad?.allow).not.toContain("read");
  });

  it("ignores blocked inherited provider keys while resolving provider repairs", () => {
    const raw = JSON.parse(
      '{"tools":{"byProvider":{"__proto__":{"profile":"messaging"},"qwen":{"profile":"messaging"}}},"agents":{"list":[{"id":"sage","tools":{"exec":{"security":"allowlist"},"byProvider":{"qwen/qwen-plus":{"allow":["message","exec","process"]}}}}]}}',
    );
    const res = migrate(raw);

    expect(Object.prototype).not.toHaveProperty("profile");
    expect(res.config?.agents?.entries?.sage?.tools?.byProvider?.["qwen/qwen-plus"]?.allow).toEqual(
      ["message", "exec", "process"],
    );
    expect(res.config?.agents?.entries?.sage?.tools?.byProvider?.["qwen/qwen-plus"]?.profile).toBe(
      "full",
    );
  });
});

it.each([
  {
    name: "OTLP logs",
    protocol: "grpc",
    logsExporter: "otlp",
    enabled: false,
  },
  {
    name: "config-interpolated grpc with working stdout logs",
    protocol: "${OTEL_PROTOCOL}",
    logsExporter: "stdout",
    enabled: true,
  },
])(
  "removes unsupported grpc without disabling working signals: $name",
  ({ logsExporter, protocol, enabled }) => {
    const otel = { enabled: true, traces: false, metrics: false, logs: true, logsExporter };
    const authored = { diagnostics: { otel: { ...otel, protocol } } };
    const resolved = { diagnostics: { otel: { ...otel, protocol: "grpc" } } };
    const res = migrate(
      authored,
      protocol === "grpc"
        ? undefined
        : {
            authoredRaw: authored,
            resolvedRaw: resolved,
          },
    );
    expect(res.config?.diagnostics?.otel).toEqual({ ...otel, enabled });
  },
);

it.each([
  {
    name: "automatic route cleanup preserves siblings",
    tailscale: { mode: "serve", resetOnExit: true, preserveFunnel: true },
    retiredKey: "resetOnExit",
    expected: { mode: "serve", preserveFunnel: true },
    message: expect.stringContaining("managed Tailscale routes now end automatically"),
  },
  {
    name: "managed Service disables ingress until the operator chooses a device route",
    tailscale: { mode: "serve", serviceName: "svc:openclaw" },
    retiredKey: "serviceName",
    expected: { mode: "off" },
    message: expect.stringMatching(/serviceName.*mode=off.*tailscale serve clear/s),
  },
  {
    name: "ignored Service preserves Funnel",
    tailscale: { mode: "funnel", serviceName: "svc:ignored" },
    retiredKey: "serviceName",
    expected: { mode: "funnel" },
    message: expect.stringContaining("current Tailscale mode is unchanged"),
  },
])("removes retired Tailscale settings: $name", ({ tailscale, retiredKey, expected, message }) => {
  const raw = { gateway: { bind: "loopback", tailscale } };
  expect(issuePaths(raw)).toContain(`gateway.tailscale.${retiredKey}`);
  const res = migrate(raw);
  expect(res.config?.gateway?.tailscale).toEqual(expected);
  expect(res.changes).toEqual([message]);
  expect(migrate(res.config)).toEqual({ config: null, changes: [] });
});

describe("legacy migrate audio transcription", () => {
  it("drops invalid audio.transcription payloads", () => {
    const raw = configAt({
      "audio.transcription.command": [{}],
    });

    expect(findLegacyConfigIssues(raw)).toEqual([
      {
        path: "audio.transcription",
        message: "Use a capability-tagged tools.media.models entry instead.",
      },
    ]);
    const res = migrate(raw);
    expect(res.config).toEqual({});
  });

  it("rewrites legacy audio {input} placeholders to media templates", () => {
    const raw = configAt({
      "tools.media.models": [{ provider: "openai", model: "vision", capabilities: ["image"] }],
      "tools.media.audio.models": [
        { provider: "openai", model: "vision", capabilities: ["image"] },
      ],
      "audio.transcription.command": [
        "whisper-cli",
        "--model",
        "small",
        "{input}",
        "--input={input}",
      ],
      "audio.transcription.timeoutSeconds": 30,
    });

    expect(issuePaths(raw)).toContain("audio.transcription");
    const res = migrate(raw);
    expect(res.config).not.toHaveProperty("audio");
    expect(res.config?.tools?.media?.models).toEqual([
      { provider: "openai", model: "vision", capabilities: ["image"] },
      {
        type: "cli",
        command: "whisper-cli",
        args: ["--model", "small", "{{AttachmentPath}}", "--input={{AttachmentPath}}"],
        timeoutSeconds: 30,
        capabilities: ["audio"],
      },
    ]);
    expect(res.config?.tools?.media?.audio).toEqual({
      enabled: true,
      preferredModel: "cli:whisper-cli",
    });
  });
});

describe("legacy sandbox config migrate", () => {
  it("disables the default sandbox browser network without granting inherited egress", () => {
    const disabled = { enabled: false, network: "openclaw-sandbox-browser" };
    const raw = configAt({
      "agents.ownership": "explicit",
      "agents.defaults": browserSandbox({ enabled: true, network: " NONE ", autoStart: false }),
      "agents.entries.main": browserSandbox({ enabled: true, network: "none", headless: true }),
      "agents.entries.inherited": browserSandbox({ enabled: true, headless: true }),
      "agents.entries.isolated": browserSandbox({ network: "isolated-browser-net" }),
      "agents.entries.blankEnabled": browserSandbox({ enabled: true, network: "   " }),
      "agents.entries.blankInherited": browserSandbox({ network: "" }),
    });

    expect(issuePaths(raw)).toEqual(["agents.defaults.sandbox.browser.network", "agents"]);
    const res = migrate(raw);

    expect(res.config?.agents?.defaults?.sandbox?.browser).toEqual({
      ...disabled,
      autoStart: false,
    });
    for (const [id, expected] of Object.entries({
      main: { ...disabled, headless: true },
      inherited: { enabled: false, headless: true },
      isolated: { enabled: true, network: "isolated-browser-net" },
      blankEnabled: { enabled: true, network: "   " },
      blankInherited: { enabled: true, network: "" },
    })) {
      expect(res.config?.agents?.entries?.[id]?.sandbox?.browser).toEqual(expected);
    }
    expect(migrate(res.config)).toEqual({ config: null, changes: [] });
  });

  it("disables explicit per-agent network none in legacy list rosters", () => {
    const raw = {
      agents: {
        list: [
          {
            id: "legacy",
            default: true,
            ...browserSandbox({ network: "NONE", autoStart: false }),
          },
        ],
      },
    };

    expect(findLegacyConfigIssues(raw)).toContainEqual({
      path: "agents",
      message: expect.stringContaining('sandbox.browser.network = "none"'),
    });
    const res = migrate(raw);

    expect(res.config?.agents?.entries?.legacy?.sandbox?.browser).toEqual({
      enabled: false,
      network: "openclaw-sandbox-browser",
      autoStart: false,
    });
    expect(migrate(res.config)).toEqual({ config: null, changes: [] });
  });
});

it.each([
  {
    name: "moves only legacy x_search auth",
    paths: {
      "tools.web.x_search": { apiKey: "xai-legacy-key", enabled: true, model: "grok-4-1-fast" },
    },
    xSearch: { enabled: true, model: "grok-4-1-fast" },
    webSearch: { apiKey: "xai-legacy-key" },
  },
  {
    name: "moves legacy xAI search config without replacing model selections",
    paths: {
      "tools.web.search": { grok: { model: "grok-4-1-fast" } },
      "tools.web.x_search": { model: "grok-4-1-fast-non-reasoning" },
    },
    xSearch: { model: "grok-4-1-fast-non-reasoning" },
    webSearch: { model: "grok-4-1-fast" },
  },
])("$name into plugin-owned config", ({ paths, xSearch, webSearch }) => {
  const res = migratePaths(paths);
  expect((res.config?.tools?.web as Record<string, unknown> | undefined)?.x_search).toEqual(
    xSearch,
  );
  expect(res.config?.plugins?.entries?.xai).toEqual({ enabled: true, config: { webSearch } });
});

it.each([
  {
    name: "active supervision rewrites the allowlist",
    plugins: configAt({
      allow: ["telegram", "codex-supervisor", "codex"],
      "entries.codex-supervisor.enabled": true,
      "entries.codex-supervisor.config": supervision,
      "entries.codex-supervisor.hooks.enabled": true,
    }),
    expected: configAt({
      allow: ["telegram", "codex"],
      "entries.codex.enabled": true,
      "entries.codex.config.supervision": { enabled: true, ...supervision },
    }),
  },
  {
    name: "disabled supervision preserves the implicit harness",
    agents: { defaults: { model: "openai/gpt-5.5" } },
    plugins: configAt({
      "entries.codex.config.appServer": { transport: "stdio" },
      "entries.codex-supervisor.enabled": false,
    }),
    expected: configAt({
      "entries.codex.config": {
        appServer: { transport: "stdio" },
        supervision: { enabled: false },
      },
    }),
  },
  {
    name: "canonical values win while missing supervision fields are filled",
    plugins: configAt({
      deny: [" CODEX-SUPERVISOR ", "telegram"],
      "entries. CODEX .enabled": false,
      "entries. CODEX .config.appServer.transport": "stdio",
      "entries. CODEX .config.supervision.enabled": true,
      "entries. CODEX .config.supervision.endpoints": [
        { id: "canonical", transport: "stdio-proxy" },
      ],
      "entries. CODEX .config.supervision.allowWriteControls": false,
      "entries. CODEX-SUPERVISOR .enabled": true,
      "entries. CODEX-SUPERVISOR .config.endpoints": [{ id: "legacy", transport: "stdio-proxy" }],
      "entries. CODEX-SUPERVISOR .config.allowRawTranscripts": true,
      "entries. CODEX-SUPERVISOR .config.allowWriteControls": true,
    }),
    expected: configAt({
      deny: ["telegram"],
      "entries. CODEX .enabled": false,
      "entries. CODEX .config.appServer.transport": "stdio",
      "entries. CODEX .config.supervision.enabled": true,
      "entries. CODEX .config.supervision.endpoints": [
        { id: "canonical", transport: "stdio-proxy" },
      ],
      "entries. CODEX .config.supervision.allowRawTranscripts": true,
      "entries. CODEX .config.supervision.allowWriteControls": false,
    }),
  },
  {
    name: "denied legacy plugin leaves supervision dormant",
    plugins: {
      deny: ["codex-supervisor"],
      entries: { "codex-supervisor": { enabled: true, config: { allowWriteControls: true } } },
    },
    expected: {
      deny: [],
      entries: {
        codex: { config: { supervision: { enabled: false, allowWriteControls: true } } },
      },
    },
  },
  {
    name: "malformed legacy entry does not create Codex config",
    plugins: {
      entries: { "codex-supervisor": "invalid" },
    },
    expected: { entries: {} },
  },
])("migrates supervision: $name", ({ plugins, agents, expected }) => {
  const raw = { plugins, ...(agents ? { agents } : {}) };
  expect(issuePaths(raw)).toContain("plugins");
  const res = migrate(raw);
  expect(res.config?.plugins).toEqual(expected);
  if (agents) {
    expect(res.config?.agents).toEqual(agents);
  }
  expect(migrate(res.config)).toEqual({ config: null, changes: [] });
});

describe("legacy bundled provider discovery migrate", () => {
  it("rewrites legacy OpenAI Codex plugin policy ids", () => {
    const res = migratePaths({
      "plugins.allow": ["telegram", "openai-codex", "openai"],
      "plugins.deny": ["openai-codex"],
      "plugins.entries.openai-codex.enabled": false,
      "plugins.slots.memory": "openai-codex",
    });

    expect(res.config?.plugins?.allow).toEqual(["telegram", "openai"]);
    expect(res.config?.plugins?.deny).toEqual(["openai"]);
    expect(res.config?.plugins?.entries?.openai).toEqual({ enabled: false });
    expect(res.config?.plugins?.entries?.["openai-codex"]).toBeUndefined();
    expect(res.config?.plugins?.slots?.memory).toBe("openai");
  });
});

describe("legacy migrate controlUi.allowedOrigins seed (issue #29385)", () => {
  it.each([
    {
      gateway: { bind: "custom", port: 9000, customBindHost: "192.168.1.100" },
      bind: "custom",
      allowedOrigins: [
        "http://localhost:9000",
        "http://127.0.0.1:9000",
        "http://192.168.1.100:9000",
      ],
    },
    {
      gateway: { bind: "0.0.0.0", controlUi: { basePath: "/app", allowedOrigins: ["", "   "] } },
      bind: "lan",
      allowedOrigins: ["http://localhost:18789", "http://127.0.0.1:18789"],
    },
  ])(
    "seeds non-loopback origins while preserving gateway settings: $gateway.bind",
    ({ gateway, bind, allowedOrigins }) => {
      expect(migrate({ gateway }).config?.gateway).toEqual({
        ...gateway,
        bind,
        controlUi: { ...gateway.controlUi, allowedOrigins },
      });
    },
  );

  it.each([
    { allowedOrigins: ["https://control.example.com"] },
    { dangerouslyAllowHostHeaderOriginFallback: true },
  ])("preserves an explicit origin policy: %j", (controlUi) => {
    expect(migrate({ gateway: { bind: "lan", controlUi } })).toEqual({
      config: null,
      changes: [],
    });
  });
});

describe("legacy model compat migrate", () => {
  it("normalizes persisted model aliases across nested selections and provider catalogs", () => {
    const retired = "google/gemini-3-pro-preview";
    const canonical = "google/gemini-3.1-pro-preview";
    const raw = configAt({
      "agents.defaults.model": retired,
      "agents.defaults.mediaModels": {
        image: retired,
        video: { primary: retired, fallbacks: [retired] },
      },
      "models.providers.google": { models: [{ id: "gemini-3-pro-preview", name: "Gemini" }] },
      "models.providers.myproxy": {
        models: [{ id: "google/gemini-3-pro-preview", name: "Gemini proxy" }],
      },
      "models.providers.openai": { models: [{ id: "gpt-4o", name: "GPT-4o" }] },
    });

    expect(issuePaths(raw)).toEqual(expect.arrayContaining(["agents", "models"]));
    const res = migrate(raw);
    expect(res.config?.agents?.defaults).toMatchObject({
      model: canonical,
      mediaModels: { image: canonical, video: { primary: canonical, fallbacks: [canonical] } },
    });
    expect(res.config?.models?.providers?.google?.models?.[0]?.id).toBe("gemini-3.1-pro-preview");
    expect(res.config?.models?.providers?.myproxy?.models?.[0]?.id).toBe(canonical);
    expect(res.config?.models?.providers?.openai?.models?.[0]?.id).toBe("gpt-4o");
  });

  it("canonicalizes persisted OpenAI GPT-5.6 aliases without affecting GitHub Copilot", () => {
    const copilot = "github-copilot/gpt-5.6";
    const res = migratePaths({
      "agents.defaults.model": { primary: "openai/gpt-5.6@openai:work" },
      "agents.defaults.modelPolicy": { allow: ["openai/gpt-5.6", copilot] },
      "agents.defaults.models": {
        "openai/gpt-5.6": { alias: "GPT" },
        "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } },
        [copilot]: { alias: "Copilot GPT" },
      },
      "models.providers.openai": { models: [{ id: "gpt-5.6", name: "GPT alias" }] },
      "models.providers.github-copilot": { models: [{ id: "gpt-5.6", name: "Copilot GPT" }] },
    });
    const defaults = res.config?.agents?.defaults;
    expect(defaults).toMatchObject({
      model: { primary: "openai/gpt-5.6-sol@openai:work" },
      modelPolicy: { allow: ["openai/gpt-5.6-sol", copilot] },
    });
    expect(defaults?.models).toEqual({
      "openai/gpt-5.6-sol": { alias: "GPT", agentRuntime: { id: "openclaw" } },
      [copilot]: { alias: "Copilot GPT" },
    });
    expect(res.config?.models?.providers?.openai?.models?.[0]?.id).toBe("gpt-5.6-sol");
    expect(res.config?.models?.providers?.["github-copilot"]?.models?.[0]?.id).toBe("gpt-5.6");
  });

  it("merges provider catalog rows that normalize to an explicitly canonical id", () => {
    const res = migrateProviderConfig({
      google: {
        models: [
          {
            id: "gemini-3-pro-preview",
            name: "Retired alias",
            maxTokens: 65_536,
            cost: { input: 1 },
          },
          { id: "gemini-3.1-pro-preview", name: "Canonical", cost: { output: 2 } },
        ],
      },
    });

    expect(res.config?.models?.providers?.google?.models).toEqual([
      {
        id: "gemini-3.1-pro-preview",
        name: "Canonical",
        maxTokens: 65_536,
        cost: { output: 2, input: 1 },
      },
    ]);
  });

  it("deep-merges colliding model spellings and reports only unequal fields", () => {
    const res = migrate(
      modelMapConfig({
        "openai/gpt-5.6": {
          params: {
            reasoning: { effort: "high", budget: 100 },
            tags: ["stable"],
            fallbacks: ["openai/GPT-5.6"],
          },
          streaming: false,
        },
        "openai/GPT-5.6": {
          params: {
            reasoning: { effort: "low", summary: "auto" },
            tags: ["stable"],
            fallbacks: ["openai/gpt-5.6-sol"],
          },
          alias: "legacy-four",
        },
      }),
    );

    expect(res.config?.agents?.defaults?.models).toEqual({
      "openai/gpt-5.6-sol": {
        params: {
          reasoning: { effort: "high", budget: 100, summary: "auto" },
          tags: ["stable"],
          fallbacks: ["openai/gpt-5.6-sol"],
        },
        streaming: false,
        alias: "legacy-four",
      },
    });
    expect(res.changes.filter((change) => change.includes("Merged"))).toEqual([
      'Merged config.agents.defaults.models key "openai/GPT-5.6" into "openai/gpt-5.6-sol"; kept existing values for conflicting fields: params.reasoning.effort.',
    ]);
  });

  it("filters blocked keys recursively from both model collision sides", () => {
    const raw =
      '{"agents":{"defaults":{"models":{"openai/gpt-5.6-sol":{"__proto__":{"polluted":true},"alias":"canonical-five","params":{"nested":{"__proto__":{"polluted":true},"model":"openai/gpt-5.6"}}},"openai/GPT-5.6":{"alias":"legacy-four","__proto__":{"polluted":true},"streaming":false,"params":{"nested":{"__proto__":{"polluted":true},"added":true}}}}}}}';
    const res = migrate(JSON.parse(raw));
    const merged = res.config?.agents?.defaults?.models?.["openai/gpt-5.6-sol"] as Record<
      string,
      unknown
    >;
    const params = merged.params as Record<string, unknown>;
    const nested = params.nested as Record<string, unknown>;

    for (const record of [merged, params, nested]) {
      expect(Object.getOwnPropertyNames(record)).not.toContain("__proto__");
      expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
      expect(record.polluted).toBeUndefined();
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(merged).toEqual({
      alias: "canonical-five",
      params: { nested: { model: "openai/gpt-5.6-sol", added: true } },
      streaming: false,
    });
  });

  it("does not invoke prototype setters when copying the rewritten config root", () => {
    const raw = JSON.parse(
      '{"__proto__":{"polluted":true},"agents":{"defaults":{"model":"openai/GPT-5.6"}}}',
    ) as Record<string, unknown>;
    const res = migrate(raw);
    const config = res.config as unknown as Record<string, unknown>;

    expect(Object.getPrototypeOf(config)).toBe(Object.prototype);
    expect(Object.hasOwn(config, "__proto__")).toBe(true);
    expect(config.polluted).toBeUndefined();
    expect(res.config?.agents?.defaults?.model).toBe("openai/gpt-5.6-sol");
  });

  it("reports malformed scalar collisions without claiming equal values conflict", () => {
    const res = migrate(
      modelMapConfig({
        "openai/gpt-5.6-sol": false,
        "openai/GPT-5.6": true,
        "openai/gpt-5.6": false,
      }),
    );

    expect(res.config?.agents?.defaults?.models?.["openai/gpt-5.6-sol"]).toBe(false);
    expect(res.changes.filter((change) => change.includes("Merged"))).toEqual([
      'Merged config.agents.defaults.models key "openai/GPT-5.6" into "openai/gpt-5.6-sol"; kept existing values for conflicting fields: value.',
      'Merged config.agents.defaults.models key "openai/gpt-5.6" into "openai/gpt-5.6-sol".',
    ]);
  });

  it("moves Qwen model-map and model-row params while preserving canonical compat", () => {
    const raw = configAt({
      "agents.defaults.models.VLLM/Qwen/new@local.params.qwen_thinking_format": "enable_thinking",
      "agents.defaults.models.vllm/Qwen/existing.params.qwenThinkingFormat": "chat-template",
      "agents.defaults.models.vllm/Qwen/existing.params.temperature": 0.2,
      "agents.defaults.models.vllm/Qwen/kept.params.qwenThinkingFormat": "top-level",
      "models.providers.VLLM.models": [
        { id: "vllm/Qwen/existing", name: "Existing" },
        { id: "Qwen/kept", compat: { thinkingFormat: "qwen-chat-template" } },
        { id: "Qwen/row", params: { qwenThinkingFormat: "chat-template", temperature: 0.2 } },
      ],
    });
    expect(issuePaths(raw)).toEqual(
      expect.arrayContaining(["agents.defaults.models", "models.providers"]),
    );
    const res = migrate(raw);
    expect(res.config?.models?.providers?.vllm).toBeUndefined();
    expect(res.config?.models?.providers?.VLLM?.models).toEqual([
      qwenModel("vllm/Qwen/existing", "qwen-chat-template", { name: "Existing" }),
      qwenModel("Qwen/kept", "qwen-chat-template"),
      qwenModel("Qwen/row", "qwen-chat-template", { params: { temperature: 0.2 } }),
      qwenModel("Qwen/new", "qwen", { name: "Qwen/new" }),
    ]);
    expect(res.config?.agents?.defaults?.models).toEqual({
      "VLLM/Qwen/new@local": {},
      "vllm/Qwen/existing": { params: { temperature: 0.2 } },
      "vllm/Qwen/kept": {},
    });
  });

  it("preserves vLLM target order and cached formats across provider, default, and agent params", () => {
    const mainModel = selection("vllm/Qwen/Qwen3-8B", "vllm/Qwen/Qwen3-14B");
    const workerModel = selection(
      "vllm/Qwen/Qwen3-14B",
      "vllm/Qwen/Qwen3-8B",
      "vllm/Qwen/Qwen3-32B",
    );
    const cachedModel = qwenModel("Qwen/Qwen3-8B", "qwen-chat-template", { reasoning: false });
    const res = migratePaths({
      "agents.defaults.model": mainModel,
      "agents.defaults.params.qwenThinkingFormat": "chat-template",
      "agents.entries.worker.model": workerModel,
      "agents.entries.worker.params.qwen_thinking_format": "invalid",
      "models.providers.vllm.params.qwenThinkingFormat": "enable-thinking",
      "models.providers.vllm.models": [cachedModel, { id: "Qwen/Qwen3-14B" }],
    });

    expect(res.config?.models?.providers?.vllm).toEqual({
      models: [
        cachedModel,
        qwenModel("Qwen/Qwen3-14B", "qwen"),
        qwenModel("Qwen/Qwen3-32B", "qwen", { name: "Qwen/Qwen3-32B" }),
      ],
    });
    expect(res.config?.agents?.defaults).toEqual({ model: mainModel });
    expect(res.config?.agents?.entries?.worker).toEqual({ model: workerModel });
    expect(migrate(res.config)).toEqual({ config: null, changes: [] });
  });

  it("removes untargeted Qwen params from provider, default, and agent scopes", () => {
    const raw = configAt({
      "models.providers.vllm": {
        baseUrl: "http://localhost:8000/v1",
        params: { qwenThinkingFormat: "chat-template", temperature: 0.2 },
      },
      "agents.defaults.params": { qwenThinkingFormat: "chat-template", temperature: 0.3 },
      "agents.list": [
        { id: "local", params: { qwen_thinking_format: "enable_thinking", temperature: 0.4 } },
      ],
    });
    expect(issuePaths(raw)).toEqual(
      expect.arrayContaining(["models.providers.vllm.params", "agents.defaults.params", "agents"]),
    );
    const res = migrate(raw);
    expect(res.config?.models?.providers?.vllm).toEqual({
      baseUrl: "http://localhost:8000/v1",
      params: { temperature: 0.2 },
    });
    expect(res.config?.agents?.defaults?.params).toEqual({ temperature: 0.3 });
    expect(res.config?.agents?.entries?.local).toEqual({ params: { temperature: 0.4 } });
  });
});

describe("legacy memory search config migrate", () => {
  it("merges legacy defaults before normalizing memory search fields", () => {
    const raw = configAt({
      "memorySearch.enabled": true,
      "memorySearch.provider": "auto",
      "memorySearch.model": "text-embedding-3-small",
      "memorySearch.chunkSize": 800,
      "memorySearch.chunkOverlap": 100,
      "memorySearch.maxResults": 5,
      "memorySearch.store.vector.enabled": false,
      "agents.defaults.memorySearch.chunking.tokens": 1200,
      "agents.defaults.memorySearch.query.maxResults": 9,
      "agents.defaults.memorySearch.store.fts.tokenizer": "trigram",
    });
    expect(issuePaths(raw)).toEqual(
      expect.arrayContaining([
        "memorySearch",
        "memorySearch.provider",
        "agents.defaults.memorySearch",
      ]),
    );
    const res = migrate(raw);
    expect(res.config).not.toHaveProperty("memorySearch");
    expect(res.config?.memory?.search).toEqual({
      enabled: true,
      provider: "openai",
      model: "text-embedding-3-small",
      query: { maxResults: 9 },
      store: { fts: { tokenizer: "trigram" }, vector: { enabled: false } },
    });
  });

  it("normalizes per-agent memory search independently and removes empty retired settings", () => {
    const raw = configAt({
      "agents.defaults.memorySearch": {
        provider: "auto",
        chunkSize: 800,
        chunkOverlap: 100,
        maxResults: 5,
      },
      "agents.list": [
        {
          id: "local",
          memorySearch: {
            provider: " auto ",
            chunkSize: 500,
            store: { vector: { enabled: true } },
          },
        },
        {
          id: "custom",
          memorySearch: { provider: "openai-compatible", chunkOverlap: 50, maxResults: 10 },
        },
        { id: "retired", memorySearch: { chunkSize: 500 } },
      ],
    });
    expect(issuePaths(raw)).toEqual(
      expect.arrayContaining(["agents.defaults.memorySearch", "agents", "agents.list"]),
    );
    const res = migrate(raw);
    expect(res.config?.memory?.search).toEqual({ provider: "openai", query: { maxResults: 5 } });
    expect(res.config?.agents?.entries?.local?.memory?.search).toEqual({
      provider: "openai",
      store: { vector: { enabled: true } },
    });
    expect(res.config?.agents?.entries?.custom?.memory?.search).toEqual({
      provider: "openai-compatible",
      query: { maxResults: 10 },
    });
    expect(res.config?.agents?.entries?.retired?.memory?.search).toBeUndefined();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
