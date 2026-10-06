import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpProofPluginRegistry } from "../agents/mcp-connection-resolver.test-fixtures.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { collectGatewayHealthFindings } from "../commands/doctor-gateway-health.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { createCoreHealthChecks } from "./doctor-core-checks.js";
import { exitCodeFromFindings } from "./doctor-lint-flow.js";
import type { HealthFinding } from "./health-checks.js";

const mocks = vi.hoisted(() => ({
  createBundleMcpToolRuntime: vi.fn(),
  createOpenClawCodingTools: vi.fn(),
  disposeBundleRuntime: vi.fn(),
  loadModelCatalog: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
  normalizeProviderToolSchemasWithPlugin: vi.fn(),
  buildGatewayProbeConnectionDetails: vi.fn(),
  callGateway: vi.fn(),
  isGatewayCredentialsRequiredError: vi.fn(),
  isContainerEnvironment: vi.fn(() => false),
  readGatewayServiceState: vi.fn(),
  resolveNodeRuntimeInfo:
    vi.fn<typeof import("../daemon/runtime-paths.js").resolveNodeRuntimeInfo>(),
  resolveGatewayService: vi.fn(() => ({ label: "openclaw-gateway" })),
  resolvePluginProvidersCore: vi.fn((): Array<Record<string, unknown>> => []),
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-5.5" })),
}));

vi.mock("../agents/model-catalog.js", () => ({
  findModelInCatalog: (
    catalog: Array<{ provider?: string; id?: string }>,
    provider: string,
    modelId: string,
  ) => catalog.find((entry) => entry.provider === provider && entry.id === modelId),
}));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog: mocks.loadModelCatalog,
}));

vi.mock("../agents/model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/model-selection.js")>()),
  resolveDefaultModelForAgent: mocks.resolveDefaultModelForAgent,
}));

vi.mock("../agents/agent-bundle-mcp-tools.js", () => ({
  createBundleMcpToolRuntime: mocks.createBundleMcpToolRuntime,
}));

vi.mock("../agents/agent-tools.js", () => ({
  createOpenClawCodingTools: mocks.createOpenClawCodingTools,
}));

vi.mock("../gateway/call.js", () => ({
  buildGatewayProbeConnectionDetails: mocks.buildGatewayProbeConnectionDetails,
  callGateway: mocks.callGateway,
  isGatewayCredentialsRequiredError: mocks.isGatewayCredentialsRequiredError,
}));

vi.mock("../daemon/service.js", () => ({
  readGatewayServiceState: mocks.readGatewayServiceState,
  resolveGatewayService: mocks.resolveGatewayService,
}));

vi.mock("../daemon/runtime-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/runtime-paths.js")>()),
  resolveNodeRuntimeInfo: mocks.resolveNodeRuntimeInfo,
}));

vi.mock("../infra/container-environment.js", () => ({
  isContainerEnvironment: mocks.isContainerEnvironment,
}));

vi.mock("../daemon/systemd.js", () => ({
  findInstalledSystemdGatewayScope: vi
    .fn<typeof import("../daemon/systemd.js").findInstalledSystemdGatewayScope>()
    .mockResolvedValue(null),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  inspectProviderToolSchemasWithPlugin: () => [],
  normalizeProviderToolSchemasWithPlugin: mocks.normalizeProviderToolSchemasWithPlugin,
}));

vi.mock("../plugins/providers.runtime.js", () => ({
  resolvePluginProvidersCore: mocks.resolvePluginProvidersCore,
}));

const { collectGatewayDaemonFindings, collectProviderCatalogProjectionFindings } =
  await import("./doctor-core-checks.runtime.js");
const { collectRuntimeToolSchemaFindings } = await import("./doctor-tool-schema-runtime.js");

function tool(name: string, parameters: unknown): AnyAgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters,
    execute: async () => ({ text: "ok" }),
  } as unknown as AnyAgentTool;
}

function bundleMcpTool(name: string, parameters: unknown): AnyAgentTool {
  const entry = tool(name, parameters);
  setPluginToolMeta(entry, { pluginId: "bundle-mcp", optional: false });
  return entry;
}

function mcpConfig(serverName = "fuzzplugin") {
  return { mcp: { servers: { [serverName]: { command: "node", args: ["fuzzplugin-mcp.mjs"] } } } };
}

function mockBundleDiagnostic(serverName = "fuzzplugin") {
  mocks.createBundleMcpToolRuntime.mockReturnValueOnce({
    tools: [],
    diagnostics: [
      {
        serverName,
        safeServerName: serverName,
        launchSummary: "node fuzzplugin-mcp.mjs",
        message: 'tools[0].inputSchema.type: Invalid input: expected "object"',
      },
    ],
    dispose: mocks.disposeBundleRuntime,
  });
}

