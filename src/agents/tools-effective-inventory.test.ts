import { beforeEach, expect, it, vi } from "vitest";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import type { createOpenClawCodingToolsInternal } from "./agent-tools.js";
import { resolveEffectiveToolInventory } from "./tools-effective-inventory.js";
import type { AnyAgentTool } from "./tools/common.js";

function mockTool(params: {
  name: string;
  label: string;
  description: string;
  displaySummary?: string;
  parameters?: unknown;
  pluginMeta?: Parameters<typeof setPluginToolMeta>[1];
}): AnyAgentTool {
  const { pluginMeta, ...toolParams } = params;
  const tool = {
    ...toolParams,
    parameters: Object.hasOwn(params, "parameters")
      ? params.parameters
      : { type: "object", properties: {} },
    execute: async () => ({ text: params.description }),
  } as unknown as AnyAgentTool;
  if (pluginMeta) {
    setPluginToolMeta(tool, pluginMeta);
  }
  return tool;
}

function expectedTool(id: string, label: string, description: string, source: string, extra = {}) {
  return { id, label, description, rawDescription: description, source, ...extra };
}

function pluginTool(name: string, label: string, description: string, pluginId: string) {
  return mockTool({ name, label, description, pluginMeta: { pluginId, optional: false } });
}
const groupLabels = {
  core: "Built-in tools",
  plugin: "Connected tools",
  channel: "Channel tools",
  mcp: "MCP server tools",
};
function expectedGroup(
  source: keyof typeof groupLabels,
  [id, label, description, extra]: [string, string, string, Record<string, string>?],
) {
  return {
    id: source,
    label: groupLabels[source],
    source,
    tools: [expectedTool(id, label, description, source, extra)],
  };
}
async function loadExecHarness() {
  await loadHarness({
    tools: [mockTool({ name: "exec", label: "Exec", description: "Run shell commands" })],
  });
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
  expect(effectiveInventoryState.createToolsMock).toHaveBeenCalledWith(
    expect.objectContaining({ modelApi: api }),
  );
}

function expectTransportContext(api: string, baseUrl: string | undefined) {
  expect(effectiveInventoryState.normalizeTransportMock).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceDir: "/tmp/workspace-main",
      context: expect.objectContaining({
        config: expect.any(Object),
        workspaceDir: "/tmp/workspace-main",
        provider: "openai",
        api,
        baseUrl,
      }),
    }),
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
  effectiveInventoryState.tools = options?.tools ?? [
    mockTool({ name: "exec", label: "Exec", description: "Run shell commands" }),
    mockTool({ name: "docs_lookup", label: "Docs Lookup", description: "Search docs" }),
  ];
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

it("groups core, plugin, and channel tools from the effective runtime set", async () => {
  const result = await inventoryFor({
    tools: [
      mockTool({ name: "exec", label: "Exec", description: "Run shell" }),
      pluginTool("lookup", "Lookup", "Search docs", "docs"),
      mockTool({ name: "actions", label: "Actions", description: "Act on messages" }),
    ],
    channelMeta: { actions: { channelId: "telegram" } },
  });

  const { toolAccess: _toolAccess, ...inventory } = result;
  expect(inventory).toEqual({
    agentId: "main",
    profile: "full",
    groups: [
      expectedGroup("core", ["exec", "Exec", "Run shell"]),
      expectedGroup("plugin", ["lookup", "Lookup", "Search docs", { pluginId: "docs" }]),
      expectedGroup("channel", [
        "actions",
        "Actions",
        "Act on messages",
        { channelId: "telegram" },
      ]),
    ],
  });
});

it("groups bundled MCP tools separately from generic plugin tools", async () => {
  const result = await inventoryFor({
    tools: [pluginTool("probe__tool", "Probe", "Probe MCP", "bundle-mcp")],
  });
  expect(result.groups).toEqual([
    expectedGroup("mcp", ["probe__tool", "Probe", "Probe MCP", { pluginId: "bundle-mcp" }]),
  ]);
});

