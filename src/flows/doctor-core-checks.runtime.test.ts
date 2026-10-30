import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { collectGatewayHealthFindings } from "../commands/doctor-gateway-health.js";
import { createSqliteWalHealth } from "../commands/sqlite-wal-health.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { createCoreHealthChecks } from "./doctor-core-checks.js";
import { exitCodeFromFindings } from "./doctor-lint-flow.js";
import type { HealthFinding } from "./health-checks.js";

const mocks = vi.hoisted(() => {
  const handles = {
    mcpRuntime: vi.fn(),
    codingTools: vi.fn(),
    disposeMcp: vi.fn(),
    catalog: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
    normalizeTools: vi.fn(),
    connectionDetails: vi.fn(),
    callGateway: vi.fn(),
    credentialsRequired: vi.fn(),
    container: vi.fn(() => false),
    serviceState: vi.fn(),
    nodeInfo: vi.fn<typeof import("../daemon/runtime-paths.js").resolveNodeRuntimeInfo>(),
    gatewayService: vi.fn(() => ({ label: "openclaw-gateway" })),
    providers: vi.fn((): Array<Record<string, unknown>> => []),
    defaultModel: vi.fn(() => ({ provider: "openai", model: "gpt-5.5" })),
    metadataScopes: [] as AsyncDisposable[],
  };
  const replacements = {
    "../agents/model-catalog.js": {
      findModelInCatalog: (
        catalog: Array<{ provider?: string; id?: string }>,
        provider: string,
        modelId: string,
      ) => catalog.find((entry) => entry.provider === provider && entry.id === modelId),
    },
    "../agents/prepared-model-catalog.js": {
      loadProviderScopedThinkingCatalog: vi.fn(async () => []),
      readPreparedModelCatalog: handles.catalog,
    },
    "../agents/agent-bundle-mcp-tools.js": { createBundleMcpToolRuntime: handles.mcpRuntime },
    "../agents/agent-tools.js": { createOpenClawCodingTools: handles.codingTools },
    "../gateway/call.js": {
      buildGatewayProbeConnectionDetails: handles.connectionDetails,
      callGateway: handles.callGateway,
      isGatewayCredentialsRequiredError: handles.credentialsRequired,
    },
    "../daemon/service.js": {
      readGatewayServiceState: handles.serviceState,
      resolveGatewayService: handles.gatewayService,
    },
    "../infra/container-environment.js": { isContainerEnvironment: handles.container },
    "../daemon/systemd.js": {
      findInstalledSystemdGatewayScope: vi
        .fn<typeof import("../daemon/systemd.js").findInstalledSystemdGatewayScope>()
        .mockResolvedValue(null),
    },
    "../plugins/provider-runtime.js": {
      inspectProviderToolSchemasWithPlugin: () => [],
      normalizeProviderToolSchemasWithPlugin: handles.normalizeTools,
    },
    "../plugins/providers.runtime.js": { resolvePluginProvidersCore: handles.providers },
  };
  for (const [module, exports] of Object.entries(replacements)) {
    vi.doMock(module, () => exports);
  }
  const partials = {
    "../agents/model-selection.js": { resolveDefaultModelForAgent: handles.defaultModel },
    "../daemon/runtime-paths.js": { resolveNodeRuntimeInfo: handles.nodeInfo },
  };
  for (const [module, overrides] of Object.entries(partials)) {
    vi.doMock(module, async (original) => ({ ...(await original<object>()), ...overrides }));
  }
  return handles;
});
vi.mock("../commands/doctor/shared/plugin-metadata-snapshot-scope.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../commands/doctor/shared/plugin-metadata-snapshot-scope.js")
    >();
  return {
    ...actual,
    createDoctorPluginMetadataSnapshotScope: (
      params: Parameters<typeof actual.createDoctorPluginMetadataSnapshotScope>[0],
    ) => {
      const scope = actual.createDoctorPluginMetadataSnapshotScope(params);
      vi.spyOn(scope, Symbol.asyncDispose);
      mocks.metadataScopes.push(scope);
      return scope;
    },
  };
});

