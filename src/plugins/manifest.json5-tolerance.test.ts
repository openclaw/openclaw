import fs from "node:fs";
import path from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveMemorySlotDecision } from "./config-state.js";
import { loadPluginManifest } from "./manifest.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";

const roots = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    clearPluginMetadataLifecycleCaches();
    cleanup();
  }),
);
beforeEach(clearPluginMetadataLifecycleCaches);

function load(
  content: Record<string, unknown> | string,
  rejectHardlinks = true,
  coldRuntime = false,
) {
  const root = roots.make("manifest-metadata-");
  if (!coldRuntime && process.platform !== "win32") {
    fs.chmodSync(root, 0o755);
  }
  if (coldRuntime) {
    fs.writeFileSync(path.join(root, "index.js"), "throw new Error('runtime must stay cold');");
  }
  fs.writeFileSync(
    path.join(root, "openclaw.plugin.json"),
    typeof content === "string"
      ? content
      : JSON.stringify({ id: "test-plugin", configSchema: { type: "object" }, ...content }),
  );
  const result = loadPluginManifest(root, rejectHardlinks);
  assert(result.ok);
  return result.manifest;
}
const parseManifest = (content: Record<string, unknown> | string) => load(content, false);
const loadModels = (fields: Record<string, unknown>) =>
  load({ id: "fixture", contracts: { decisionProviders: ["fixture"] }, ...fields }, true, true);
const decision = (id: string, name: string, fields: Record<string, unknown> = {}) => ({
  provider: "fixture",
  id,
  name,
  ...fields,
});
const cli = { id: "anthropic", providers: ["anthropic"], cliBackends: ["claude-cli"] };