function expectSchemaError(findings: readonly HealthFinding[], expected: Partial<HealthFinding>) {
  expect(findings).toContainEqual(
    expect.objectContaining({
      checkId: "core/doctor/runtime-tool-schemas",
      severity: "error",
      ...expected,
    }),
  );
}

describe("doctor runtime tool schema checks", () => {
  beforeEach(() => {
    mocks.createOpenClawCodingTools.mockReset().mockReturnValue([]);
    mocks.createBundleMcpToolRuntime.mockReset().mockReturnValue({
      tools: [],
      dispose: mocks.disposeBundleRuntime,
    });
    mocks.disposeBundleRuntime.mockReset().mockReturnValue(undefined);
    mocks.loadModelCatalog.mockClear();
    mocks.normalizeProviderToolSchemasWithPlugin
      .mockReset()
      .mockImplementation(({ context }) => context.tools);
    mocks.resolvePluginProvidersCore.mockReset().mockReturnValue([]);
    mocks.resolveDefaultModelForAgent.mockClear();
  });

  it("reports active bundle MCP schemas before a model turn", async () => {
    mocks.createBundleMcpToolRuntime.mockReturnValueOnce({
      tools: [
        bundleMcpTool("fuzzplugin__healthy", { type: "object", properties: {} }),
        bundleMcpTool("fuzzplugin__move_angles", { type: "array", items: { type: "number" } }),
      ],
      dispose: mocks.disposeBundleRuntime,
    });
    expectSchemaError(await collectRuntimeToolSchemaFindings(mcpConfig()), {
      path: "mcp.servers",
      target: "fuzzplugin__move_angles",
      requirement: 'fuzzplugin__move_angles.parameters.type must be "object"',
      message: expect.stringContaining(
        "Agent main tool fuzzplugin__move_angles from plugin bundle-mcp",
      ),
    });
    expect(mocks.disposeBundleRuntime).toHaveBeenCalledTimes(1);
  });

  it.each(["1", "0"])(
    "defers MCP with published updater IN_PROGRESS=%s markers",
    async (inProgress) => {
      const check = createCoreHealthChecks().find(
        (candidate) => candidate.id === "core/doctor/runtime-tool-schemas",
      );
      expect(check).toBeDefined();
      const findings = await check!.detect({
        mode: inProgress === "1" ? "doctor" : "lint",
        runtime: { log() {}, error() {}, exit() {} },
        // The published driver clears IN_PROGRESS for lint but retains the parent marker.
        env: {
          ...process.env,
          OPENCLAW_UPDATE_IN_PROGRESS: inProgress,
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
        },
        cfg: {
          agents: { entries: { alpha: {}, beta: {} } },
          mcp: {
            servers: {
              local: { command: "npx", args: ["-y", "fixture-mcp"] },
              remote: { transport: "streamable-http", url: "https://mcp.example.test" },
              disabled: { command: "fixture-disabled", enabled: false },
            },
          },
        },
      });
      expect(mocks.createBundleMcpToolRuntime).not.toHaveBeenCalled();
      expect(mocks.createOpenClawCodingTools).toHaveBeenCalledTimes(2);
      expect(findings).toEqual(
        ["local", "remote"].map((serverName) =>
          expect.objectContaining({
            checkId: "core/doctor/runtime-tool-schemas",
            severity: "warning",
            path: `mcp.servers.${serverName}`,
            message: expect.stringContaining(
              "openclaw doctor --lint --only core/doctor/runtime-tool-schemas",
            ),
          }),
        ),
      );
      expect(exitCodeFromFindings(findings, "error")).toBe(0);
    },
  );

  it("preserves the catalog transport when building runtime models", async () => {
    const transport = {
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api",
    };
    mocks.loadModelCatalog.mockResolvedValueOnce([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
        ...transport,
        compat: { supportsTools: true },
      },
    ]);
    mocks.createOpenClawCodingTools.mockReturnValueOnce([
      tool("healthy", { type: "object", properties: {} }),
    ]);
    await collectRuntimeToolSchemaFindings({});
    expect(mocks.normalizeProviderToolSchemasWithPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          modelApi: transport.api,
          model: expect.objectContaining(transport),
        }),
      }),
    );
  });

  it("preserves MCP diagnostics when cleanup also fails", async () => {
    mocks.disposeBundleRuntime.mockRejectedValueOnce(
      new Error("MCP runtime cleanup could not confirm closure"),
    );
    mockBundleDiagnostic();
    const findings = await collectRuntimeToolSchemaFindings(mcpConfig());
    expectSchemaError(findings, {
      path: "mcp.servers.fuzzplugin",
      requirement: 'tools[0].inputSchema.type: Invalid input: expected "object"',
    });
    expectSchemaError(findings, {
      path: "mcp.servers",
      requirement: "MCP runtime cleanup could not confirm closure",
      fixHint: "Inspect or stop the configured MCP server processes, then rerun doctor.",
    });
    expect(mocks.disposeBundleRuntime).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["my__server", "my__server__healthy"],
    ["fuzzplugin", "*__healthy"],
  ])("reports MCP diagnostics through allowlist %s/%s", async (server, allowed) => {
    mockBundleDiagnostic(server);
    expectSchemaError(
      await collectRuntimeToolSchemaFindings({
        tools: { allow: [allowed] },
        ...mcpConfig(server),
      }),
      { path: `mcp.servers.${server}` },
    );
  });

  it("inspects non-default agents with read-only model catalogs", async () => {
    mocks.createOpenClawCodingTools.mockImplementation((options) =>
      options?.agentId === "worker"
        ? [tool("fuzzplugin_move_angles", { type: "array", items: { type: "number" } })]
        : [tool("healthy", { type: "object", properties: {} })],
    );
    expectSchemaError(
      await collectRuntimeToolSchemaFindings({
        agents: {
          entries: {
            main: { workspace: "/tmp/shared-workspace" },
            worker: { workspace: "/tmp/shared-workspace" },
          },
        },
      }),
      {
        path: "tools.fuzzplugin_move_angles",
        target: "fuzzplugin_move_angles",
        message: expect.stringContaining("Agent worker tool fuzzplugin_move_angles"),
        requirement: 'fuzzplugin_move_angles.parameters.type must be "object"',
      },
    );
    for (const [index, agentId] of ["main", "worker"].entries()) {
      expect(mocks.createOpenClawCodingTools).toHaveBeenCalledWith(
        expect.objectContaining({ agentId }),
      );
      expect(mocks.loadModelCatalog).toHaveBeenNthCalledWith(
        index + 1,
        expect.objectContaining({
          agentId,
          readOnly: true,
          providerDiscoveryProviderIds: [],
        }),
      );
    }
    expect(mocks.loadModelCatalog).toHaveBeenCalledTimes(2);
    expect(mocks.createBundleMcpToolRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.disposeBundleRuntime).toHaveBeenCalledTimes(1);
  });

  it("skips ACP-only agents", async () => {
    mocks.createOpenClawCodingTools.mockImplementation((options) =>
      options?.agentId === "acp-worker"
        ? [tool("fuzzplugin_move_angles", { type: "array", items: { type: "number" } })]
        : [tool("healthy", { type: "object", properties: {} })],
    );
    await expect(
      collectRuntimeToolSchemaFindings({
        agents: {
          entries: {
            main: { workspace: "/tmp/main-workspace" },
            "acp-worker": { workspace: "/tmp/acp-workspace", runtime: { type: "acp" } },
          },
        },
      }),
    ).resolves.toEqual([]);
    expect(mocks.createOpenClawCodingTools).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ agentId: "main" }),
    );
    expect(mocks.createBundleMcpToolRuntime).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        workspaceDir: expect.stringContaining("main-workspace"),
      }),
    );
  });

  it("reuses one MCP probe for equivalent agent workspaces", async () => {
    mockBundleDiagnostic();
    const findings = await collectRuntimeToolSchemaFindings({
      ...mcpConfig(),
      agents: {
        entries: {
          main: { workspace: "/tmp/main-workspace" },
          worker: { workspace: "/tmp/worker-workspace" },
        },
      },
    });
    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/runtime-tool-schemas",
        severity: "error",
        path: "mcp.servers.fuzzplugin",
        requirement: 'tools[0].inputSchema.type: Invalid input: expected "object"',
      }),
    ]);
    expect(mocks.createBundleMcpToolRuntime).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        workspaceDir: expect.stringContaining("main-workspace"),
      }),
    );
    expect(mocks.disposeBundleRuntime).toHaveBeenCalledTimes(1);
  });

  it("does not probe requester-scoped MCP without a requester", async () => {
    const resolverRegistry = createMcpProofPluginRegistry();
    await withPluginRuntimeRegistryScope(resolverRegistry.registry, async () => {
      const resolveConnection = vi.fn();
      resolverRegistry.apiFor("fuzzplugin").registerMcpServerConnectionResolver({
        serverName: "fuzzplugin",
        resolve: resolveConnection,
      });
      expect(
        await collectRuntimeToolSchemaFindings({
          mcp: {
            servers: {
              fuzzplugin: {
                url: "https://placeholder.invalid/mcp",
                transport: "streamable-http",
                auth: "oauth",
              },
            },
          },
        }),
      ).toContainEqual(
        expect.objectContaining({
          checkId: "core/doctor/runtime-tool-schemas",
          severity: "info",
          path: "mcp.servers.fuzzplugin",
          requirement: "authenticated requester context",
          fixHint: "Verify this server from an authenticated agent turn.",
        }),
      );
      expect(resolveConnection).not.toHaveBeenCalled();
      expect(mocks.createBundleMcpToolRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          excludeServerNames: new Set(["fuzzplugin"]),
        }),
      );
    });
  });

  it("defers shared OAuth without suppressing non-OAuth probes", async () => {
    const findings = await collectRuntimeToolSchemaFindings({
      agents: {
        entries: {
          main: { workspace: "/tmp/main-workspace" },
          worker: { workspace: "/tmp/worker-workspace" },
        },
      },
      mcp: {
        servers: {
          authenticated: {
            url: "https://oauth.example.test/mcp",
            transport: "streamable-http",
            auth: "oauth",
            oauth: { authProfileId: "provider:default" },
          },
          public: { url: "https://public.example.test/mcp", transport: "sse" },
          local: { command: "fixture-mcp" },
        },
      },
    });
    expect(findings).toEqual([
      expect.objectContaining({
        severity: "info",
        path: "mcp.servers.authenticated",
        message: expect.stringContaining("OAuth may rotate external credentials"),
        fixHint: expect.stringContaining("openclaw mcp probe"),
      }),
    ]);
    expect(mocks.createBundleMcpToolRuntime).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        excludeServerNames: new Set(["authenticated"]),
      }),
    );
    expect(mocks.disposeBundleRuntime).toHaveBeenCalledTimes(1);
  });

  it("filters MCP diagnostics through server-level deny policy", async () => {
    mockBundleDiagnostic();
    await expect(
      collectRuntimeToolSchemaFindings({
        tools: { deny: ["fuzzplugin__*"] },
        ...mcpConfig(),
      }),
    ).resolves.toEqual([]);
  });

  it.each([
    {
      phase: "load",
      toolName: "",
      path: "agents.main.tools",
      message: "Agent main runtime tool schema validation could not load the runtime tool set.",
    },
    {
      phase: "normalize",
      toolName: "fuzzplugin_move_angles",
      path: "agents.main.tools",
      message:
        "Agent main runtime tool schema validation could not normalize the runtime tool set.",
    },
    {
      phase: "normalize",
      toolName: "fuzzplugin__move_angles",
      path: "mcp.servers",
      message: "Configured MCP tool schema validation could not normalize the runtime tool set.",
    },
  ])(
    "reports $path $phase errors and disposes the runtime",
    async ({ phase, toolName, path, message }) => {
      const error = new Error(`fuzzplugin ${phase} failed`);
      if (phase === "load") {
        mocks.createOpenClawCodingTools.mockImplementationOnce(() => {
          throw error;
        });
      } else {
        if (path === "mcp.servers") {
          mocks.createBundleMcpToolRuntime.mockResolvedValueOnce({
            tools: [bundleMcpTool(toolName, { type: "object", properties: {} })],
            dispose: mocks.disposeBundleRuntime,
          });
        } else {
          mocks.createOpenClawCodingTools.mockReturnValueOnce([
            tool(toolName, { type: "object", properties: {} }),
          ]);
        }
        mocks.normalizeProviderToolSchemasWithPlugin.mockImplementation(({ context }) => {
          const tools: AnyAgentTool[] = context.tools;
          if (tools.some((entry) => entry.name === toolName)) {
            throw error;
          }
          return tools;
        });
      }
      expectSchemaError(await collectRuntimeToolSchemaFindings({}), {
        path,
        message,
        requirement: error.message,
      });
      expect(mocks.createBundleMcpToolRuntime).toHaveBeenCalledTimes(1);
      expect(mocks.disposeBundleRuntime).toHaveBeenCalledTimes(1);
    },
  );
});