const {
  collectGatewayDaemonFindings: inspectDaemon,
  collectProviderCatalogProjectionFindings: inspectCatalog,
} = await import("./doctor-core-checks.runtime.js");
const { collectRuntimeToolSchemaFindings: inspectSchemas } =
  await import("./doctor-tool-schema-runtime.js");

const objectSchema = { type: "object", properties: {} };
const arraySchema = { type: "array", items: { type: "number" } };
const runtime = { log() {}, error() {}, exit() {} };
const localConfig: OpenClawConfig = { gateway: { mode: "local" } };
const invalidMcpSchema = 'tools[0].inputSchema.type: Invalid input: expected "object"';

function agentConfig(...ids: string[]) {
  return {
    agents: {
      entries: Object.fromEntries(ids.map((id) => [id, { workspace: `/tmp/${id}-workspace` }])),
    },
  };
}

function gatewayHealth(cfg: OpenClawConfig = localConfig) {
  return collectGatewayHealthFindings({ cfg });
}

function expectBundleCall(expected: Record<string, unknown>) {
  expect(mocks.mcpRuntime).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(expected));
}

function expectNoText(value: unknown, ...privateValues: string[]) {
  const serialized = JSON.stringify(value);
  for (const privateValue of privateValues) {
    expect(serialized).not.toContain(privateValue);
  }
}

function tool(name: string, parameters: unknown): AnyAgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters,
    execute: async () => ({ text: "ok" }),
  } as unknown as AnyAgentTool;
}

function bundleRuntime(tools: AnyAgentTool[]) {
  return { tools, dispose: mocks.disposeMcp };
}

function bundleMcpTool(name: string, parameters: unknown): AnyAgentTool {
  const entry = tool(name, parameters);
  setPluginToolMeta(entry, { pluginId: "bundle-mcp", optional: false });
  return entry;
}

function mcpConfig(serverName = "fuzzplugin") {
  return mcpServers({ [serverName]: { command: "node", args: ["fuzzplugin-mcp.mjs"] } });
}

function mcpServers(servers: NonNullable<OpenClawConfig["mcp"]>["servers"]) {
  return { mcp: { servers } };
}

function mockBundleDiagnostic(serverName = "fuzzplugin") {
  mocks.mcpRuntime.mockReturnValueOnce({
    tools: [],
    diagnostics: [
      {
        serverName,
        safeServerName: serverName,
        launchSummary: "node fuzzplugin-mcp.mjs",
        message: invalidMcpSchema,
      },
    ],
    dispose: mocks.disposeMcp,
  });
}

function findingMatching(
  check: string,
  severity: HealthFinding["severity"],
  expected: Partial<HealthFinding>,
) {
  return expect.objectContaining({ checkId: `core/doctor/${check}`, severity, ...expected });
}

function expectSchemaError(findings: readonly HealthFinding[], expected: Partial<HealthFinding>) {
  expect(findings).toContainEqual(findingMatching("runtime-tool-schemas", "error", expected));
}