it("disambiguates duplicate labels with source ids", async () => {
  const result = await inventoryFor({
    tools: [
      pluginTool("docs_lookup", "Lookup", "Search docs", "docs"),
      pluginTool("jira_lookup", "Lookup", "Search Jira", "jira"),
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
    tools: [pluginTool("docs_lookup", "Lookup", "Search docs", "docs")],
  });

  expect(result.groups[0]?.tools[0]).toEqual(
    expectedTool("docs_lookup", "Docs Search", "Curated docs lookup.", "plugin", {
      pluginId: "docs",
      risk: "low",
      tags: ["docs", "fixture"],
    }),
  );
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
    tools: [
      mockTool({ name: "exec", label: "Exec", description: "Run shell commands" }),
      mockTool({
        name: "fuzzplugin_move_angles",
        label: "Fuzzplugin Move Angles",
        description: "Move robot joints",
        pluginMeta: { pluginId: "fuzzplugin", optional: false },
        parameters,
      }),
    ],
  });

  expect(result.groups.flatMap((group) => group.tools.map((tool) => tool.id))).toEqual(["exec"]);
  expect(result.notices).toEqual([
    {
      id: "unsupported-tool-schema:fuzzplugin_move_angles",
      severity: "warning",
      message: `Tool "fuzzplugin_move_angles" from plugin "fuzzplugin" has an unsupported runtime input schema (${reason}) and was quarantined before model projection. Fix or disable the owner, or remove the tool from active allowlists.`,
    },
  ]);
});

it("reports unreadable inventory tool entries without crashing", async () => {
  const healthy = mockTool({ name: "exec", label: "Exec", description: "Run shell commands" });
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
  expect(result.notices).toEqual([
    {
      id: "unsupported-tool-schema:tool[0]",
      severity: "warning",
      message:
        'Tool "tool[0]" has an unsupported runtime input schema (tool[0] is unreadable) and was quarantined before model projection. Fix or disable the owner, or remove the tool from active allowlists.',
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
  expectTransportContext("openai-completions", "https://proxy.example.com/v1");
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
    if (!bundled) {
      expectTransportContext("openai-responses", undefined);
    }
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
    tools: [
      mockTool({
        name: "parameter_free",
        label: "Parameter Free",
        description: "Runtime-normalized tool",
        parameters: undefined,
        pluginMeta: { pluginId: "normalized-plugin", optional: false },
      }),
    ],
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
  expect(normalizeToolsMock).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "openai",
      modelId: "chat-latest",
      modelApi: "openai-responses",
      model: expect.objectContaining({
        id: "chat-latest",
        api: "openai-responses",
        provider: "openai",
      }),
    }),
  );
});

it("prefers displaySummary over raw description", async () => {
  const result = await inventoryFor({
    tools: [
      mockTool({
        name: "cron",
        label: "Cron",
        displaySummary: "Schedule and manage cron jobs.",
        description: "Long raw description\n\nACTIONS:\n- status",
      }),
    ],
  });

  expect(result.groups[0]?.tools[0]).toEqual({
    id: "cron",
    label: "Cron",
    description: "Schedule and manage cron jobs.",
    rawDescription: "Long raw description\n\nACTIONS:\n- status",
    source: "core",
  });
});

it("falls back to a sanitized summary for multi-line raw descriptions", async () => {
  const result = await inventoryFor({
    tools: [
      mockTool({
        name: "cron",
        label: "Cron",
        description:
          'Manage Gateway cron jobs (status/list/add/update/remove/run/runs) and send wake events. Use this for reminders, "check back later" requests, delayed follow-ups, and recurring tasks. Do not emulate scheduling with exec sleep or process polling.\n\nACTIONS:\n- status: Check cron scheduler status\nJOB SCHEMA:\n{ ... }',
      }),
    ],
  });

  const description = result.groups[0]?.tools[0]?.description ?? "";
  expect(description).toContain(
    "Manage Gateway cron jobs (status/list/add/update/remove/run/runs) and send wake events.",
  );
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
    tools: [mockTool({ name: "web_fetch", label: "Web Fetch", description: "Fetch web content" })],
  });

  const result = await resolveEffectiveToolInventory({
    cfg: {
      tools: { profile: "coding" },
      browser: { enabled: true },
      plugins: { entries: { browser: { enabled: true } } },
    } as never,
  });

  expect(result.notices).toEqual([
    {
      id: "browser-filtered-by-profile",
      severity: "info",
      message:
        'Browser is configured, but the current tool profile does not include the browser tool. Add tools.alsoAllow: ["browser"] or agents.entries.*.tools.alsoAllow: ["browser"]; tools.subagents.tools.allow alone cannot add it back after profile filtering.',
    },
  ]);
});