describe("doctor gateway runtime checks", () => {
  beforeEach(() => {
    mocks.resolveNodeRuntimeInfo.mockReset().mockResolvedValue({
      status: "supported",
      version: "26.8.1",
      sqliteVersion: "3.53.4",
      sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
      nodeSharedSqlite: false,
    });
    mocks.isContainerEnvironment.mockReset().mockReturnValue(false);
    mocks.buildGatewayProbeConnectionDetails.mockReset().mockResolvedValue({
      url: "http://127.0.0.1:5829",
    });
    mocks.callGateway.mockReset().mockResolvedValue({ degradedSecretOwners: [] });
    mocks.isGatewayCredentialsRequiredError.mockReset().mockReturnValue(false);
    mocks.readGatewayServiceState.mockReset().mockResolvedValue({
      installed: true,
      loadState: { status: "loaded" },
      running: true,
      env: {},
      command: { programArguments: ["openclaw", "gateway"], sourcePath: "/tmp/gateway.service" },
      runtime: { status: "running" },
    });
    mocks.resolveGatewayService.mockReset().mockReturnValue({ label: "openclaw-gateway" });
  });

  it("projects SecretRef and SQLite warnings from one authenticated read-only status RPC", async () => {
    const cfg = { gateway: { mode: "local" as const } };
    const privateToken = "SYNTHETIC_PRIVATE_URL_TOKEN";
    mocks.buildGatewayProbeConnectionDetails.mockResolvedValueOnce({
      url: "wss://127.0.0.1:5829",
      tlsFingerprint: "sha256:test-doctor-fingerprint",
      preauthHandshakeTimeoutMs: 1200,
    });
    mocks.callGateway.mockResolvedValueOnce({
      degradedSecretOwners: [
        {
          ownerKind: "account",
          ownerId: "discord:ops",
          state: "unavailable",
          paths: ["channels.discord.accounts.ops.token"],
          reason: "secret reference was not found (env:default:PRIVATE_REF_ID)",
        },
        {
          ownerKind: "capability",
          ownerId: "tts",
          state: "unavailable",
          degradationState: "stale",
          paths: ["tts.providers.elevenlabs.apiKey", "tts.providers.elevenlabs.voiceId"],
          reason: "secret provider policy denied resolution",
        },
        {
          ownerKind: "provider",
          ownerId: `vault\u001b]52;c;attack\u0007:https://user:${privateToken}@secret.test/${"a".repeat(500)}`,
          state: "unavailable",
          paths: Array.from(
            { length: 12 },
            (_, index) =>
              `providers.example.${index}.https://secret.test/value?token=${privateToken}\n${"z".repeat(400)}`,
          ),
          reason: `secret provider failed: ${privateToken}\nref PRIVATE_REF_ID`,
        },
      ],
      degradedPlugins: [{ pluginId: "not-this-check" }],
      sqliteWal: {
        state: "blocked",
        observedAtMs: 1_800_000,
        walBytes: 128 * 1024 * 1024,
        databaseBytes: 32 * 1024 * 1024,
        logFrames: 4000,
        checkpointedFrames: 100,
        lastCompletedAtMs: null,
        consecutiveBlocked: 2,
        warning: true,
      },
    });

    const findings = await collectGatewayHealthFindings({
      cfg,
      configPath: "/tmp/selected-openclaw.json",
    });

    expect(mocks.callGateway).toHaveBeenCalledExactlyOnceWith({
      method: "status",
      params: { includeChannelSummary: false },
      timeoutMs: 3000,
      sharedStateMode: "read-only",
      config: cfg,
      configPath: "/tmp/selected-openclaw.json",
      tlsFingerprint: "sha256:test-doctor-fingerprint",
      preauthHandshakeTimeoutMs: 1200,
    });
    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/gateway-health",
        severity: "warning",
        message: expect.stringContaining("cold account:discord:ops"),
        path: "channels.discord.accounts.ops.token",
        target: "account:discord:ops",
        fixHint: expect.stringContaining("openclaw secrets reload"),
      }),
      expect.objectContaining({
        checkId: "core/doctor/gateway-health",
        severity: "warning",
        message: expect.stringContaining("stale capability:tts"),
        path: "tts.providers.elevenlabs.apiKey",
        target: "capability:tts",
        fixHint: expect.stringContaining("openclaw secrets reload"),
      }),
      expect.objectContaining({
        checkId: "core/doctor/gateway-health",
        severity: "warning",
        message: expect.stringContaining("provider:vault"),
        path: expect.stringContaining("providers.example.0"),
        target: expect.stringContaining("provider:vault"),
      }),
      expect.objectContaining({
        checkId: "core/doctor/gateway-health",
        severity: "warning",
        message: expect.stringContaining("SQLite WAL: checkpoint blocked"),
        fixHint: expect.stringContaining("openclaw status --deep"),
      }),
    ]);
    expect(findings[1]?.message).toContain("tts.providers.elevenlabs.voiceId");
    const finding = findings[2];
    const rendered = JSON.stringify(findings);
    expect(finding?.message).toContain("omitted");
    expect(finding?.message).toContain("secret resolution failed");
    expect(finding?.message.length).toBeLessThanOrEqual(700);
    expect(finding?.target?.length).toBeLessThanOrEqual(150);
    expect(finding?.path?.length).toBeLessThanOrEqual(180);
    expect(rendered).not.toContain(privateToken);
    expect(rendered).not.toContain("PRIVATE_REF_ID");
    expect(rendered).not.toContain("not-this-check");
    expect(rendered).not.toContain("\u001b");
    expect(rendered).not.toContain("\u0007");
  });

  it.each([
    {
      label: "missing Gateway authentication",
      error: new Error("auth token SYNTHETIC_PRIVATE_TOKEN\nref PRIVATE_REF_ID"),
      credentialsRequired: true,
      message:
        "Gateway status could not be inspected because this CLI has no usable token/password or paired device token for read-scope RPCs.",
      fixHint:
        "Configure the Gateway token/password or pair this device, then rerun the selected health check.",
    },
    {
      label: "an unreachable Gateway with terminal control characters",
      error: new Error("connect ECONNREFUSED 127.0.0.1:5829\u001b]52;c;attack\u0007\u009b"),
      credentialsRequired: false,
      message: "Gateway status could not be inspected: connect ECONNREFUSED 127.0.0.1:5829",
      fixHint:
        "Inspect the service with `openclaw gateway status --deep`, or run `openclaw doctor` for guided checks.",
    },
  ])("reports $label from exactly one sanitized status attempt", async (entry) => {
    mocks.callGateway.mockRejectedValueOnce(entry.error);
    mocks.isGatewayCredentialsRequiredError.mockReturnValueOnce(entry.credentialsRequired);

    const findings = await collectGatewayHealthFindings({ cfg: { gateway: { mode: "local" } } });

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/gateway-health",
        severity: "warning",
        message: entry.message,
        path: "gateway.mode",
        target: "http://127.0.0.1:5829",
        fixHint: entry.fixHint,
      }),
    ]);
    expect(JSON.stringify(findings)).not.toContain("SYNTHETIC_PRIVATE_TOKEN");
    expect(JSON.stringify(findings)).not.toContain("PRIVATE_REF_ID");
    expect(mocks.callGateway).toHaveBeenCalledOnce();
  });

  it("reports preparation failures without exposing URL credentials or control characters", async () => {
    mocks.buildGatewayProbeConnectionDetails.mockRejectedValueOnce(
      new Error(
        `invalid wss://user:${"SYNTHETIC_PRIVATE_TOKEN".repeat(20)}@gateway.test/rpc\nmore`,
      ),
    );

    const findings = await collectGatewayHealthFindings({ cfg: {} });

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        message: expect.stringContaining("Gateway health inspection could not be prepared"),
        path: "gateway",
      }),
    ]);
    expect(JSON.stringify(findings)).not.toContain("SYNTHETIC_PRIVATE_TOKEN");
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("prepares the target but skips the RPC for active exec credentials unless execution is allowed", async () => {
    const cfg = {
      gateway: {
        mode: "local" as const,
        auth: {
          mode: "token" as const,
          token: { source: "exec" as const, provider: "vault", id: "PRIVATE_REF_ID" },
        },
      },
    };

    const findings = await collectGatewayHealthFindings({ cfg, env: {} });

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/gateway-health",
        severity: "warning",
        message: expect.stringContaining("intentionally skipped"),
        fixHint:
          "Rerun `openclaw doctor --lint --only core/doctor/gateway-health --allow-exec` to permit configured secret execution.",
      }),
    ]);
    expect(JSON.stringify(findings)).not.toContain("PRIVATE_REF_ID");
    expect(mocks.buildGatewayProbeConnectionDetails).toHaveBeenCalledOnce();
    expect(mocks.callGateway).not.toHaveBeenCalled();

    await expect(
      collectGatewayHealthFindings({ cfg, env: {}, allowExecSecretRefs: true }),
    ).resolves.toEqual([]);
    expect(mocks.callGateway).toHaveBeenCalledOnce();
  });

  it("redacts sensitive remote gateway URLs from health finding targets", async () => {
    mocks.buildGatewayProbeConnectionDetails.mockResolvedValueOnce({
      url: "wss://user:pass@gateway.example.test/rpc?token=secret&safe=value",
    });
    mocks.callGateway.mockRejectedValueOnce(new Error("remote gateway did not answer"));

    const findings = await collectGatewayHealthFindings({
      cfg: { gateway: { mode: "remote", remote: { url: "wss://gateway.example.test/rpc" } } },
    });

    expect(findings).toContainEqual({
      checkId: "core/doctor/gateway-health",
      severity: "warning",
      message: "Gateway status could not be inspected: remote gateway did not answer",
      path: "gateway.remote.url",
      target: "wss://***:***@gateway.example.test/rpc?token=***&safe=value",
      fixHint: "Verify the remote Gateway URL, network path, TLS settings, and credentials.",
    });
    expect(JSON.stringify(findings)).not.toContain("user:pass");
    expect(JSON.stringify(findings)).not.toContain("token=secret");
  });

  it.each([
    {
      label: "missing",
      installed: false,
      loadState: "not-loaded",
      runtimeStatus: "stopped",
      message: "Gateway service is not installed.",
      path: "gateway.mode",
      fixHint: "Run `openclaw gateway install` to install the service.",
    },
    {
      label: "installed but not loaded",
      installed: true,
      loadState: "not-loaded",
      runtimeStatus: "stopped",
      message: "Gateway service is installed but not loaded.",
      path: "/tmp/gateway.service",
      fixHint: "Start the installed service with `openclaw gateway start`.",
    },
    {
      label: "loaded with unconfirmed runtime",
      installed: true,
      loadState: "loaded",
      runtimeStatus: "unknown",
      message: "Gateway service runtime is unknown, not running.",
      path: "/tmp/gateway.service",
      fixHint:
        "Run `openclaw gateway status --deep` to inspect the service before choosing a recovery action.",
    },
  ])("reports actionable advice for a $label local gateway daemon", async (entry) => {
    mocks.readGatewayServiceState.mockResolvedValueOnce({
      installed: entry.installed,
      loadState: { status: entry.loadState },
      running: false,
      env: {},
      command: entry.installed
        ? { programArguments: ["openclaw", "gateway"], sourcePath: "/tmp/gateway.service" }
        : null,
      runtime: { status: entry.runtimeStatus },
    });

    await expect(
      collectGatewayDaemonFindings({ cfg: { gateway: { mode: "local" } } }),
    ).resolves.toEqual([
      {
        checkId: "core/doctor/gateway-daemon",
        severity: "warning",
        message: entry.message,
        path: entry.path,
        target: "openclaw-gateway",
        fixHint: entry.fixHint,
      },
    ]);
  });

  it("skips daemon findings for remote gateway mode", async () => {
    await expect(
      collectGatewayDaemonFindings({ cfg: { gateway: { mode: "remote" } } }),
    ).resolves.toEqual([]);

    expect(mocks.readGatewayServiceState).not.toHaveBeenCalled();
  });

  it.each([
    { version: "26.8.1", text: false, status: "unsupported" as const, severity: "warning" },
    { version: "24.15.0", text: true, status: "supported" as const, severity: "info" },
  ])(
    "reports recorded Node $version capabilities as $severity",
    async ({ version, text, status, severity }) => {
      const message = text
        ? `Node ${version}: unsupported version, capability probe passed.`
        : `Node ${version}: node:sqlite truncates TEXT at embedded NUL (nodejs/node#61954)`;
      mocks.readGatewayServiceState.mockResolvedValueOnce({
        installed: true,
        loadState: { status: "loaded" },
        running: true,
        env: {},
        command: {
          programArguments: ["/opt/runtime/bin/node", "gateway"],
          sourcePath: "/tmp/gateway.service",
        },
        runtime: { status: "running" },
      });
      mocks.resolveNodeRuntimeInfo.mockResolvedValue({
        status,
        version,
        sqliteVersion: "3.53.4",
        sqliteProbe: { available: true, version: "3.53.4", text, blob: true, json: true },
        nodeSharedSqlite: false,
        ...(text ? { note: message } : { capabilityError: message }),
      });

      await expect(
        collectGatewayDaemonFindings({ cfg: { gateway: { mode: "local" } } }),
      ).resolves.toEqual([
        expect.objectContaining({
          checkId: "core/doctor/gateway-daemon",
          severity,
          message,
          target: "/opt/runtime/bin/node",
          ...(severity === "warning" ? { fixHint: expect.stringContaining("nvm install 26") } : {}),
        }),
      ]);
    },
  );

  it("skips host-service findings for a container without an OpenClaw service", async () => {
    mocks.isContainerEnvironment.mockReturnValue(true);

    await expect(
      collectGatewayDaemonFindings({ cfg: { gateway: { mode: "local" } } }),
    ).resolves.toEqual([]);

    expect(mocks.readGatewayServiceState).not.toHaveBeenCalled();
  });
});