describe("doctor runtime tool schema checks", () => {
  beforeEach(() => {
    mocks.metadataScopes.length = 0;
    mocks.codingTools.mockReset().mockReturnValue([]);
    mocks.mcpRuntime.mockReset().mockReturnValue(bundleRuntime([]));
    mocks.disposeMcp.mockReset().mockReturnValue(undefined);
    mocks.catalog.mockClear();
    mocks.normalizeTools.mockReset().mockImplementation(({ context }) => context.tools);
    mocks.providers.mockReset().mockReturnValue([]);
    mocks.defaultModel.mockClear();
  });

  afterEach(() => {
    for (const scope of mocks.metadataScopes) {
      expect(scope[Symbol.asyncDispose]).toHaveBeenCalledOnce();
    }
  });

  it("releases its metadata scope when inspection preparation returns early", async () => {
    const tools = await import("../plugins/tools.js");
    const acquire = vi.spyOn(tools, "acquirePluginToolInspectionRegistry");
    const failure = new Error("Inspection preparation failed");
    await acquire.withImplementation(
      async () => {
        throw failure;
      },
      async () => {
        await expect(inspectSchemas({})).resolves.toContainEqual(
          expect.objectContaining({ severity: "warning", requirement: failure.message }),
        );
      },
    );
    acquire.mockRestore();
  });

  it("leaves a supplied metadata scope with its caller", async () => {
    const { createDoctorPluginMetadataSnapshotScope } =
      await import("../commands/doctor/shared/plugin-metadata-snapshot-scope.js");
    await using scope = createDoctorPluginMetadataSnapshotScope({});
    await inspectSchemas({}, { runWithPluginMetadataSnapshot: scope.run });
    expect(mocks.metadataScopes).toHaveLength(1);
    expect(scope[Symbol.asyncDispose]).not.toHaveBeenCalled();
  });

  it("reports active bundle MCP schemas before a model turn", async () => {
    mocks.mcpRuntime.mockReturnValueOnce(
      bundleRuntime([
        bundleMcpTool("fuzzplugin__healthy", objectSchema),
        bundleMcpTool("fuzzplugin__move_angles", arraySchema),
      ]),
    );
    expectSchemaError(await inspectSchemas(mcpConfig()), {
      path: "mcp.servers",
      target: "fuzzplugin__move_angles",
      requirement: 'fuzzplugin__move_angles.parameters.type must be "object"',
      message: expect.stringContaining(
        "Agent main tool fuzzplugin__move_angles from plugin bundle-mcp",
      ),
    });
    expect(mocks.disposeMcp).toHaveBeenCalledTimes(1);
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
      expect(mocks.mcpRuntime).not.toHaveBeenCalled();
      expect(mocks.codingTools).toHaveBeenCalledTimes(2);
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
    mocks.catalog.mockResolvedValueOnce([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
        ...transport,
        compat: { supportsTools: true },
      },
    ]);
    mocks.codingTools.mockReturnValueOnce([tool("healthy", objectSchema)]);
    await inspectSchemas({});
    expect(mocks.normalizeTools).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          modelApi: transport.api,
          model: expect.objectContaining(transport),
        }),
      }),
    );
  });

  it.each([
    ["cleanup failure", "fuzzplugin", undefined, true, false],
    ["explicit allowlist", "my__server", "my__server__healthy", false, false],
    ["wildcard allowlist", "fuzzplugin", "*__healthy", false, false],
    ["shared workspaces", "fuzzplugin", undefined, false, true],
  ] as const)(
    "preserves MCP diagnostics with %s",
    async (_label, server, allowed, cleanup, shared) => {
      if (cleanup) {
        mocks.disposeMcp.mockRejectedValueOnce(
          new Error("MCP runtime cleanup could not confirm closure"),
        );
      }
      mockBundleDiagnostic(server);
      const findings = await inspectSchemas({
        ...mcpConfig(server),
        ...(allowed ? { tools: { allow: [allowed] } } : {}),
        ...(shared ? agentConfig("main", "worker") : {}),
      });
      const expected = findingMatching("runtime-tool-schemas", "error", {
        path: `mcp.servers.${server}`,
        requirement: invalidMcpSchema,
      });
      if (shared) {
        expect(findings).toEqual([expected]);
        expectBundleCall({ workspaceDir: expect.stringContaining("main-workspace") });
      } else {
        expect(findings).toContainEqual(expected);
      }
      if (cleanup) {
        expectSchemaError(findings, {
          path: "mcp.servers",
          requirement: "MCP runtime cleanup could not confirm closure",
          fixHint: "Inspect or stop the configured MCP server processes, then rerun doctor.",
        });
      }
      expect(mocks.disposeMcp).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])("inspects only embedded-agent catalogs (ACP=%s)", async (acp) => {
    const workerId = acp ? "acp-worker" : "worker";
    const workspaceName = acp ? "main-workspace" : "shared-workspace";
    const workspace = `/tmp/${workspaceName}`;
    mocks.codingTools.mockImplementation((options) =>
      options?.agentId === workerId
        ? [tool("fuzzplugin_move_angles", arraySchema)]
        : [tool("healthy", objectSchema)],
    );
    const findings = await inspectSchemas({
      agents: {
        entries: {
          main: { workspace },
          [workerId]: {
            workspace: acp ? "/tmp/acp-workspace" : workspace,
            ...(acp ? { runtime: { type: "acp" as const } } : {}),
          },
        },
      },
    });
    if (acp) {
      expect(findings).toEqual([]);
    } else {
      expectSchemaError(findings, {
        path: "tools.fuzzplugin_move_angles",
        target: "fuzzplugin_move_angles",
        message: expect.stringContaining("Agent worker tool fuzzplugin_move_angles"),
        requirement: 'fuzzplugin_move_angles.parameters.type must be "object"',
      });
    }
    const inspected = acp ? ["main"] : ["main", workerId];
    expect(mocks.codingTools).toHaveBeenCalledTimes(inspected.length);
    for (const [index, agentId] of inspected.entries()) {
      expect(mocks.codingTools).toHaveBeenCalledWith(expect.objectContaining({ agentId }));
      expect(mocks.catalog).toHaveBeenNthCalledWith(
        index + 1,
        expect.objectContaining({ agentId, readOnly: true, providerDiscoveryProviderIds: [] }),
      );
    }
    expect(mocks.catalog).toHaveBeenCalledTimes(inspected.length);
    expectBundleCall({ workspaceDir: expect.stringContaining(workspaceName) });
    expect(mocks.disposeMcp).toHaveBeenCalledTimes(1);
  });

  it("defers shared OAuth without suppressing non-OAuth probes", async () => {
    const findings = await inspectSchemas({
      ...agentConfig("main", "worker"),
      ...mcpServers({
        authenticated: {
          url: "https://oauth.example.test/mcp",
          transport: "streamable-http",
          auth: "oauth",
          oauth: { authProfileId: "provider:default" },
        },
        public: { url: "https://public.example.test/mcp", transport: "sse" },
        local: { command: "fixture-mcp" },
      }),
    });
    expect(findings).toEqual([
      expect.objectContaining({
        severity: "info",
        path: "mcp.servers.authenticated",
        message: expect.stringContaining("OAuth may rotate external credentials"),
        fixHint: expect.stringContaining("openclaw mcp probe"),
      }),
    ]);
    expectBundleCall({ excludeServerNames: new Set(["authenticated"]) });
    expect(mocks.disposeMcp).toHaveBeenCalledTimes(1);
  });

  it("filters MCP diagnostics through server-level deny policy", async () => {
    mockBundleDiagnostic();
    await expect(
      inspectSchemas({
        tools: { deny: ["fuzzplugin__*"] },
        ...mcpConfig(),
      }),
    ).resolves.toEqual([]);
  });

  it.each([
    ["load", "", false],
    ["normalize", "fuzzplugin_move_angles", false],
    ["normalize", "fuzzplugin__move_angles", true],
  ] as const)("reports %s errors for %s", async (phase, toolName, mcp) => {
    const error = new Error(`fuzzplugin ${phase} failed`);
    if (phase === "load") {
      mocks.codingTools.mockImplementationOnce(() => {
        throw error;
      });
    } else {
      if (mcp) {
        mocks.mcpRuntime.mockResolvedValueOnce(
          bundleRuntime([bundleMcpTool(toolName, objectSchema)]),
        );
      } else {
        mocks.codingTools.mockReturnValueOnce([tool(toolName, objectSchema)]);
      }
      mocks.normalizeTools.mockImplementation(({ context }) => {
        const tools: AnyAgentTool[] = context.tools;
        if (tools.some((entry) => entry.name === toolName)) {
          throw error;
        }
        return tools;
      });
    }
    expectSchemaError(await inspectSchemas({}), {
      path: mcp ? "mcp.servers" : "agents.main.tools",
      message: `${mcp ? "Configured MCP" : "Agent main runtime"} tool schema validation could not ${phase} the runtime tool set.`,
      requirement: error.message,
    });
    expect(mocks.mcpRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.disposeMcp).toHaveBeenCalledTimes(1);
  });
});

