import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type MockRegistryToolEntry = {
  pluginId: string;
  optional: boolean;
  source: string;
  factory: (ctx: unknown) => unknown;
};

const loadOpenClawPluginsMock = vi.fn();
const resolveRuntimePluginRegistryMock = vi.fn();
const applyPluginAutoEnableMock = vi.fn();

vi.mock("./loader.js", () => ({
  resolveRuntimePluginRegistry: (params: unknown) => resolveRuntimePluginRegistryMock(params),
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (params: unknown) => applyPluginAutoEnableMock(params),
}));

let resolvePluginTools: typeof import("./tools.js").resolvePluginTools;
let buildPluginToolMetadataKey: typeof import("./tools.js").buildPluginToolMetadataKey;
let resetPluginToolFactoryCache: typeof import("./tools.js").resetPluginToolFactoryCache;
let resetPluginRuntimeStateForTest: typeof import("./runtime.js").resetPluginRuntimeStateForTest;
let setActivePluginRegistry: typeof import("./runtime.js").setActivePluginRegistry;

function makeTool(name: string) {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
}

function createContext() {
  return {
    config: {
      plugins: {
        enabled: true,
        allow: ["optional-demo", "message", "multi"],
        load: { paths: ["/tmp/plugin.js"] },
      },
    },
    workspaceDir: "/tmp",
  };
}

function createResolveToolsParams(params?: {
  context?: ReturnType<typeof createContext> & Record<string, unknown>;
  toolAllowlist?: readonly string[];
  existingToolNames?: Set<string>;
  env?: NodeJS.ProcessEnv;
  suppressNameConflicts?: boolean;
  allowGatewaySubagentBinding?: boolean;
}) {
  return {
    context: (params?.context ?? createContext()) as never,
    ...(params?.toolAllowlist ? { toolAllowlist: [...params.toolAllowlist] } : {}),
    ...(params?.existingToolNames ? { existingToolNames: params.existingToolNames } : {}),
    ...(params?.env ? { env: params.env } : {}),
    ...(params?.suppressNameConflicts ? { suppressNameConflicts: true } : {}),
    ...(params?.allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : {}),
  };
}

function setRegistry(entries: MockRegistryToolEntry[]) {
  const registry = {
    tools: entries,
    diagnostics: [] as Array<{
      level: string;
      pluginId: string;
      source: string;
      message: string;
    }>,
  };
  loadOpenClawPluginsMock.mockReturnValue(registry);
  return registry;
}

function setMultiToolRegistry() {
  return setRegistry([
    {
      pluginId: "multi",
      optional: false,
      source: "/tmp/multi.js",
      factory: () => [makeTool("message"), makeTool("other_tool")],
    },
  ]);
}

function createOptionalDemoEntry(): MockRegistryToolEntry {
  return {
    pluginId: "optional-demo",
    optional: true,
    source: "/tmp/optional-demo.js",
    factory: () => makeTool("optional_tool"),
  };
}

function createMalformedTool(name: string) {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "bad" }] };
    },
  };
}

function resolveWithConflictingCoreName(options?: { suppressNameConflicts?: boolean }) {
  return resolvePluginTools(
    createResolveToolsParams({
      existingToolNames: new Set(["message"]),
      ...(options?.suppressNameConflicts ? { suppressNameConflicts: true } : {}),
    }),
  );
}

function setOptionalDemoRegistry() {
  setRegistry([createOptionalDemoEntry()]);
}

function resolveOptionalDemoTools(toolAllowlist?: readonly string[]) {
  return resolvePluginTools(createResolveToolsParams({ toolAllowlist }));
}

function createAutoEnabledOptionalContext() {
  const rawContext = createContext();
  const autoEnabledConfig = {
    ...rawContext.config,
    plugins: {
      ...rawContext.config.plugins,
      entries: {
        "optional-demo": { enabled: true },
      },
    },
  };
  return { rawContext, autoEnabledConfig };
}

function expectAutoEnabledOptionalLoad(autoEnabledConfig: unknown) {
  expectLoaderCall({ config: autoEnabledConfig });
}

function resolveAutoEnabledOptionalDemoTools() {
  setOptionalDemoRegistry();
  const { rawContext, autoEnabledConfig } = createAutoEnabledOptionalContext();
  applyPluginAutoEnableMock.mockReturnValue({ config: autoEnabledConfig, changes: [] });

  const tools = resolvePluginTools({
    context: {
      ...rawContext,
      config: rawContext.config as never,
    } as never,
    toolAllowlist: ["optional_tool"],
  });

  return { rawContext, autoEnabledConfig, tools };
}

function createOptionalDemoActiveRegistry() {
  return {
    tools: [createOptionalDemoEntry()],
    diagnostics: [],
  };
}

