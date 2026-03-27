import { beforeEach, describe, expect, it, vi } from "vitest";

type MockRegistryToolEntry = {
  pluginId: string;
  optional: boolean;
  source: string;
  names?: string[];
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
  return resolvePluginTools({
    context: createContext() as never,
    existingToolNames: new Set(["message"]),
    ...(options?.suppressNameConflicts ? { suppressNameConflicts: true } : {}),
  });
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

function resolveOptionalDemoTools(toolAllowlist?: string[]) {
  return resolvePluginTools({
    context: createContext() as never,
    ...(toolAllowlist ? { toolAllowlist } : {}),
  });
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

  it("allows optional tools by tool name", () => {
    setOptionalDemoRegistry();
    const tools = resolveOptionalDemoTools(["optional_tool"]);

    expect(tools.map((tool) => tool.name)).toEqual(["optional_tool"]);
  });

  it("allows optional tools via plugin-scoped allowlist entries", () => {
    setOptionalDemoRegistry();
    const toolsByPlugin = resolveOptionalDemoTools(["optional-demo"]);
    const toolsByGroup = resolveOptionalDemoTools(["group:plugins"]);

    expect(toolsByPlugin.map((tool) => tool.name)).toEqual(["optional_tool"]);
    expect(toolsByGroup.map((tool) => tool.name)).toEqual(["optional_tool"]);
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

    const tools = resolvePluginTools({
      context: createContext() as never,
      existingToolNames: new Set(["message"]),
    });

    expect(tools).toHaveLength(0);
    expect(registry.diagnostics).toHaveLength(1);
    expect(registry.diagnostics[0]?.message).toContain("plugin id conflicts with core tool name");
  });

  it("skips conflicting tool names but keeps other tools", () => {
    const registry = setMultiToolRegistry();
    const tools = resolveWithConflictingCoreName();

    expect(tools.map((tool) => tool.name)).toEqual(["other_tool"]);
    expect(registry.diagnostics).toHaveLength(1);
    expect(registry.diagnostics[0]?.message).toContain("plugin tool name conflict");
  });

  it("suppresses conflict diagnostics when requested", () => {
    const registry = setMultiToolRegistry();
    const tools = resolveWithConflictingCoreName({ suppressNameConflicts: true });

    expect(tools.map((tool) => tool.name)).toEqual(["other_tool"]);
    expect(registry.diagnostics).toHaveLength(0);
  });

  it("forwards an explicit env to plugin loading", () => {
    setOptionalDemoRegistry();
    const env = { OPENCLAW_HOME: "/srv/openclaw-home" } as NodeJS.ProcessEnv;

    resolvePluginTools({
      context: createContext() as never,
      env,
      toolAllowlist: ["optional_tool"],
    });

    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
      }),
    );
  });

  it("forwards gateway subagent binding to plugin runtime options", () => {
    setOptionalDemoRegistry();

    resolvePluginTools({
      context: createContext() as never,
      allowGatewaySubagentBinding: true,
      toolAllowlist: ["optional_tool"],
    });

    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeOptions: {
          allowGatewaySubagentBinding: true,
        },
      }),
    );
  });
});

describe("execute context injection", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const mod = await import("./tools.js");
    resolvePluginTools = mod.resolvePluginTools;
    const runtimeMod = await import("./runtime.js");
    resetPluginRuntimeStateForTest = runtimeMod.resetPluginRuntimeStateForTest;
    resetPluginRuntimeStateForTest();
  });

  it("injects agentId into execute context as third argument", async () => {
    let receivedContext: unknown = undefined;
    const tool = {
      name: "ctx_test",
      description: "test tool",
      parameters: { type: "object" as const, properties: {} },
      async execute(_callId: string, _params: unknown, context?: unknown) {
        receivedContext = context;
        return { content: [{ type: "text" as const, text: "ok" }] };
      },
    };

    setRegistry([
      {
        pluginId: "ctx-test-plugin",
        optional: false,
        source: "test",
        factory: () => tool,
        names: ["ctx_test"],
      },
    ]);

    const ctx = {
      ...createContext(),
      agentId: "test_agent_42",
      sessionKey: "agent:test_agent_42:main",
    };

    const tools = resolvePluginTools({
      context: ctx as never,
    });

    expect(tools).toHaveLength(1);
    await tools[0].execute("call-1", {});

    expect(receivedContext).toEqual(
      expect.objectContaining({
        agentId: "test_agent_42",
        sessionKey: "agent:test_agent_42:main",
      }),
    );
  });

  it("does not leak config into execute context", async () => {
    let receivedContext: Record<string, unknown> = {};
    const tool = {
      name: "leak_test",
      description: "test tool",
      parameters: { type: "object" as const, properties: {} },
      async execute(_callId: string, _params: unknown, context?: unknown) {
        receivedContext = (context ?? {}) as Record<string, unknown>;
        return { content: [{ type: "text" as const, text: "ok" }] };
      },
    };

    setRegistry([
      {
        pluginId: "leak-test-plugin",
        optional: false,
        source: "test",
        factory: () => tool,
        names: ["leak_test"],
      },
    ]);

    const ctx = {
      ...createContext(),
      agentId: "agent_1",
    };

    const tools = resolvePluginTools({
      context: ctx as never,
    });

    await tools[0].execute("call-1", {});

    // config must NOT be present in execute context
    expect(receivedContext).not.toHaveProperty("config");
    expect(receivedContext).not.toHaveProperty("workspaceDir");
    expect(receivedContext).not.toHaveProperty("agentDir");
    // but agentId must be present
    expect(receivedContext).toHaveProperty("agentId", "agent_1");
  });
});
