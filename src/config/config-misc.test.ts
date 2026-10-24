import { assert, describe, expect, it } from "vitest";
import { modelDefinition } from "../agents/model-auth.fixtures.test-support.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  getConfigValueAtPath,
  parseConfigPath,
  setConfigValueAtPath,
  unsetConfigValueAtPath,
} from "./config-paths.js";
import { readConfigFileSnapshot } from "./config.js";
import { findLegacyConfigIssues } from "./legacy.js";
import { buildWebSearchProviderConfig, withTempHome, writeOpenClawConfig } from "./test-helpers.js";
import { validateConfigObject, validateConfigObjectRaw } from "./validation.js";
import { OpenClawSchema } from "./zod-schema.js";

function issuePaths(issues: Array<{ path: string }>): string[] {
  return issues.map((issue) => issue.path);
}

function expectSomeIssueMessageContains(issues: Array<{ message: string }>, text: string): void {
  expect(issues.map((issue) => issue.message).join("\n")).toContain(text);
}

function invalid(result: ReturnType<typeof validateConfigObjectRaw>) {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected validation to fail");
  }
  return result.issues;
}

const accepts = (config: unknown) => OpenClawSchema.safeParse(config).success;
function validated(config: unknown, raw = false) {
  const result = (raw ? validateConfigObjectRaw : validateConfigObject)(config);
  assert(result.ok);
  return result.config;
}
const pluginEntry = (entry: Record<string, unknown>) => ({
  plugins: { entries: { "voice-call": entry } },
});
const providerConfig = (id: string, provider: unknown, mode?: "merge") => ({
  models: { ...(mode ? { mode } : {}), providers: { [id]: provider } },
});
const providerOverlay = (id: string) => providerConfig(id, { timeoutSeconds: 600 });
async function withSnapshot(
  config: unknown,
  check: (snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>) => void,
) {
  await withTempHome(async (home) => {
    await writeOpenClawConfig(home, config);
    check(await readConfigFileSnapshot());
  });
}

it.each([
  ["root", true, "mcp.servers.example.disabled", "enabled: false"],
  ["root", false, "mcp.servers.example.disabled", "enabled: true"],
  ["node-host", true, "nodeHost.mcp.servers.example.disabled", "enabled: false"],
])(
  'rejects %s MCP server "disabled: %s" with the inverse canonical value',
  (scope, disabled, path, replacement) => {
    const server = { command: "example-mcp", disabled };
    const config =
      scope === "root"
        ? { mcp: { servers: { example: server } } }
        : { nodeHost: { mcp: { servers: { example: server } } } };
    const result = validateConfigObjectRaw(config);

    expect(invalid(result)).toContainEqual(
      expect.objectContaining({ path, message: expect.stringContaining(replacement) }),
    );
  },
);

describe("model provider localService config", () => {
  it("revalidates materialized bundled provider overlays", () => {
    const first = validated(providerOverlay("google"), true);
    expect(first.models?.providers?.google).toMatchObject({ baseUrl: "", models: [] });
    expect(validateConfigObjectRaw(first).ok).toBe(true);
  });

  it("accepts on-demand local provider service settings", () => {
    expect(
      accepts(
        providerConfig("ds4", {
          baseUrl: "http://127.0.0.1:18000/v1",
          api: "openai-completions",
          localService: {
            command: "/Users/me/ds4-server",
            args: ["--port", "18000"],
            cwd: "/Users/me/ds4",
            env: { METAL_DEVICE_WRAPPER_TYPE: "1" },
            healthUrl: "http://127.0.0.1:18000/v1/models",
            readyTimeoutMs: 180_000,
            idleStopMs: 0,
          },
          models: [],
        }),
      ),
    ).toBe(true);
  });

  it("still requires baseUrl and models for custom provider declarations", () => {
    const result = validateConfigObjectRaw(providerOverlay("custom"));

    expect(issuePaths(invalid(result))).toEqual(
      expect.arrayContaining(["models.providers.custom.baseUrl", "models.providers.custom.models"]),
    );
  });
});

