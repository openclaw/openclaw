import { beforeEach, expect, it, vi } from "vitest";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import type { createOpenClawCodingToolsInternal } from "./agent-tools.js";
import { resolveEffectiveToolInventory } from "./tools-effective-inventory.js";
import type { AnyAgentTool } from "./tools/common.js";

function makeTool(
  name: string,
  options: {
    label?: string;
    description?: string;
    displaySummary?: string;
    parameters?: unknown;
    pluginMeta?: Parameters<typeof setPluginToolMeta>[1];
  } = {},
): AnyAgentTool {
  const { pluginMeta, ...toolParams } = options;
  const tool = {
    name,
    label: name,
    description: name,
    ...toolParams,
    parameters: Object.hasOwn(options, "parameters")
      ? options.parameters
      : { type: "object", properties: {} },
    execute: async () => ({ text: name }),
  } as unknown as AnyAgentTool;
  if (pluginMeta) {
    setPluginToolMeta(tool, pluginMeta);
  }
  return tool;
}

const execTool = () => makeTool("exec");

function pluginTool(name: string, pluginId: string, options: Parameters<typeof makeTool>[1] = {}) {
  return makeTool(name, { ...options, pluginMeta: { pluginId, optional: false } });
}
async function loadExecHarness() {
  await loadHarness({ tools: [execTool()] });
}
const providerConfig = (provider: string, config: object) => ({
  models: { providers: { [provider]: config } },
});
const configuredRow = (id: string, name: string, contextWindow: number) => ({
  id,
  name,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow,
  maxTokens: 8_192,
});

function expectNormalizedModel(api: string, model: Record<string, unknown>) {
  expect(effectiveInventoryState.normalizeToolsMock).toHaveBeenCalledWith(
    expect.objectContaining({ modelApi: api, model: expect.objectContaining(model) }),
  );
}

const effectiveInventoryState = vi.hoisted(() => ({
  tools: [] as AnyAgentTool[],
  channelMeta: {} as Record<string, { channelId: string } | undefined>,
  normalizeToolsMock: vi.fn((options: { tools: AnyAgentTool[] }) => options.tools),
  staticCatalogModelMock: vi.fn((_options: unknown) => undefined as unknown),
  normalizeTransportMock: vi.fn((_options: unknown) => undefined as unknown),
  createToolsMock: vi.fn<typeof createOpenClawCodingToolsInternal>(),
}));

vi.mock("./agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("./agent-scope.js")>("./agent-scope.js");
  return {
    ...actual,
    resolveSessionAgentId: () => "main",
    resolveAgentWorkspaceDir: () => "/tmp/workspace-main",
    resolveAgentDir: () => "/tmp/agents/main/agent",
  };
});

// mock-isolation: Project fixture inventories without constructing the agent tool runtime.
vi.mock("./agent-tools.js", () => ({
  createOpenClawCodingToolsInternalAsync: async (
    options?: Parameters<typeof createOpenClawCodingToolsInternal>[0],
  ) => effectiveInventoryState.createToolsMock(options),
}));

// mock-isolation: Inventory metadata fixtures require storage-free tool construction for synthetic agent paths.
vi.mock("./auth-profiles/source-check.js", () => ({
  hasAnyAuthProfileStoreSourceAsync: async () => false,
}));

vi.mock("./channel-tools.js", () => ({
  getChannelAgentToolMeta: (tool: { name: string }) =>
    effectiveInventoryState.channelMeta[tool.name],
}));

vi.mock("./embedded-agent-runner/tool-schema-runtime.js", () => ({
  normalizeProviderToolSchemas: (options: { tools: AnyAgentTool[] }) =>
    effectiveInventoryState.normalizeToolsMock(options),
  logProviderToolSchemaDiagnostics: vi.fn(),
}));

vi.mock("./embedded-agent-runner/model.static-catalog.js", () => ({
  resolveBundledStaticCatalogModel: (options: unknown) =>
    effectiveInventoryState.staticCatalogModelMock(options),
}));

vi.mock("./embedded-agent-runner/model.js", () => ({
  resolveModelAsync: vi.fn(),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  normalizeProviderTransportWithPlugin: (options: unknown) =>
    effectiveInventoryState.normalizeTransportMock(options),
}));

async function loadHarness(options?: {
  tools?: AnyAgentTool[];
  channelMeta?: Record<string, { channelId: string } | undefined>;
  normalizeToolsMock?: typeof effectiveInventoryState.normalizeToolsMock;
}) {
  effectiveInventoryState.tools = options?.tools ?? [execTool()];
  effectiveInventoryState.channelMeta = options?.channelMeta ?? {};
  effectiveInventoryState.normalizeToolsMock =
    options?.normalizeToolsMock ?? vi.fn((normalizeOptions) => normalizeOptions.tools);
  effectiveInventoryState.staticCatalogModelMock = vi.fn((_options: unknown) => undefined);
  effectiveInventoryState.normalizeTransportMock = vi.fn((_options: unknown) => undefined);
  effectiveInventoryState.createToolsMock = vi.fn<typeof createOpenClawCodingToolsInternal>(
    (_options) => effectiveInventoryState.tools,
  );
}