describe("loadPluginManifest JSON5 tolerance", () => {
  it.each([
    {
      ids: ["canonical-engine", " other-engine ", "canonical-engine"],
      kind: "context-engine",
      expected: ["canonical-engine", "other-engine"],
    },
    { ids: [], kind: "context-engine" },
    { ids: ["legacy"], kind: "context-engine" },
    { ids: ["none"], kind: "context-engine" },
    { ids: [42], kind: "context-engine" },
    { ids: [""], kind: "context-engine" },
    { ids: "canonical-engine", kind: "context-engine" },
    { ids: ["canonical-engine"], kind: "memory" },
  ])("validates manifest engine ownership: $ids / $kind", ({ ids, kind, expected }) => {
    const dir = roots.make("openclaw-manifest-json5-");
    fs.writeFileSync(
      path.join(dir, "openclaw.plugin.json"),
      JSON.stringify({ id: "vendor-plugin", kind, contextEngineIds: ids, configSchema: {} }),
      "utf-8",
    );
    const result = loadPluginManifest(dir, false);
    expect(result.ok).toBe(Boolean(expected));
    if (result.ok) {
      expect(result.manifest.contextEngineIds).toEqual(expected);
    }
  });

  it("normalizes static doctor session route-state owners", () => {
    const manifest = parseManifest({
      sessionRouteStateOwners: [
        {
          id: " demo ",
          label: " Demo owner ",
          providerIds: [" demo ", "", "demo"],
        },
        { id: "blank-list", label: "Blank list", runtimeIds: [" "] },
        { id: " ", label: "Missing id" },
        null,
      ],
    });

    expect(manifest.sessionRouteStateOwners).toEqual([
      {
        id: "demo",
        label: "Demo owner",
        providerIds: ["demo", "demo"],
        runtimeIds: [],
        cliSessionKeys: [],
        authProfilePrefixes: [],
      },
    ]);
  });

  it.each([
    ["memory", "memory"],
    [
      ["context-engine", "memory"],
      ["context-engine", "memory"],
    ],
    [
      ["memory", "unknown-kind", 42, "memory", "context-engine", null],
      ["memory", "context-engine"],
    ],
    ["unknown-kind", undefined],
    [["unknown-kind", 42, null], undefined],
  ])("normalizes kind %j to %j", (kind, expected) => {
    expect(parseManifest({ kind }).kind).toEqual(expected);
  });

  it("keeps duplicate memory declarations subject to the exclusive memory slot", () => {
    const manifest = parseManifest({
      id: "duplicate-memory",
      kind: ["memory", "memory"],
    });

    expect(manifest.kind).toBe("memory");
    expect(
      resolveMemorySlotDecision({
        id: manifest.id,
        kind: manifest.kind,
        slot: "memory-core",
        selectedId: "memory-core",
      }),
    ).toEqual({ enabled: false, reason: 'memory slot set to "memory-core"' });
  });

  it("retains static MCP server declarations", () => {
    const server = { transport: "stdio", command: "node", args: ["./mcp-server.js"] };
    const manifest = parseManifest({
      mcpServers: {
        app: server,
        invalid: "./not-a-server.json",
      },
    });

    expect(manifest.mcpServers).toEqual({ app: server });
  });

  it("normalizes activation and setup descriptor metadata from the manifest", () => {
    const manifest = parseManifest(`{
  id: "openai",
  activation: {
    onStartup: false,
    onProviders: ["openai", "", "openai"],
    onCommands: ["models", ""],
    onChannels: ["web", ""],
    onRoutes: ["gateway-webhook", ""],
    onConfigPaths: ["browser", ""],
    onCapabilities: ["provider", "tool", "wat"]
  },
  cliCommands: [
    { name: "models", description: "Inspect provider models", hasSubcommands: true },
    { name: "bad command", description: "ignored", hasSubcommands: false },
    { name: "models", description: "duplicate", hasSubcommands: false }
  ],
  setup: {
    providers: [
      { id: "openai", authMethods: ["api-key", ""], envVars: ["OPENAI_API_KEY", ""] },
      { id: "", authMethods: ["oauth"] }
    ],
    cliBackends: ["openai-cli", ""],
    configMigrations: ["legacy-openai-auth", ""],
    requiresRuntime: false
  },
  configSchema: { type: "object" }
}`);
    expect(manifest.activation).toEqual({
      onStartup: false,
      onProviders: ["openai", "openai"],
      onCommands: ["models"],
      onChannels: ["web"],
      onRoutes: ["gateway-webhook"],
      onConfigPaths: ["browser"],
      onCapabilities: ["provider", "tool"],
    });
    expect(manifest.cliCommands).toEqual([
      {
        name: "models",
        description: "Inspect provider models",
        hasSubcommands: true,
      },
    ]);
    expect(manifest.setup).toEqual({
      providers: [
        {
          id: "openai",
          authMethods: ["api-key"],
          envVars: ["OPENAI_API_KEY"],
        },
      ],
      cliBackends: ["openai-cli"],
      configMigrations: ["legacy-openai-auth"],
      requiresRuntime: false,
    });
  });
});

describe("plugin manifest model catalog", () => {
  it.each([true, false])("loads models.dev opt-in only with provider ownership: %s", (owned) => {
    const manifest = load({
      id: "example-plugin",
      providers: owned ? [" Example "] : [],
      modelCatalog: { modelsDev: { " EXAMPLE ": " upstream-id ", other: "other-source" } },
    });
    expect(manifest.modelCatalog).toEqual(
      owned ? { modelsDev: { example: "upstream-id" } } : undefined,
    );
  });

  it("allows cli backends to own manifest model catalog rows", () => {
    const modelCatalog = {
      providers: { "claude-cli": { models: [{ id: "claude-sonnet-4-6" }] } },
      discovery: { "claude-cli": "static" },
    };
    expect(load({ ...cli, modelCatalog }).modelCatalog).toEqual(modelCatalog);
  });

  it("allows cli backends to own pricing policy", () => {
    const manifest = load({
      ...cli,
      modelPricing: {
        providers: {
          "claude-cli": { priceAs: " Anthropic " },
          unowned: { priceAs: "anthropic" },
        },
      },
    });
    expect(manifest.modelPricing?.providers).toEqual({
      "claude-cli": { priceAs: "anthropic" },
    });
  });

  it("normalizes owned request policies at the manifest boundary", () => {
    const manifest = load({
      id: "example-plugin",
      providers: [" Demo ", "bad"],
      providerRequest: {
        providers: {
          " DEMO ": {
            family: " demo-family ",
            compatibilityFamily: " moonshot ",
            openAICompletions: { supportsStreamingUsage: true },
          },
          unowned: { family: "ignored-family" },
          bad: [],
        },
      },
    });
    expect(manifest.providerRequest).toEqual({
      providers: {
        demo: {
          family: "demo-family",
          compatibilityFamily: "moonshot",
          openAICompletions: { supportsStreamingUsage: true },
        },
      },
    });
  });
});