function mockProviderCatalog(staticCatalog: Record<string, unknown>) {
  mocks.resolvePluginProvidersCore.mockReturnValueOnce([
    { id: "mockplugin", pluginId: "mockplugin", label: "Mock", auth: [], staticCatalog },
  ]);
}

function expectCatalogFinding(
  findings: readonly HealthFinding[],
  requirement: string,
  target = "mockplugin",
) {
  expect(findings).toContainEqual(
    expect.objectContaining({
      checkId: "core/doctor/provider-catalog-projection",
      severity: "error",
      path: "plugins.entries.mockplugin",
      target,
      requirement,
    }),
  );
}

describe("doctor provider catalog projection checks", () => {
  beforeEach(() => {
    mocks.resolvePluginProvidersCore.mockReset().mockReturnValue([]);
  });

  it.each([
    {
      name: "model name",
      result: { provider: { models: [{ id: "mock-model", name: { label: "Mock" } }] } },
      requirement: "model name must be a string when present",
    },
    {
      name: "model list",
      result: { provider: { models: {} } },
      requirement: "models must be an array",
    },
    {
      name: "missing provider containers",
      result: { providers: undefined },
      requirement: "result must include provider or providers object",
    },
    {
      name: "provider key",
      result: { providers: { " ": { models: [{ id: "mock-model" }] } } },
      requirement: "provider key must be a non-empty trimmed string",
    },
    { name: "non-object result", result: false, requirement: "result must be an object" },
    {
      name: "present single-provider branch",
      result: {
        provider: undefined,
        providers: { mockplugin: { models: [{ id: "mock-model" }] } },
      },
      requirement: "provider must be an object",
    },
  ])("reports an invalid $name", async ({ result, requirement }) => {
    mockProviderCatalog({ order: "simple", run: async () => result });
    expectCatalogFinding(await collectProviderCatalogProjectionFindings({}), requirement);
  });

  it("reports an unreadable provider beside a healthy provider", async () => {
    const providers = {
      healthy: { models: [{ id: "healthy-model", name: "Healthy Model" }] },
      get broken() {
        throw new Error("provider catalog entry read failed");
      },
    };
    mockProviderCatalog({ order: "simple", run: async () => ({ providers }) });
    expectCatalogFinding(
      await collectProviderCatalogProjectionFindings({}),
      "provider catalog entry read failed",
      "broken",
    );
  });

  it("reports model lists with invalid iterators", async () => {
    const models = [{ id: "mock-model" }];
    Object.defineProperty(models, Symbol.iterator, {
      value: () => {
        throw new Error("model iterator failed");
      },
    });
    mockProviderCatalog({ order: "simple", run: async () => ({ provider: { models } }) });
    expectCatalogFinding(
      await collectProviderCatalogProjectionFindings({}),
      "model iterator failed",
    );
  });

  it("validates model rows after an invalid order through the registered catalog check", async () => {
    mockProviderCatalog({
      order: "middle",
      run: async () => ({ providers: { mockplugin: { models: [{ id: " " }] } } }),
    });
    const check = createCoreHealthChecks().find(
      (entry) => entry.id === "core/doctor/provider-catalog-projection",
    );
    expect(check).toBeDefined();
    const findings = await check!.detect({
      mode: "lint",
      runtime: { log() {}, error() {}, exit() {} },
      cfg: {},
    });
    expectCatalogFinding(findings, "order must be simple, profile, paired, or late");
    expectCatalogFinding(findings, "model id must be a non-empty trimmed string");
  });

  it.each([
    {
      catalog: {
        order: "simple",
        get run() {
          throw new Error("run getter failed");
        },
      },
      requirement: "run getter failed",
    },
    {
      catalog: { order: "simple", run: "not-callable" },
      requirement: "static catalog run must be a function",
    },
  ])("reports an unreadable static hook: $requirement", async ({ catalog, requirement }) => {
    mockProviderCatalog(catalog);
    expectCatalogFinding(await collectProviderCatalogProjectionFindings({}), requirement);
  });

  it("reports revoked result proxies at the hook boundary", async () => {
    const { proxy, revoke } = Proxy.revocable({ providers: {} }, {});
    revoke();
    // Promise resolution reads "then", so this fails before result-key inspection.
    mockProviderCatalog({ order: "simple", run: async () => proxy });
    expect(await collectProviderCatalogProjectionFindings({})).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message: "Provider catalog mockplugin failed during doctor validation.",
        requirement: expect.stringMatching(/proxy.*revoked/iu),
      }),
    );
  });
});