function expectResolvedToolNames(
  tools: ReturnType<typeof resolvePluginTools>,
  expectedToolNames: readonly string[],
) {
  expect(tools.map((tool) => tool.name)).toEqual(expectedToolNames);
}

function expectLoaderCall(overrides: Record<string, unknown>) {
  expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(expect.objectContaining(overrides));
}

function expectSingleDiagnosticMessage(
  diagnostics: Array<{ message: string }>,
  messageFragment: string,
) {
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]?.message).toContain(messageFragment);
}

function expectConflictingCoreNameResolution(params: {
  suppressNameConflicts?: boolean;
  expectedDiagnosticFragment?: string;
}) {
  const registry = setMultiToolRegistry();
  const tools = resolveWithConflictingCoreName({
    suppressNameConflicts: params.suppressNameConflicts,
  });

  expectResolvedToolNames(tools, ["other_tool"]);
  if (params.expectedDiagnosticFragment) {
    expectSingleDiagnosticMessage(registry.diagnostics, params.expectedDiagnosticFragment);
    return;
  }
  expect(registry.diagnostics).toHaveLength(0);
}

describe("resolvePluginTools optional tools", () => {
  beforeAll(async () => {
    ({ buildPluginToolMetadataKey, resetPluginToolFactoryCache, resolvePluginTools } =
      await import("./tools.js"));
    ({ resetPluginRuntimeStateForTest, setActivePluginRegistry } = await import("./runtime.js"));
  });

  beforeEach(() => {
    loadOpenClawPluginsMock.mockClear();
    resolveRuntimePluginRegistryMock.mockReset();
    resolveRuntimePluginRegistryMock.mockImplementation((params) =>
      loadOpenClawPluginsMock(params),
    );
    applyPluginAutoEnableMock.mockReset();
    applyPluginAutoEnableMock.mockImplementation(({ config }: { config: unknown }) => ({
      config,
      changes: [],
    }));
    resetPluginRuntimeStateForTest?.();
    resetPluginToolFactoryCache?.();
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest?.();
    resetPluginToolFactoryCache?.();
  });

  it("skips optional tools without explicit allowlist", () => {
    setOptionalDemoRegistry();
    const tools = resolveOptionalDemoTools();

    expect(tools).toHaveLength(0);
  });

  it.each([
    {
      name: "allows optional tools by tool name",
      toolAllowlist: ["optional_tool"],
    },
    {
      name: "allows optional tools via plugin id",
      toolAllowlist: ["optional-demo"],
    },
    {
      name: "allows optional tools via plugin-scoped allowlist entries",
      toolAllowlist: ["group:plugins"],
    },
  ] as const)("$name", ({ toolAllowlist }) => {
    setOptionalDemoRegistry();
    const tools = resolveOptionalDemoTools(toolAllowlist);

    expectResolvedToolNames(tools, ["optional_tool"]);
  });

  it("rejects plugin id collisions with core tool names", () => {
    const registry = setRegistry([
      {
        pluginId: "message",
        optional: false,
        source: "/tmp/message.js",
        factory: () => makeTool("optional_tool"),
      },
    ]);

    const tools = resolvePluginTools(
      createResolveToolsParams({
        existingToolNames: new Set(["message"]),
      }),
    );

    expect(tools).toHaveLength(0);
    expectSingleDiagnosticMessage(registry.diagnostics, "plugin id conflicts with core tool name");
  });

  it.each([
    {
      name: "skips conflicting tool names but keeps other tools",
      expectedDiagnosticFragment: "plugin tool name conflict",
    },
    {
      name: "suppresses conflict diagnostics when requested",
      suppressNameConflicts: true,
    },
  ] as const)("$name", ({ suppressNameConflicts, expectedDiagnosticFragment }) => {
    expectConflictingCoreNameResolution({
      suppressNameConflicts,
      expectedDiagnosticFragment,
    });
  });

  it.each([
    {
      name: "forwards an explicit env to plugin loading",
      params: {
        env: { OPENCLAW_HOME: "/srv/openclaw-home" } as NodeJS.ProcessEnv,
        toolAllowlist: ["optional_tool"],
      },
      expectedLoaderCall: {
        env: { OPENCLAW_HOME: "/srv/openclaw-home" },
      },
    },
    {
      name: "forwards gateway subagent binding to plugin runtime options",
      params: {
        allowGatewaySubagentBinding: true,
        toolAllowlist: ["optional_tool"],
      },
      expectedLoaderCall: {
        runtimeOptions: {
          allowGatewaySubagentBinding: true,
        },
      },
    },
  ])("$name", ({ params, expectedLoaderCall }) => {
    setOptionalDemoRegistry();

    resolvePluginTools(createResolveToolsParams(params));

    expectLoaderCall(expectedLoaderCall);
  });

  it("skips malformed plugin tools while keeping valid sibling tools", () => {
    const registry = setRegistry([
      {
        pluginId: "schema-bug",
        optional: false,
        source: "/tmp/schema-bug.js",
        factory: () => [createMalformedTool("broken_tool"), makeTool("valid_tool")],
      },
    ]);

    const tools = resolvePluginTools(createResolveToolsParams());

    expectResolvedToolNames(tools, ["valid_tool"]);
    expectSingleDiagnosticMessage(
      registry.diagnostics,
      "plugin tool is malformed (schema-bug): broken_tool missing parameters object",
    );
  });

  it("skips allowlisted optional malformed plugin tools", () => {
    const registry = setRegistry([
      {
        pluginId: "optional-demo",
        optional: true,
        source: "/tmp/optional-demo.js",
        factory: () => createMalformedTool("optional_tool"),
      },
    ]);

    const tools = resolveOptionalDemoTools(["optional_tool"]);

    expect(tools).toHaveLength(0);
    expectSingleDiagnosticMessage(
      registry.diagnostics,
      "plugin tool is malformed (optional-demo): optional_tool missing parameters object",
    );
  });

  it("caches plugin tool factory results for equivalent request context", () => {
    const factory = vi.fn(() => makeTool("cached_tool"));
    setRegistry([
      {
        pluginId: "cache-test",
        optional: false,
        source: "/tmp/cache-test.js",
        factory,
      },
    ]);

    const first = resolvePluginTools(createResolveToolsParams({ context: createContext() }));
    const second = resolvePluginTools(createResolveToolsParams({ context: createContext() }));

    expectResolvedToolNames(first, ["cached_tool"]);
    expectResolvedToolNames(second, ["cached_tool"]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(second[0]).toBe(first[0]);
  });

  it("does not reuse plugin tool factory results across sandbox context changes", () => {
    const factory = vi.fn((rawCtx: unknown) => {
      const ctx = rawCtx as { sandboxed?: boolean };
      return ctx.sandboxed ? null : makeTool("sandbox_sensitive_tool");
    });
    setRegistry([
      {
        pluginId: "sandbox-sensitive",
        optional: false,
        source: "/tmp/sandbox-sensitive.js",
        factory,
      },
    ]);

    const hostTools = resolvePluginTools(
      createResolveToolsParams({
        context: { ...createContext(), sandboxed: false },
      }),
    );
    const sandboxedTools = resolvePluginTools(
      createResolveToolsParams({
        context: { ...createContext(), sandboxed: true },
      }),
    );

    expectResolvedToolNames(hostTools, ["sandbox_sensitive_tool"]);
    expect(sandboxedTools).toEqual([]);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("does not reuse plugin tool factory results across runtime config changes", () => {
    const firstRuntimeConfig = {
      ...createContext().config,
      plugins: { ...createContext().config.plugins, allow: ["runtime_sensitive_tool"] },
    };
    const secondRuntimeConfig = {
      ...createContext().config,
      plugins: { ...createContext().config.plugins, allow: ["runtime_sensitive_next_tool"] },
    };
    const factory = vi.fn((rawCtx: unknown) => {
      const ctx = rawCtx as { runtimeConfig?: { plugins?: { allow?: string[] } } };
      return makeTool(ctx.runtimeConfig?.plugins?.allow?.[0] ?? "runtime_missing_tool");
    });
    setRegistry([
      {
        pluginId: "runtime-sensitive",
        optional: false,
        source: "/tmp/runtime-sensitive.js",
        factory,
      },
    ]);

    const first = resolvePluginTools(
      createResolveToolsParams({
        context: { ...createContext(), runtimeConfig: firstRuntimeConfig as never },
      }),
    );
    const second = resolvePluginTools(
      createResolveToolsParams({
        context: { ...createContext(), runtimeConfig: secondRuntimeConfig as never },
      }),
    );

    expectResolvedToolNames(first, ["runtime_sensitive_tool"]);
    expectResolvedToolNames(second, ["runtime_sensitive_next_tool"]);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("reuses plugin tool factory results when only runtime config getter identity changes", () => {
    const runtimeConfig = {
      ...createContext().config,
      plugins: { ...createContext().config.plugins, allow: ["getter_sensitive_tool"] },
    };
    const factory = vi.fn((rawCtx: unknown) => {
      const ctx = rawCtx as { getRuntimeConfig?: () => { plugins?: { allow?: string[] } } };
      return makeTool(ctx.getRuntimeConfig?.()?.plugins?.allow?.[0] ?? "getter_missing_tool");
    });
    setRegistry([
      {
        pluginId: "getter-sensitive",
        optional: false,
        source: "/tmp/getter-sensitive.js",
        factory,
      },
    ]);

    const context = createContext();
    const first = resolvePluginTools(
      createResolveToolsParams({
        context: { ...context, getRuntimeConfig: () => runtimeConfig as never },
      }),
    );
    const second = resolvePluginTools(
      createResolveToolsParams({
        context: { ...context, getRuntimeConfig: () => runtimeConfig as never },
      }),
    );

    expectResolvedToolNames(first, ["getter_sensitive_tool"]);
    expectResolvedToolNames(second, ["getter_sensitive_tool"]);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("reads live runtime config once per plugin tool resolution for cache keys", () => {
    const runtimeConfig = createContext().config;
    const getRuntimeConfig = vi.fn(() => runtimeConfig);
    setRegistry([
      {
        pluginId: "getter-a",
        optional: false,
        source: "/tmp/getter-a.js",
        factory: () => makeTool("getter_a_tool"),
      },
      {
        pluginId: "getter-b",
        optional: false,
        source: "/tmp/getter-b.js",
        factory: () => makeTool("getter_b_tool"),
      },
    ]);

    const tools = resolvePluginTools(
      createResolveToolsParams({
        context: { ...createContext(), getRuntimeConfig: getRuntimeConfig as never },
      }),
    );

    expectResolvedToolNames(tools, ["getter_a_tool", "getter_b_tool"]);
    expect(getRuntimeConfig).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "loads plugin tools from the auto-enabled config snapshot",
      expectedToolNames: undefined,
    },
    {
      name: "does not reuse a cached active registry when auto-enable changes the config snapshot",
      expectedToolNames: ["optional_tool"],
    },
  ] as const)("$name", ({ expectedToolNames }) => {
    const { rawContext, autoEnabledConfig, tools } = resolveAutoEnabledOptionalDemoTools();

    expect(applyPluginAutoEnableMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            allow: rawContext.config.plugins?.allow,
            load: rawContext.config.plugins?.load,
          }),
        }),
        env: process.env,
      }),
    );
    if (expectedToolNames) {
      expectResolvedToolNames(tools, expectedToolNames);
    }
    expectAutoEnabledOptionalLoad(autoEnabledConfig);
  });

  it("reuses a compatible active registry instead of loading again", () => {
    const activeRegistry = createOptionalDemoActiveRegistry();
    resolveRuntimePluginRegistryMock.mockReturnValue(activeRegistry);

    const tools = resolvePluginTools(
      createResolveToolsParams({
        toolAllowlist: ["optional_tool"],
      }),
    );

    expectResolvedToolNames(tools, ["optional_tool"]);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("reuses the active registry for gateway-bindable tool loads before reloading", () => {
    const activeRegistry = createOptionalDemoActiveRegistry();
    setActivePluginRegistry(activeRegistry as never, "gateway-startup", "gateway-bindable");
    resolveRuntimePluginRegistryMock.mockReturnValue(undefined);

    const tools = resolvePluginTools(
      createResolveToolsParams({
        toolAllowlist: ["optional_tool"],
        allowGatewaySubagentBinding: true,
      }),
    );

    expectResolvedToolNames(tools, ["optional_tool"]);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("loads plugin tools when gateway-bindable tool loads have no active registry", () => {
    setOptionalDemoRegistry();

    const tools = resolvePluginTools(
      createResolveToolsParams({
        toolAllowlist: ["optional_tool"],
        allowGatewaySubagentBinding: true,
      }),
    );

    expectResolvedToolNames(tools, ["optional_tool"]);
    expectLoaderCall({
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    });
  });

  it("reloads when gateway binding would otherwise reuse a default-mode active registry", () => {
    setActivePluginRegistry(
      {
        tools: [],
        diagnostics: [],
      } as never,
      "default-registry",
      "default",
    );
    setOptionalDemoRegistry();

    resolvePluginTools({
      context: createContext() as never,
      allowGatewaySubagentBinding: true,
      toolAllowlist: ["optional_tool"],
    });

    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        installBundledRuntimeDeps: false,
        runtimeOptions: {
          allowGatewaySubagentBinding: true,
        },
      }),
    );
  });
});

describe("buildPluginToolMetadataKey", () => {
  beforeAll(async () => {
    ({ buildPluginToolMetadataKey } = await import("./tools.js"));
  });

  it("does not collide when ids or names contain separator-like characters", () => {
    expect(buildPluginToolMetadataKey("plugin", "a\uE000b")).not.toBe(
      buildPluginToolMetadataKey("plugin\uE000a", "b"),
    );
    expect(buildPluginToolMetadataKey("plugin", "a\u0000b")).not.toBe(
      buildPluginToolMetadataKey("plugin\u0000a", "b"),
    );
  });
});