function runningService(executable = "openclaw") {
  return {
    installed: true,
    loadState: { status: "loaded" },
    running: true,
    env: {},
    command: { programArguments: [executable, "gateway"], sourcePath: "/tmp/gateway.service" },
    runtime: { status: "running" },
  };
}

describe("doctor gateway runtime checks", () => {
  beforeEach(() => {
    mocks.nodeInfo.mockReset().mockResolvedValue({
      status: "supported",
      version: "26.8.1",
      sqliteVersion: "3.53.4",
      sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
      nodeSharedSqlite: false,
    });
    mocks.container.mockReset().mockReturnValue(false);
    mocks.connectionDetails.mockReset().mockResolvedValue({
      url: "http://127.0.0.1:5829",
    });
    mocks.callGateway.mockReset().mockResolvedValue({ degradedSecretOwners: [] });
    mocks.credentialsRequired.mockReset().mockReturnValue(false);
    mocks.serviceState.mockReset().mockResolvedValue(runningService());
    mocks.gatewayService.mockReset().mockReturnValue({ label: "openclaw-gateway" });
  });

  it("projects SecretRef and SQLite warnings from one authenticated read-only status RPC", async () => {
    const cfg = localConfig;
    const privateToken = "SYNTHETIC_PRIVATE_URL_TOKEN";
    mocks.connectionDetails.mockResolvedValueOnce({
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
      sqliteWal: createSqliteWalHealth(),
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
      findingMatching("gateway-health", "warning", {
        message: expect.stringContaining("cold account:discord:ops"),
        path: "channels.discord.accounts.ops.token",
        target: "account:discord:ops",
        fixHint: expect.stringContaining("openclaw secrets reload"),
      }),
      findingMatching("gateway-health", "warning", {
        message: expect.stringContaining("stale capability:tts"),
        path: "tts.providers.elevenlabs.apiKey",
        target: "capability:tts",
        fixHint: expect.stringContaining("openclaw secrets reload"),
      }),
      findingMatching("gateway-health", "warning", {
        message: expect.stringContaining("provider:vault"),
        path: expect.stringContaining("providers.example.0"),
        target: expect.stringContaining("provider:vault"),
      }),
      findingMatching("gateway-health", "warning", {
        message: expect.stringContaining("SQLite WAL: checkpoint blocked"),
        fixHint: expect.stringContaining("openclaw status --deep"),
      }),
    ]);
    expect(findings[1]?.message).toContain("tts.providers.elevenlabs.voiceId");
    const finding = findings[2];
    expect(finding?.message).toContain("omitted");
    expect(finding?.message).toContain("secret resolution failed");
    expect(finding?.message.length).toBeLessThanOrEqual(700);
    expect(finding?.target?.length).toBeLessThanOrEqual(150);
    expect(finding?.path?.length).toBeLessThanOrEqual(180);
    expectNoText(findings, privateToken, "PRIVATE_REF_ID", "not-this-check", "\u001b", "\u0007");
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
    mocks.credentialsRequired.mockReturnValueOnce(entry.credentialsRequired);

    const findings = await gatewayHealth();

    expect(findings).toEqual([
      findingMatching("gateway-health", "warning", {
        message: entry.message,
        path: "gateway.mode",
        target: "http://127.0.0.1:5829",
        fixHint: entry.fixHint,
      }),
    ]);
    expectNoText(findings, "SYNTHETIC_PRIVATE_TOKEN", "PRIVATE_REF_ID");
    expect(mocks.callGateway).toHaveBeenCalledOnce();
  });

  it("reports preparation failures without exposing URL credentials or control characters", async () => {
    mocks.connectionDetails.mockRejectedValueOnce(
      new Error(
        `invalid wss://user:${"SYNTHETIC_PRIVATE_TOKEN".repeat(20)}@gateway.test/rpc\nmore`,
      ),
    );

    const findings = await gatewayHealth({});

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        message: expect.stringContaining("Gateway health inspection could not be prepared"),
        path: "gateway",
      }),
    ]);
    expectNoText(findings, "SYNTHETIC_PRIVATE_TOKEN");
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
      findingMatching("gateway-health", "warning", {
        message: expect.stringContaining("intentionally skipped"),
        fixHint:
          "Rerun `openclaw doctor --lint --only core/doctor/gateway-health --allow-exec` to permit configured secret execution.",
      }),
    ]);
    expectNoText(findings, "PRIVATE_REF_ID");
    expect(mocks.connectionDetails).toHaveBeenCalledOnce();
    expect(mocks.callGateway).not.toHaveBeenCalled();

    await expect(
      collectGatewayHealthFindings({ cfg, env: {}, allowExecSecretRefs: true }),
    ).resolves.toEqual([]);
    expect(mocks.callGateway).toHaveBeenCalledOnce();
  });

  it("redacts sensitive remote gateway URLs from health finding targets", async () => {
    mocks.connectionDetails.mockResolvedValueOnce({
      url: "wss://user:pass@gateway.example.test/rpc?token=secret&safe=value",
    });
    mocks.callGateway.mockRejectedValueOnce(new Error("remote gateway did not answer"));

    const findings = await gatewayHealth({
      gateway: { mode: "remote", remote: { url: "wss://gateway.example.test/rpc" } },
    });

    expect(findings).toContainEqual({
      checkId: "core/doctor/gateway-health",
      severity: "warning",
      message: "Gateway status could not be inspected: remote gateway did not answer",
      path: "gateway.remote.url",
      target: "wss://***:***@gateway.example.test/rpc?token=***&safe=value",
      fixHint: "Verify the remote Gateway URL, network path, TLS settings, and credentials.",
    });
    expectNoText(findings, "user:pass", "token=secret");
  });

  it.each([
    [
      "missing",
      "Gateway service is not installed.",
      "Run `openclaw gateway install` to install the service.",
    ],
    [
      "unloaded",
      "Gateway service is installed but not loaded.",
      "Start the installed service with `openclaw gateway start`.",
    ],
    [
      "unconfirmed",
      "Gateway service runtime is unknown, not running.",
      "Run `openclaw gateway status --deep` to inspect the service before choosing a recovery action.",
    ],
  ])("reports actionable advice for a %s local gateway daemon", async (state, message, fixHint) => {
    const installed = state !== "missing";
    mocks.serviceState.mockResolvedValueOnce({
      ...runningService(),
      installed,
      loadState: { status: state === "unconfirmed" ? "loaded" : "not-loaded" },
      running: false,
      command: installed ? runningService().command : null,
      runtime: { status: state === "unconfirmed" ? "unknown" : "stopped" },
    });

    expect(await inspectDaemon({ cfg: localConfig })).toEqual([
      {
        checkId: "core/doctor/gateway-daemon",
        severity: "warning",
        message,
        path: installed ? "/tmp/gateway.service" : "gateway.mode",
        target: "openclaw-gateway",
        fixHint,
      },
    ]);
  });

  it.each([
    { version: "26.12.1", text: false, status: "unsupported" as const },
    { version: "24.22.1", text: true, status: "supported" as const },
  ])(
    "reports only failing recorded Node $version capabilities",
    async ({ version, text, status }) => {
      const message = `Node ${version}: node:sqlite truncates TEXT at embedded NUL (nodejs/node#61954)`;
      mocks.serviceState.mockResolvedValueOnce(runningService("/opt/runtime/bin/node"));
      mocks.nodeInfo.mockResolvedValue({
        status,
        version,
        sqliteVersion: "3.53.4",
        sqliteProbe: { available: true, version: "3.53.4", text, blob: true, json: true },
        nodeSharedSqlite: false,
        ...(!text ? { capabilityError: message } : {}),
      });

      expect(await inspectDaemon({ cfg: localConfig })).toEqual(
        text
          ? []
          : [
              expect.objectContaining({
                checkId: "core/doctor/gateway-daemon",
                severity: "warning",
                message,
                target: "/opt/runtime/bin/node",
                fixHint: expect.stringContaining("nvm install 26"),
              }),
            ],
      );
    },
  );

  it("skips host-service findings for a container without an OpenClaw service", async () => {
    mocks.container.mockReturnValue(true);

    expect(await inspectDaemon({ cfg: localConfig })).toEqual([]);

    expect(mocks.serviceState).not.toHaveBeenCalled();
  });
});

