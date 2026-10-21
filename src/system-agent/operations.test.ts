import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createAgent } from "../agents/agent-create.js";
import { runConfigSet } from "../cli/config-cli.js";
import { createGatewayHostLifecycle } from "../cli/gateway-cli/host-lifecycle.js";
import { runPluginUninstallCommand } from "../cli/plugins-uninstall-command.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import type { RuntimeEnv } from "../runtime.js";
import { listSecretStoreEntries, readSecretStoreValue } from "../secrets/store/secret-store.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import {
  describeSystemAgentPersistentOperation,
  executeSystemAgentOperation,
  isPersistentSystemAgentOperation,
  parseSystemAgentOperation,
} from "./operations.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";
import {
  createSystemAgentPluginMetadataTestSnapshot,
  expectSystemAgentAuditRecord as expectAuditRecord,
  readLastSystemAgentAuditEntry as readLastAuditEntry,
} from "./system-agent.test-helpers.js";

type TestConfig = Record<string, unknown>;

async function readConfigOutput(...paths: string[]): Promise<string> {
  const { runtime, lines } = createSystemAgentTestRuntime();
  for (const configPath of paths) {
    await executeSystemAgentOperation({ kind: "config-get", path: configPath }, runtime);
  }
  return lines.join("\n");
}

const mockConfig = vi.hoisted(() => {
  const initial = () => ({
    config: {} as TestConfig,
    exists: true,
    valid: true,
    pinnedConfig: undefined as TestConfig | undefined,
  });
  let state = initial();
  return {
    reset: () => {
      state = initial();
    },
    missing: () => {
      state = { ...initial(), exists: false, valid: false };
    },
    setConfig: (config: TestConfig) => {
      state = { ...initial(), config: structuredClone(config) };
    },
    setInvalidConfig: (config: TestConfig, pinnedConfig?: TestConfig) => {
      state = {
        config: structuredClone(config),
        exists: true,
        valid: false,
        pinnedConfig: structuredClone(pinnedConfig),
      };
    },
    readConfigFileSnapshot: vi.fn(async () => {
      const config = structuredClone(state.config);
      return {
        path: "/tmp/openclaw.json",
        exists: state.exists,
        valid: state.valid,
        raw: state.exists ? `${JSON.stringify(config)}\n` : null,
        parsed: state.exists ? config : undefined,
        sourceConfigBeforeMigrations: config,
        sourceConfig: config,
        resolved: config,
        runtimeConfig: config,
        config,
        hash: state.exists ? "mock-hash-0" : undefined,
        issues: state.exists ? [] : [{ path: "", message: "missing config" }],
        warnings: [],
        legacyIssues: [],
      };
    }),
    getRuntimeConfig() {
      if (state.pinnedConfig) {
        return structuredClone(state.pinnedConfig);
      }
      if (!state.valid) {
        throw new Error("invalid runtime config");
      }
      return structuredClone(state.config);
    },
  };
});
const mockDaemonRestart = vi.hoisted(() => vi.fn(async () => true));
// mock-isolation: Keep agent creation and its persistent stores outside the executor fixture.
vi.mock("../agents/agent-create.js", () => ({ createAgent: vi.fn() }));
// mock-isolation: Exercise approval and audit without loading the machine's config CLI.
vi.mock("../cli/config-cli.js", () => ({ runConfigSet: vi.fn() }));
// mock-isolation: Never uninstall real plugins while testing executor approval.
vi.mock("../cli/plugins-uninstall-command.js", () => ({ runPluginUninstallCommand: vi.fn() }));
const runPluginInstallCommandMock = vi.hoisted(() => vi.fn(async () => undefined));
const mockScheduleGatewayRestart = vi.hoisted(() =>
  vi.fn(() => ({
    ok: true,
    pid: process.pid,
    signal: "SIGUSR2" as const,
    delayMs: 0,
    mode: "emit" as const,
    coalesced: false,
    cooldownMsApplied: 0,
    emitHooksQueued: false,
  })),
);
vi.mock("../cli/daemon-cli/lifecycle.js", () => ({
  runDaemonStart: vi.fn(async () => {}),
  runDaemonStop: vi.fn(async () => {}),
  runDaemonRestart: mockDaemonRestart,
}));
vi.mock("../cli/plugins-install-command.js", () => ({
  runPluginInstallCommand: runPluginInstallCommandMock,
}));
vi.mock("../infra/restart.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/restart.js")>()),
  scheduleGatewayRestart: mockScheduleGatewayRestart,
}));
vi.mock("./overview.js", () => ({
  loadSystemAgentOverview: vi.fn(async () => ({
    agents: [
      { id: "main", isDefault: true },
      { id: "work", isDefault: false, model: "openai/gpt-5.2" },
    ],
  })),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => mockConfig.getRuntimeConfig(),
  readConfigFileSnapshot: mockConfig.readConfigFileSnapshot,
}));
const opTempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("system agent operations", () => {
  let runtime: RuntimeEnv;
  let lines: string[];
  const run = (
    operation: Parameters<typeof executeSystemAgentOperation>[0],
    options?: Parameters<typeof executeSystemAgentOperation>[2],
  ) => executeSystemAgentOperation(operation, runtime, options);
  const loggedOutput = () => lines.join("\n");
  function expectAudit(operation: string, summary: string, details: TestConfig = {}) {
    expectAuditRecord(readLastAuditEntry(), { operation, summary }, details);
  }
  function expectRedactedDescription(path: string, value: string) {
    expect(describeSystemAgentPersistentOperation({ kind: "config-set", path, value })).toBe(
      `set config ${path} to <redacted>`,
    );
  }
  async function withMetadata(config: TestConfig, effect: () => Promise<void>) {
    mockConfig.setConfig(config);
    setRuntimeConfigSnapshot(config, config);
    try {
      await createSystemAgentPluginMetadataTestSnapshot(config).run(effect);
    } finally {
      clearRuntimeConfigSnapshot();
    }
  }

  beforeEach(() => {
    ({ runtime, lines } = createSystemAgentTestRuntime());
    mockConfig.reset();
    mockDaemonRestart.mockClear();
    vi.mocked(createAgent).mockReset();
    vi.mocked(runConfigSet).mockReset().mockResolvedValue(undefined);
    vi.mocked(runPluginUninstallCommand).mockReset();
    runPluginInstallCommandMock.mockClear();
    mockScheduleGatewayRestart.mockClear();
    vi.stubEnv("OPENCLAW_STATE_DIR", opTempDirs.make("openclaw-operations-"));
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("includes each agent's effective model in the agents tool result", async () => {
    await run({ kind: "agents" });
    expect(loggedOutput()).toContain("main | default | model=not configured");
    expect(loggedOutput()).toContain("work | model=openai/gpt-5.2");
  });

  it("redacts sensitive config values using their complete paths", async () => {
    mockConfig.setConfig({
      models: {
        providers: { local: { localService: { env: { HF_HOME: "/private/model-cache" } } } },
      },
    });
    const output = await readConfigOutput("models.providers.local.localService");

    expect(output).toContain('"HF_HOME": "<redacted>"');
    expect(output).not.toContain("/private/model-cache");
    expectRedactedDescription(
      "models.providers.local.localService.env.HF_HOME",
      "/private/model-cache",
    );
  });

  it("reads canonical array indices after redaction", async () => {
    const configPath = "agents.entries.main.skills[00]";
    mockConfig.setConfig({
      channels: { modelByChannel: { telegram: { "team.ops[west]": "openai/gpt-5.5" } } },
      models: { providers: { "local.service": { apiKey: "synthetic-key" } } },
      agents: { entries: { main: { skills: ["weather"] } } },
    });
    const operation = parseSystemAgentOperation(`config get ${configPath}`);
    expect(operation).toEqual({ kind: "config-get", path: configPath });
    expect(await run(operation)).toEqual({ applied: false });
    expect(lines).toEqual([`${configPath} = "weather"`]);
  });

  it("keeps invalid config reads available without exposing recovery secrets", async () => {
    mockConfig.setInvalidConfig(
      {
        gateway: { port: 19_001, auth: { token: "recovery-secret" } },
        plugins: {
          entries: { missing: { config: { opaque: "invalid-plugin-secret" } } },
        },
      },
      {},
    );
    const output = await readConfigOutput("gateway", "plugins.entries.missing");
    expect(output).toContain('"port": 19001');
    expect(output).toContain('"token": "<redacted>"');
    expect(output).toContain('"config": "<redacted>"');
    expect(output).not.toContain("recovery-secret");
    expect(output).not.toContain("invalid-plugin-secret");
  });

  it("fails closed for model-visible config owned by missing plugins and channels", async () => {
    mockConfig.setConfig({
      plugins: {
        entries: {
          missing: { enabled: true, config: { opaque: "missing-plugin-secret" } },
        },
      },
      channels: {
        missing: { enabled: true, opaque: "missing-channel-secret" },
        defaults: { groupPolicy: "open" },
        modelByChannel: { telegram: { chat: "openai/gpt-5.5" } },
      },
    });
    const output = await readConfigOutput("plugins.entries.missing", "channels");
    expect(output).toContain('"enabled": true');
    expect(output).toContain('"config": "<redacted>"');
    expect(output).toContain('"missing": "<redacted>"');
    expect(output).toContain('"groupPolicy": "open"');
    expect(output).toContain('"chat": "openai/gpt-5.5"');
    expect(output).not.toContain("missing-plugin-secret");
    expect(output).not.toContain("missing-channel-secret");
  });

  it("reads installed plugin field schemas and authored help from the active metadata", async () => {
    await withMetadata({ plugins: { entries: { codex: { enabled: true } } } }, async () => {
      await run({
        kind: "config-schema",
        path: "plugins.entries.codex.config.codexDynamicToolsLoading",
      });
      expect(loggedOutput()).toContain("searchable");
      expect(loggedOutput()).toContain("Use searchable to defer OpenClaw dynamic tools");
    });
  });

  it("redacts plugin secrets and channel callback URLs with active metadata", async () => {
    const authorization = "Bearer plugin-only-secret";
    const callbackUrl = "https://gateway.example/webhook/synology?access_token=callback-secret";
    const incomingUrl = "https://nas.example/webapi/entry.cgi?token=incoming-secret";
    const config = {
      plugins: {
        entries: {
          codex: { config: { appServer: { headers: { Authorization: authorization } } } },
        },
      },
      channels: {
        "synology-chat": {
          incomingUrl,
          webhookUrl: callbackUrl,
          accounts: {
            work: { incomingUrl, webhookUrl: callbackUrl },
          },
        },
      },
    };
    await withMetadata(config, async () => {
      const output = await readConfigOutput(
        "plugins.entries.codex.config.appServer",
        "channels.synology-chat",
      );
      expect(output).toContain('"headers": "<redacted>"');
      expect(output).toContain('"webhookUrl": "<redacted>"');
      expect(output).toContain('"incomingUrl": "<redacted>"');
      expect(output).not.toContain(authorization);
      expect(output).not.toContain("callback-secret");
      expect(output).not.toContain("incoming-secret");
      expectRedactedDescription("channels.synology-chat.accounts.work.webhookUrl", callbackUrl);
      expectRedactedDescription("channels.synology-chat", `{ webhookUrl: "${callbackUrl}" }`);
    });
  });

  it.each([
    {
      agentId: "work",
      model: "openai/gpt-5.5",
      error: "Retry without `model`; the new agent inherits",
    },
    { agentId: "OpenClaw", error: 'Agent id "openclaw" is reserved' },
  ])(
    "rejects unsafe agent creation for $agentId before any write or audit",
    async ({ agentId, model, error }) => {
      const operation = { kind: "create-agent" as const, agentId, model, workspace: "/tmp/work" };
      expect(isPersistentSystemAgentOperation(operation)).toBe(false);
      expect(isPersistentSystemAgentOperation({ kind: "create-agent", agentId: "work" })).toBe(
        true,
      );
      await expect(run(operation, { approved: true })).rejects.toThrow(error);
      expect(createAgent).not.toHaveBeenCalled();
      expect(loggedOutput()).not.toContain("[openclaw] running: agents.create");
      expect(readLastAuditEntry()).toBeUndefined();
    },
  );

  it("delegates literal main to the canonical creation gate", async () => {
    vi.mocked(createAgent).mockResolvedValue({
      status: "error" as const,
      reason: "legacy-session-migration-required" as const,
      agentId: "main",
      message: "Run openclaw doctor --fix before creating main.",
    });

    await expect(
      run({ kind: "create-agent", agentId: "main", workspace: "/tmp/main" }, { approved: true }),
    ).rejects.toThrow("Run openclaw doctor --fix before creating main.");

    expect(createAgent).toHaveBeenCalledWith({
      entry: { id: "main" },
      workspace: "/tmp/main",
      provenance: { createdVia: "agent", creatorAgentId: "openclaw" },
    });
  });

  it("restarts its own Gateway despite hostile remote Gateway routing", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_URL", "wss://another-gateway.example:9443");
    mockConfig.setConfig({
      gateway: {
        mode: "remote",
        remote: { url: "wss://configured-remote-gateway.example:9443" },
      },
    });

    const host = createGatewayHostLifecycle({
      processOwner: { ownsProcessLifecycle: true, supervisor: null },
      isCurrent: () => true,
      isServing: () => true,
      acceptStop: () => {},
    });
    await expect(host.capability.request("restart", () => {})).resolves.toEqual({
      ok: true,
      value: { outcome: "scheduled" },
    });
    await host.retire();

    expect(mockScheduleGatewayRestart).toHaveBeenCalledExactlyOnceWith({
      reason: "gateway.restart.safe",
      delayMs: 0,
    });
    expect(mockDaemonRestart).not.toHaveBeenCalled();
  });

  it("records an approved standalone restart truthfully", async () => {
    const result = await run({ kind: "gateway-restart" }, { approved: true });
    expect(result.applied).toBe(true);
    expect(mockDaemonRestart).toHaveBeenCalledExactlyOnceWith();
    expect(mockScheduleGatewayRestart).not.toHaveBeenCalled();
    expectAudit("gateway.restart", "Restarted Gateway");
  });

  it("does not report or audit a gateway restart that returned false", async () => {
    mockDaemonRestart.mockResolvedValueOnce(false);

    await expect(run({ kind: "gateway-restart" }, { approved: true })).rejects.toThrow(
      "Gateway restart did not complete",
    );

    expect(loggedOutput()).toContain("[openclaw] running: gateway.restart");
    expect(loggedOutput()).not.toContain("[openclaw] done: gateway.restart");
    expect(readLastAuditEntry()).toBeUndefined();
  });

  it("validates missing config without exiting the process", async () => {
    mockConfig.missing();

    const result = await run({ kind: "config-validate" });
    expect(result.applied).toBe(false);

    expect(loggedOutput()).toContain("Config missing:");
  });

  it("applies config-set-ref through the config command and audits the write", async () => {
    const path = "gateway.auth.token";
    const id = "OPENCLAW_GATEWAY_TOKEN";
    const result = await run(
      { kind: "config-set-ref", path, source: "env", id },
      {
        approved: true,
        auditDetails: { rescue: true, channel: "whatsapp" },
      },
    );
    expect(result.applied).toBe(true);
    expect(runConfigSet).toHaveBeenCalledWith({
      path,
      cliOptions: { refProvider: "default", refSource: "env", refId: id },
      runtime: expect.objectContaining({ log: expect.any(Function) }),
      throwOnError: false,
    });
    expect(loggedOutput()).toContain("[openclaw] done: config.setRef");
    expectAudit("config.setRef", "Set config gateway.auth.token SecretRef", {
      rescue: true,
      channel: "whatsapp",
      path,
      source: "env",
      provider: "default",
    });
  });

  describe("an API key the owner gives in chat", () => {
    const operation = {
      kind: "config-set-ref" as const,
      path: "memory.search.remote.apiKey",
      source: "store" as const,
      id: "MEMORY_SEARCH_REMOTE_API_KEY",
      secret: "embed-owner-key-7f3c9a1d",
    };
    const storedEntries = async () =>
      (await listSecretStoreEntries({ scope: { kind: "team" } })).map((entry) => entry.name);
    const readStored = (name: string) => readSecretStoreValue({ scope: { kind: "team" }, name });
    const mintedName = expect.stringMatching(/^MEMORY_SEARCH_REMOTE_API_KEY_[0-9A-F]{16}$/);

    it("writes nothing when the owner's authority is gone before the store write", async () => {
      await expect(
        run(operation, {
          approved: true,
          beforePersistentApply: () => {
            throw new Error("requesting run is no longer active");
          },
        }),
      ).rejects.toThrow("no longer active");

      expect(await storedEntries()).toEqual([]);
      expect(runConfigSet).not.toHaveBeenCalled();
    });

    it("keeps the key's configured store provider when rotating it", async () => {
      mockConfig.setConfig({
        secrets: { providers: { vault: { source: "store" }, team: { source: "store" } } },
        memory: {
          search: {
            remote: {
              apiKey: { source: "store", provider: "team", id: "MEMORY_SEARCH_REMOTE_API_KEY" },
            },
          },
        },
      });

      const result = await run(operation, { approved: true });

      expect(readLastAuditEntry()).toMatchObject({ details: { provider: "team" } });
      expect(result.applied).toBe(true);
      const [name] = await storedEntries();
      expect(name).toEqual(mintedName);
      expect(runConfigSet).toHaveBeenCalledWith({
        path: operation.path,
        cliOptions: { refProvider: "team", refSource: "store", refId: name },
        runtime: expect.objectContaining({ log: expect.any(Function) }),
        throwOnError: true,
      });
      expect(await readStored(name ?? "")).toMatchObject({ ok: true, value: operation.secret });
      expect(loggedOutput()).not.toContain(operation.secret);
      expect(JSON.stringify(readLastAuditEntry())).not.toContain(operation.secret);
    });
  });

  it("installs plugins only after approval and audits the write", async () => {
    const beforePersistentApply = vi.fn();
    const applyPluginRuntime = vi.fn(async () => ({
      operationId: "system-install",
      generation: 4,
      pluginIds: ["openclaw-demo"],
    }));

    const operation = { kind: "plugin-install", spec: "clawhub:openclaw-demo" } as const;
    const plan = await run(operation);
    expect(plan).toMatchObject({
      applied: false,
      message: "Plan: install plugin clawhub:openclaw-demo. Say yes to apply.",
    });
    expect(runPluginInstallCommandMock).not.toHaveBeenCalled();

    const result = await run(operation, {
      approved: true,
      beforePersistentApply,
      deps: { applyPluginRuntime },
      auditDetails: { rescue: true },
    });
    expect(result.applied).toBe(true);

    expect(runPluginInstallCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        raw: "clawhub:openclaw-demo",
        opts: {},
        allowInstallPolicyWarningPrompt: false,
        beforePersistentApply: expect.any(Function),
        applyRuntime: applyPluginRuntime,
        runtime: expect.objectContaining({ log: expect.any(Function) }),
      }),
    );
    expect(beforePersistentApply).toHaveBeenCalledOnce();
    expect(loggedOutput()).toContain("[openclaw] done: plugin.install");
    expect(loggedOutput()).not.toContain("Restart the Gateway to apply installed plugin changes.");
    expectAudit("plugin.install", "Installed plugin clawhub:openclaw-demo", {
      rescue: true,
      spec: "clawhub:openclaw-demo",
    });
  });

  it.each([
    [true, "https://example.test/plugin.tgz", "accepts npm or ClawHub package specs only"],
    [false, "npm:@example/plugin", "trusted shell"],
  ] as const)(
    "rejects spec %s/%s without exiting, reading config, or writing",
    async (approved, spec, error) => {
      mockConfig.readConfigFileSnapshot.mockClear();
      vi.spyOn(runtime, "error");
      vi.spyOn(runtime, "exit");

      await expect(run({ kind: "plugin-install", spec }, { approved })).rejects.toThrow(error);

      expect(runtime.error).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(runPluginInstallCommandMock).not.toHaveBeenCalled();
      expect(mockConfig.readConfigFileSnapshot).not.toHaveBeenCalled();
    },
  );

  it("uninstalls a non-route plugin only after approval and audits the write", async () => {
    const operation = { kind: "plugin-uninstall", pluginId: "openclaw-demo" } as const;
    const plan = await run(operation);
    expect(plan).toMatchObject({
      applied: false,
      message: "Plan: uninstall plugin openclaw-demo. Say yes to apply.",
    });
    expect(runPluginUninstallCommand).not.toHaveBeenCalled();

    const result = await run(operation, { approved: true });
    expect(result.applied).toBe(true);
    expect(runPluginUninstallCommand).toHaveBeenCalledWith(
      ["openclaw-demo"],
      undefined,
      expect.objectContaining({ log: expect.any(Function) }),
    );
    expect(loggedOutput()).toContain("[openclaw] done: plugin.uninstall");
    expect(loggedOutput()).toContain("Restart the Gateway to apply plugin changes.");
  });

  it("refuses plugin uninstall when it cannot prove inference survives", async () => {
    // Fail closed: without a readable config the route cannot be proven safe.
    mockConfig.missing();

    const result = await run(
      { kind: "plugin-uninstall", pluginId: "openclaw-demo" },
      { approved: true },
    );
    expect(result).toMatchObject({ applied: false });
    expect(runPluginUninstallCommand).not.toHaveBeenCalled();
    expect(loggedOutput()).toContain("could remove the provider behind");
    expect(loggedOutput()).toContain("openclaw plugins uninstall openclaw-demo");
  });
});