it("discovers only decision models owned by the manifest without executing its runtime", () => {
  const capabilities = {
    questionTypes: ["boolean", "choice", "score"],
    maxQuestions: 32,
    maxChoiceAlternatives: 64,
    maxScoreLevels: 64,
    maxInputTokens: 512,
    inputTokenScope: "encoded-question",
    requiresBooleanCriteria: true,
    confidence: "none",
  };
  const manifest = loadModels({
    decisionModels: [
      decision(" fast ", " Fast decisions ", { provider: " fixture ", capabilities }),
      decision("fast", "Duplicate"),
      decision("foreign", "Unowned", { provider: "other" }),
      { provider: "fixture", id: "missing-name" },
    ],
  });
  expect(manifest.decisionModels).toEqual([decision("fast", "Fast decisions", { capabilities })]);
  expect(manifest.providers ?? []).toEqual([]);
  expect(manifest.modelCatalog?.providers?.fixture?.models).toEqual([
    {
      id: "fast",
      name: "Fast decisions",
      inference: {
        chat: false,
        decision: {
          protocol: "decision-v1",
          input: ["text"],
          questions: {
            boolean: { probabilities: "boolean", abstention: false, requiresCriteria: true },
            choice: { probabilities: "provider-defined", abstention: false, maxOptions: 64 },
            score: { probabilities: "provider-defined", abstention: false, maxOptions: 64 },
          },
          confidence: "none",
          limits: { maxQuestions: 32, maxInputTokens: 512, inputTokenScope: "encoded-question" },
        },
      },
    },
  ]);
});

it("bounds provider metadata before discovery can expose it to tool diagnostics", () => {
  const manifest = loadModels({
    decisionModels: [
      decision("bounded", "Bounded", {
        capabilities: {
          questionTypes: ["boolean", "boolean"],
          maxQuestions: -1,
          maxChoiceAlternatives: 1.5,
          maxScoreLevels: Number.MAX_SAFE_INTEGER + 1,
          maxInputTokens: "private-provider-diagnostic",
          confidence: "private-provider-diagnostic",
          inputTokenScope: "private-provider-diagnostic",
          requiresBooleanCriteria: "true",
        },
      }),
      decision("invalid", "Invalid", {
        capabilities: { questionTypes: ["private-provider-diagnostic"] },
      }),
    ],
  });
  expect(manifest.decisionModels).toEqual([
    decision("bounded", "Bounded", { capabilities: { questionTypes: ["boolean"] } }),
    decision("invalid", "Invalid"),
  ]);
});

it("keeps explicit canonical identities authoritative over V1 input, including rejected rows", () => {
  const native = {
    id: "native",
    name: "Native",
    inference: { chat: false, decision: { protocol: "native", input: ["image"] } },
  };
  const manifest = loadModels({
    modelCatalog: {
      providers: {
        fixture: {
          models: [
            native,
            {
              id: "rejected",
              name: "Rejected",
              inference: { decision: { protocol: "invalid", input: ["unrecognized"] } },
            },
          ],
        },
      },
    },
    decisionModels: [
      decision("native", "Legacy duplicate"),
      decision("rejected", "Must not resurrect"),
    ],
  });
  expect(manifest.modelCatalog?.providers?.fixture?.models).toEqual([native]);
});