function mockProviderCatalog(staticCatalog: Record<string, unknown>) {
  mocks.providers.mockReturnValueOnce([
    { id: "mockplugin", pluginId: "mockplugin", label: "Mock", auth: [], staticCatalog },
  ]);
}

function expectCatalogFinding(
  findings: readonly HealthFinding[],
  requirement: string,
  target = "mockplugin",
) {
  expect(findings).toContainEqual(
    findingMatching("provider-catalog-projection", "error", {
      path: "plugins.entries.mockplugin",
      target,
      requirement,
    }),
  );
}

describe("doctor provider catalog projection checks", () => {
  beforeEach(() => {
    mocks.providers.mockReset().mockReturnValue([]);
  });

  it.each([
    [
      { provider: { models: [{ id: "mock-model", name: {} }] } },
      "model name must be a string when present",
    ],
    [{ provider: { models: {} } }, "models must be an array"],
    [{ providers: undefined }, "result must include provider or providers object"],
    [
      { providers: { " ": { models: [{ id: "mock-model" }] } } },
      "provider key must be a non-empty trimmed string",
    ],
    [false, "result must be an object"],
    [
      { provider: undefined, providers: { mockplugin: { models: [{ id: "mock-model" }] } } },
      "provider must be an object",
    ],
  ] as const)("rejects %j: %s", async (result, requirement) => {
    mockProviderCatalog({ order: "simple", run: async () => result });
    expectCatalogFinding(await inspectCatalog({}), requirement);
  });

  it("reports an unreadable provider beside a healthy provider", async () => {
    const providers = {
      healthy: { models: [{ id: "healthy-model", name: "Healthy Model" }] },
      get broken() {
        throw new Error("provider catalog entry read failed");
      },
    };
    mockProviderCatalog({ order: "simple", run: async () => ({ providers }) });
    expectCatalogFinding(await inspectCatalog({}), "provider catalog entry read failed", "broken");
  });

  it("reports model lists with invalid iterators", async () => {
    const models = [{ id: "mock-model" }];
    Object.defineProperty(models, Symbol.iterator, {
      value: () => {
        throw new Error("model iterator failed");
      },
    });
    mockProviderCatalog({ order: "simple", run: async () => ({ provider: { models } }) });
    expectCatalogFinding(await inspectCatalog({}), "model iterator failed");
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
      runtime,
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
    expectCatalogFinding(await inspectCatalog({}), requirement);
  });

  it("reports revoked result proxies at the hook boundary", async () => {
    const { proxy, revoke } = Proxy.revocable({ providers: {} }, {});
    revoke();
    // Promise resolution reads "then", so this fails before result-key inspection.
    mockProviderCatalog({ order: "simple", run: async () => proxy });
    expect(await inspectCatalog({})).toContainEqual(
      findingMatching("provider-catalog-projection", "error", {
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message: "Provider catalog mockplugin failed during doctor validation.",
        requirement: expect.stringMatching(/proxy.*revoked/iu),
      }),
    );
  });
});
