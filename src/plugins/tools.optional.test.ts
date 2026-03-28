import { beforeEach, describe, expect, it, vi } from "vitest";

type MockRegistryToolEntry = {
  pluginId: string;
  optional: boolean;
  source: string;
  factory: (ctx: unknown) => unknown;
};

const loadOpenClawPluginsMock = vi.fn();

vi.mock("./loader.js", () => ({
  loadOpenClawPlugins: (params: unknown) => loadOpenClawPluginsMock(params),
}));

let resolvePluginTools: typeof import("./tools.js").resolvePluginTools;
let resetPluginRuntimeStateForTest: typeof import("./runtime.js").resetPluginRuntimeStateForTest;

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
  toolAllowlist?: readonly string[];
  existingToolNames?: Set<string>;
  env?: NodeJS.ProcessEnv;
  suppressNameConflicts?: boolean;
  allowGatewaySubagentBinding?: boolean;
}) {
  return {
    context: createContext() as never,
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

function resolveWithConflictingCoreName(options?: { suppressNameConflicts?: boolean }) {
  return resolvePluginTools(
    createResolveToolsParams({
      existingToolNames: new Set(["message"]),
      ...(options?.suppressNameConflicts ? { suppressNameConflicts: true } : {}),
    }),
  );
}

function setOptionalDemoRegistry() {
  setRegistry([
    {
      pluginId: "optional-demo",
      optional: true,
      source: "/tmp/optional-demo.js",
      factory: () => makeTool("optional_tool"),
    },
  ]);
}

function resolveOptionalDemoTools(toolAllowlist?: readonly string[]) {
  return resolvePluginTools(createResolveToolsParams({ toolAllowlist }));
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

describe("resolvePluginTools optional tools", () => {
  beforeEach(async () => {
    vi.resetModules();
    loadOpenClawPluginsMock.mockClear();
    ({ resetPluginRuntimeStateForTest } = await import("./runtime.js"));
    resetPluginRuntimeStateForTest();
    ({ resolvePluginTools } = await import("./tools.js"));
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

  it("skips conflicting tool names but keeps other tools", () => {
    const registry = setMultiToolRegistry();
    const tools = resolveWithConflictingCoreName();

    expectResolvedToolNames(tools, ["other_tool"]);
    expectSingleDiagnosticMessage(registry.diagnostics, "plugin tool name conflict");
  });

  it("suppresses conflict diagnostics when requested", () => {
    const registry = setMultiToolRegistry();
    const tools = resolveWithConflictingCoreName({ suppressNameConflicts: true });

    expectResolvedToolNames(tools, ["other_tool"]);
    expect(registry.diagnostics).toHaveLength(0);
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
});