it.each([
  [
    "unknown access group membership",
    {
      accessGroups: {
        maintainers: {
          type: "discord.channelAudience",
          guildId: "guild",
          channelId: "channel",
          membership: "roleMember",
        },
      },
    },
  ],
  [
    "non-boolean external embed permission",
    { gateway: { controlUi: { allowExternalEmbedUrls: "yes" } } },
  ],
  ["unsupported embed sandbox", { gateway: { controlUi: { embedSandbox: "yolo" } } }],
  [
    "non-boolean prompt injection",
    pluginEntry({ hooks: { allowPromptInjection: "no", allowConversationAccess: true } }),
  ],
  [
    "non-boolean conversation access",
    pluginEntry({ hooks: { allowPromptInjection: false, allowConversationAccess: "yes" } }),
  ],
  [
    "invalid trusted subagent overrides",
    pluginEntry({ subagent: { allowModelOverride: "yes", allowedModels: [1] } }),
  ],
  [
    "invalid trusted llm overrides",
    pluginEntry({
      llm: {
        allowModelOverride: "yes",
        allowedModels: [1],
        allowedCompletionModels: [1],
        allowAuthProfileOverride: "yes",
        allowAgentIdOverride: "yes",
      },
    }),
  ],
  [
    "unknown cron webhook SSRF policy fields",
    { cron: { webhookSsrfPolicy: { allowEverything: true } } },
  ],
])("rejects %s", (_name, config) => {
  expect(accepts(config)).toBe(false);
});

it.each([
  [0, true],
  [120_000, true],
  [-1, false],
  [1.5, false],
  ["60000", false],
])("validates provider usage cache lifetime %s", (cacheTtlMs, valid) => {
  expect(accepts({ models: { usage: { cacheTtlMs } } })).toBe(valid);
});

describe("models.catalogRefresh", () => {
  const acceptsRefresh = (catalogRefresh: unknown) => accepts({ models: { catalogRefresh } });
  it("accepts the refresh toggle and an http(s) override", () => {
    expect(acceptsRefresh({ enabled: false, url: "https://catalog.example.test/v1.json" })).toBe(
      true,
    );
    expect(acceptsRefresh({ url: "http://localhost:8080/catalog.json" })).toBe(true);
  });

  it("rejects invalid refresh values", () => {
    expect(acceptsRefresh({ enabled: "false" })).toBe(false);
    for (const url of [
      "file:///tmp/catalog.json",
      "not a url",
      "http://catalog.internal.example/catalog.json",
    ]) {
      expect(acceptsRefresh({ url })).toBe(false);
    }
  });
});

describe("mcp.apps.enabled", () => {
  const acceptsApps = (apps: unknown) => accepts({ mcp: { apps } });
  it("accepts only a bare HTTP(S) sandbox origin", () => {
    expect(
      acceptsApps({
        enabled: true,
        sandboxOrigin: "https://mcp-apps.example.com",
        sandboxPort: 29000,
      }),
    ).toBe(true);
    expect(acceptsApps({ sandboxPort: 65536 })).toBe(false);
    for (const sandboxOrigin of [
      "https://mcp-apps.example.com/path",
      "https://mcp-apps.example.com?query=1",
      "https://user:pass@mcp-apps.example.com",
      "data:text/html,hello",
    ]) {
      expect(acceptsApps({ sandboxOrigin })).toBe(false);
    }
  });
});