async function inventoryFor(options: Parameters<typeof loadHarness>[0]) {
  await loadHarness(options);
  return resolveEffectiveToolInventory({ cfg: {} });
}

beforeEach(async () => {
  await loadHarness();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

it("groups core, plugin, channel, and MCP tools from the effective runtime set", async () => {
  const result = await inventoryFor({
    tools: [
      execTool(),
      pluginTool("lookup", "docs"),
      makeTool("actions"),
      pluginTool("probe__tool", "bundle-mcp"),
    ],
    channelMeta: { actions: { channelId: "telegram" } },
  });

  expect(result).toMatchObject({ agentId: "main", profile: "full" });
  expect(result.groups.map(({ id, tools }) => [id, tools.map((tool) => tool.id)])).toEqual([
    ["core", ["exec"]],
    ["plugin", ["lookup"]],
    ["channel", ["actions"]],
    ["mcp", ["probe__tool"]],
  ]);
  expect(result.groups[1]?.tools[0]).toMatchObject({ pluginId: "docs", source: "plugin" });
  expect(result.groups[2]?.tools[0]).toMatchObject({ channelId: "telegram", source: "channel" });
  expect(result.groups[3]?.tools[0]).toMatchObject({ pluginId: "bundle-mcp", source: "mcp" });
});

it("disambiguates duplicate labels with source ids", async () => {
  const result = await inventoryFor({
    tools: [
      pluginTool("docs_lookup", "docs", { label: "Lookup" }),
      pluginTool("jira_lookup", "jira", { label: "Lookup" }),
    ],
  });
  const labels = result.groups.flatMap((group) => group.tools.map((tool) => tool.label));

  expect(labels).toEqual(["Lookup (docs)", "Lookup (jira)"]);
});

it("projects plugin metadata published during provider normalization", async () => {
  const registry = createEmptyPluginRegistry();
  registry.toolMetadata = [
    {
      pluginId: "docs",
      pluginName: "Docs",
      source: "fixture",
      metadata: {
        toolName: "docs_lookup",
        displayName: "Docs Search",
        description: "Curated docs lookup.",
        risk: "low",
        tags: ["docs", "fixture"],
      },
    },
    {
      pluginId: "spoofing-plugin",
      pluginName: "Spoofing Plugin",
      source: "fixture",
      metadata: {
        toolName: "docs_lookup",
        displayName: "Spoofed Docs Search",
        risk: "high",
      },
    },
  ];
  const result = await inventoryFor({
    normalizeToolsMock: vi.fn((options) => {
      setActivePluginRegistry(registry);
      return options.tools;
    }),
    tools: [pluginTool("docs_lookup", "docs")],
  });

  expect(result.groups[0]?.tools[0]).toMatchObject({
    id: "docs_lookup",
    label: "Docs Search",
    description: "Curated docs lookup.",
    rawDescription: "Curated docs lookup.",
    pluginId: "docs",
    risk: "low",
    tags: ["docs", "fixture"],
  });
});

it.each([
  {
    name: "unprojectable dynamic references",
    parameters: { type: "object", properties: { target: { $dynamicRef: "#target" } } },
    reason: "fuzzplugin_move_angles.parameters.properties.target.$dynamicRef",
  },
  {
    name: "non-object root schemas before normalization",
    parameters: { type: "array", items: { type: "number" } },
    reason: 'fuzzplugin_move_angles.parameters.type must be "object"',
  },
])("quarantines $name while preserving plugin ownership", async ({ parameters, reason }) => {
  const result = await inventoryFor({
    tools: [execTool(), pluginTool("fuzzplugin_move_angles", "fuzzplugin", { parameters })],
  });

  expect(result.groups.flatMap((group) => group.tools.map((tool) => tool.id))).toEqual(["exec"]);
  expect(result.notices).toMatchObject([
    { id: "unsupported-tool-schema:fuzzplugin_move_angles", severity: "warning" },
  ]);
  expect(result.notices?.[0]?.message).toContain(
    `from plugin "fuzzplugin" has an unsupported runtime input schema (${reason})`,
  );
});

it("reports unreadable inventory tool entries without crashing", async () => {
  const healthy = execTool();
  const tools = new Proxy([healthy] as AnyAgentTool[], {
    get(target, property, receiver) {
      if (property === "0") {
        throw new Error("fuzzplugin inventory entry getter exploded");
      }
      if (property === "1") {
        return healthy;
      }
      if (property === "length") {
        return 2;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const result = await inventoryFor({ tools });
  expect(result.groups.flatMap((group) => group.tools.map((tool) => tool.id))).toEqual(["exec"]);
  expect(result.notices).toMatchObject([
    {
      id: "unsupported-tool-schema:tool[0]",
      severity: "warning",
      message: expect.stringContaining("tool[0] is unreadable"),
    },
  ]);
});

it("applies provider transport normalization to bundled static model context", async () => {
  await loadExecHarness();
  effectiveInventoryState.staticCatalogModelMock.mockReturnValue({
    id: "gpt-test",
    name: "GPT Test",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  });
  effectiveInventoryState.normalizeTransportMock.mockReturnValue({
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  });

  await resolveEffectiveToolInventory({
    cfg: providerConfig("openai", {
      api: "openai-completions",
      baseUrl: "https://proxy.example.com/v1",
    }) as never,
    modelProvider: "openai",
    modelId: "gpt-test",
  });

  expectNormalizedModel("openai-responses", {
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  });
});

it.each([
  {
    provider: "openai",
    id: "gpt-5.5-codex",
    name: "GPT-5.5 Codex",
    contextWindow: 128_000,
    api: "openai-chatgpt-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    bundled: false,
  },
  {
    provider: "github-copilot",
    id: "claude-sonnet-test",
    name: "Configured Claude Sonnet",
    contextWindow: 200_000,
    api: "anthropic-messages",
    baseUrl: "https://api.githubcopilot.com",
    bundled: true,
  },
])(
  "normalizes an API-less $provider model row",
  async ({ provider, id, name, contextWindow, api, baseUrl, bundled }) => {
    await loadExecHarness();
    if (bundled) {
      effectiveInventoryState.staticCatalogModelMock.mockReturnValue({
        id,
        name: "Bundled Claude Sonnet",
        provider,
        api,
        baseUrl,
      });
    } else {
      effectiveInventoryState.normalizeTransportMock.mockReturnValue({ api, baseUrl });
    }
    await resolveEffectiveToolInventory({
      cfg: providerConfig(provider, {
        models: [
          {
            ...configuredRow(id, name, contextWindow),
            ...(!bundled ? { input: ["text"] } : {}),
          },
        ],
      }) as never,
      modelProvider: provider,
      modelId: id,
    });
    expectNormalizedModel(api, { api, baseUrl, ...(bundled ? { name } : {}) });
  },
);

it("uses prepared model context before quarantining runtime-normalized tools", async () => {
  const normalizeToolsMock = vi.fn((options: { tools: AnyAgentTool[]; modelApi?: string }) =>
    options.tools.map((entry) =>
      entry.name === "parameter_free" && options.modelApi === "openai-responses"
        ? ({
            ...entry,
            parameters: {
              type: "object",
              properties: {},
              required: [],
              additionalProperties: false,
            },
          } as AnyAgentTool)
        : entry,
    ),
  );
  await loadHarness({
    tools: [pluginTool("parameter_free", "normalized-plugin", { parameters: undefined })],
    normalizeToolsMock,
  });
  const runtimeModel: ProviderRuntimeModel = {
    id: "chat-latest",
    name: "chat-latest",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };

  const result = await resolveEffectiveToolInventory({
    cfg: {},
    modelProvider: "openai",
    modelId: "chat-latest",
    modelApi: runtimeModel.api,
    runtimeModel,
  });

  expect(result.groups[0]?.tools[0]).toMatchObject({
    id: "parameter_free",
    source: "plugin",
    pluginId: "normalized-plugin",
  });
  expect(result.notices).toBeUndefined();
});

it("prefers displaySummary over raw description", async () => {
  const result = await inventoryFor({
    tools: [
      makeTool("cron", {
        description: "Long raw description\n\nACTIONS:\n- status",
        displaySummary: "Schedule and manage cron jobs.",
      }),
    ],
  });

  expect(result.groups[0]?.tools[0]).toEqual({
    id: "cron",
    label: "cron",
    description: "Schedule and manage cron jobs.",
    rawDescription: "Long raw description\n\nACTIONS:\n- status",
    source: "core",
  });
});

it("falls back to a sanitized summary for multi-line raw descriptions", async () => {
  const result = await inventoryFor({
    tools: [
      makeTool("cron", {
        description:
          "Manage Gateway cron jobs. Use this for reminders and scheduled follow-ups that should execute at the requested time, including recurring tasks.\n\nACTIONS:\n- status",
      }),
    ],
  });

  const description = result.groups[0]?.tools[0]?.description ?? "";
  expect(description).toContain("Manage Gateway cron jobs.");
  expect(description).toContain("Use this for reminders");
  expect(description.endsWith("...")).toBe(true);
  expect(description.length).toBeLessThanOrEqual(120);
  expect(result.groups[0]?.tools[0]?.rawDescription).toContain("ACTIONS:");
});

it("includes the resolved tool profile", async () => {
  await loadExecHarness();

  const result = await resolveEffectiveToolInventory({
    cfg: { tools: { profile: "minimal", byProvider: { openai: { profile: "coding" } } } },
    modelProvider: "openai",
  });
  expect(result.profile).toBe("coding");
});

it("adds an actionable notice when configured browser is filtered by the tool profile", async () => {
  await loadHarness({
    tools: [makeTool("web_fetch")],
  });

  const result = await resolveEffectiveToolInventory({
    cfg: {
      tools: { profile: "coding" },
      browser: { enabled: true },
      plugins: { entries: { browser: { enabled: true } } },
    } as never,
  });

  expect(result.notices).toMatchObject([
    {
      id: "browser-filtered-by-profile",
      severity: "info",
      message: expect.stringContaining('tools.alsoAllow: ["browser"]'),
    },
  ]);
});