it("web search provider config: accepts kimi provider and config", () => {
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

it("gateway.remote.transport: rejects invalid macOS SSH host-key policy", () => {
  const res = validateConfigObject({
    gateway: { remote: { sshHostKeyPolicy: "accept-new", transport: "ssh" } },
  });
  expect(invalid(res)[0]?.path).toBe("gateway.remote.sshHostKeyPolicy");
});

describe("gateway.remote.edgeAuth", () => {
  const validateHeaders = (edgeAuth: unknown) =>
    validateConfigObjectRaw({ gateway: { remote: { edgeAuth } } });
  it("accepts valid header names with literal and SecretRef values", () => {
    const res = validateHeaders({
      "X-Edge-Literal": "test-secret",
      "X-Edge-Ref": { source: "env", provider: "default", id: "EDGE_AUTH_TOKEN" },
    });

    expect(res.ok).toBe(true);
  });

  it.each([
    ["empty map", {}, "header map must not be empty"],
    ["transport-owned header", { Host: "test-secret" }, 'transport-owned header "Host"'],
    [
      "invalid header name",
      { "Bad Header": "test-secret" },
      'invalid gateway.remote.edgeAuth header name: "Bad Header"',
    ],
    [
      "case-duplicate headers",
      { "X-Edge-Auth": "one", "x-edge-auth": "two" },
      'header names "X-Edge-Auth" and "x-edge-auth" differ only by case',
    ],
  ] as const)("rejects %s", (_name, edgeAuth, expected) => {
    expectSomeIssueMessageContains(invalid(validateHeaders(edgeAuth)), expected);
  });
});

describe("config identity/materialization regressions", () => {
  it("preserves empty responsePrefix when identity is present", () => {
    const config = validated({
      agents: {
        entries: { main: { identity: { name: "Samantha", theme: "helpful sloth", emoji: "🦥" } } },
      },
      channels: { whatsapp: { responsePrefix: "" } },
    });
    expect(config.channels?.whatsapp?.responsePrefix).toBe("");
  });

  it("accepts blank model provider apiKey values", () => {
    const config = validated(
      providerConfig(
        "minimax",
        {
          baseUrl: "https://api.minimax.io/anthropic",
          apiKey: "",
          api: "anthropic-messages",
          models: [modelDefinition("MiniMax-M2.7")],
        },
        "merge",
      ),
      true,
    );
    expect(config.models?.providers?.minimax).toMatchObject({
      baseUrl: "https://api.minimax.io/anthropic",
      apiKey: "",
    });
  });
});

describe("broadcast", () => {
  it.each([
    {
      name: "legacy array without a new participant cap",
      key: "+15551234567",
      entry: Array.from({ length: 17 }, () => "alfred"),
    },
    { name: "qualified peer array", key: "telegram:-100123", entry: ["alfred", "baerbel"] },
    {
      name: "qualified object at upper bounds",
      key: "slack:C0123",
      entry: {
        agents: Array.from({ length: 16 }, () => "alfred"),
        mentionGating: false,
        maxRounds: 4,
        maxTurns: 32,
      },
    },
  ])("accepts $name", ({ key, entry }) => {
    const res = validateConfigObject({
      agents: { ownership: "explicit", entries: { alfred: {}, baerbel: {} } },
      broadcast: { strategy: "parallel", [key]: entry },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects invalid broadcast strategy", () => {
    const res = validateConfigObject({
      broadcast: { strategy: "nope" },
    });
    expect(res.ok).toBe(false);
  });

  it.each([
    { name: "non-array entry", key: "1203@g.us", entry: 123 },
    { name: "unqualified object", key: "1203@g.us", entry: { agents: ["alfred"] } },
    {
      name: "too many qualified array participants",
      key: "telegram:-100123",
      entry: Array.from({ length: 17 }, () => "alfred"),
    },
    ...[0, 5, 1.5].map((maxRounds) => ({
      name: `invalid rounds ${maxRounds}`,
      key: "telegram:-100123",
      entry: { agents: ["alfred"], maxRounds },
    })),
  ])("rejects $name", ({ key, entry }) => {
    const res = validateConfigObject({
      agents: { entries: { alfred: {} } },
      broadcast: { [key]: entry },
    });
    expect(res.ok).toBe(false);
  });

  it.each([
    { entry: ["alfred", "missing"], path: "broadcast.telegram:-100123.1" },
    { entry: { agents: ["alfred", "missing"] }, path: "broadcast.telegram:-100123.agents.1" },
  ])("rejects unknown participant IDs at $path", ({ entry, path }) => {
    const res = validateConfigObject({
      agents: { entries: { alfred: {} } },
      broadcast: { "telegram:-100123": entry },
    });
    expect(invalid(res)).toContainEqual({
      path,
      message: 'Unknown agent id "missing" (not in agents.entries).',
    });
  });

  it.each([
    { entry: ["missing"], path: "broadcast.telegram:-100123.0" },
    { entry: { agents: ["missing"] }, path: "broadcast.telegram:-100123.agents.0" },
  ])("validates qualified participants without a configured roster at $path", ({ entry, path }) => {
    const res = validateConfigObjectRaw({ broadcast: { "telegram:-100123": entry } });
    expect(issuePaths(invalid(res))).toContain(path);
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
    if (!parsed.ok) {
      throw new Error("path parse failed");
    }
    setConfigValueAtPath(root, parsed.path, 123);
    expect(getConfigValueAtPath(root, parsed.path)).toBe(123);
    expect(unsetConfigValueAtPath(root, parsed.path)).toBe(true);
    expect(getConfigValueAtPath(root, parsed.path)).toBeUndefined();
  });
});

describe("config strict validation", () => {
  it("accepts documented agents.entries.<id>.params overrides", () => {
    const params = { cacheRetention: "none", temperature: 0.4, maxTokens: 8192 };
    const config = validated({
      agents: {
        entries: { main: { model: "anthropic/claude-opus-4-6", params: { ...params } } },
      },
    });

    expect(config.agents?.entries?.main?.params).toEqual(params);
  });

  it("rejects top-level memorySearch without read-time auto-migration", async () => {
    const memorySearch = { provider: "local", fallback: "none", query: { maxResults: 7 } };
    await withSnapshot({ memorySearch }, (snap) => {
      expect(snap.valid).toBe(false);
      expectSomeIssueMessageContains(snap.issues, '"memorySearch"');
      expect(issuePaths(snap.legacyIssues)).toContain("memorySearch");
      expect((snap.sourceConfig as { memorySearch?: unknown }).memorySearch).toEqual(memorySearch);
      expect(snap.sourceConfig.memory?.search).toBeUndefined();
    });
  });

  it("rejects top-level heartbeat agent settings without read-time auto-migration", async () => {
    const heartbeat = { every: "30m", model: "anthropic/claude-3-5-haiku-20241022" };
    await withSnapshot({ heartbeat }, (snap) => {
      expect(snap.valid).toBe(false);
      expectSomeIssueMessageContains(snap.issues, '"heartbeat"');
      expect(issuePaths(snap.legacyIssues)).not.toContain("heartbeat");
      expect((snap.sourceConfig as { heartbeat?: unknown }).heartbeat).toEqual(heartbeat);
      expect(snap.sourceConfig.agents?.defaults?.heartbeat).toBeUndefined();
    });
  });

  it("reports legacy tts provider keys without read-time auto-migration", () => {
    const elevenlabs = { apiKey: "test-key", voiceId: "voice-1" };
    const raw = {
      tts: { provider: "elevenlabs", elevenlabs: { ...elevenlabs } },
    };
    const issues = findLegacyConfigIssues(raw);

    expect(issuePaths(issues)).toContain("tts");
    expect(raw.tts.elevenlabs).toEqual(elevenlabs);
    expect(raw.tts).not.toHaveProperty("providers");
  });

  it.each([
    { summaryModel: "anthropic/claude-opus-4-5", expectedPaths: [] },
    { summaryModel: " anthropic/claude-opus-4-5 ", expectedPaths: ["plugins"] },
  ])(
    "reports only noncanonical plugin model refs without agents: '$summaryModel'",
    ({ summaryModel, expectedPaths }) => {
      const raw = {
        plugins: {
          entries: {
            "lossless-claw": { config: { summaryModel } },
          },
        },
      };
      const issues = findLegacyConfigIssues(raw);

      expect(issuePaths(issues)).toEqual(expectedPaths);
      expect(raw.plugins.entries["lossless-claw"].config.summaryModel).toBe(summaryModel);
      expect(raw).not.toHaveProperty("agents");
    },
  );

  it("rejects legacy sandbox perSession without read-time auto-migration", async () => {
    await withSnapshot(
      {
        agents: {
          defaults: { sandbox: { perSession: true } },
          entries: { openclaw: { sandbox: { perSession: false } } },
        },
      },
      (snap) => {
        expect(snap.valid).toBe(false);
        expect(issuePaths(snap.issues)).toContain("agents.defaults.sandbox");
        expect(issuePaths(snap.issues)).toContain("agents.entries.openclaw.sandbox");
        expect(issuePaths(snap.legacyIssues)).not.toContain("agents.defaults.sandbox");
        expect(snap.sourceConfigBeforeMigrations?.agents?.defaults?.sandbox).toEqual({
          perSession: true,
        });
        expect(snap.sourceConfigBeforeMigrations?.agents?.entries?.openclaw?.sandbox).toEqual({
          perSession: false,
        });
        expect(snap.sourceConfig.agents?.entries?.openclaw?.sandbox).toEqual({ perSession: false });
      },
    );
  });

  it("rejects resolved-only gateway.bind aliases as invalid schema values, not legacy", async () => {
    await withEnvAsync({ OPENCLAW_BIND: "0.0.0.0" }, () =>
      withSnapshot({ gateway: { bind: "${OPENCLAW_BIND}" } }, (snap) => {
        expect(snap.valid).toBe(false);
        expect(snap.legacyIssues).toHaveLength(0);
        expect(issuePaths(snap.issues)).toContain("gateway.bind");
      }),
    );
  });

  it("rejects literal gateway.bind host aliases as legacy", async () => {
    await withSnapshot({ gateway: { bind: "0.0.0.0" } }, (snap) => {
      expect(snap.valid).toBe(false);
      expect(issuePaths(snap.issues)).toContain("gateway.bind");
      expect(issuePaths(snap.legacyIssues)).toContain("gateway.bind");
    });
  });
});
