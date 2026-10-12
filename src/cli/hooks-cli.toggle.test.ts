// Hook command tests cover metadata config keys and missing-hook exit status.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import type { TransformConfigFileParams } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { GatewayTransportError } from "../gateway/transport-error.js";
import type { HookStatusEntry, HookStatusReport } from "../hooks/hooks-status.js";
import { ExpectedCliError } from "./failure-output.js";
import { createEmptyInstallChecks } from "./requirements-test-fixtures.js";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";

const mocks = vi.hoisted(() => ({
  foreignOwner: false,
  callGateway: vi.fn(),
  buildWorkspaceHookStatus: vi.fn(),
  getRuntimeConfig: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn(),
  requestExitAfterOneShotOutput: vi.fn(),
  listAgentIds: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveConfiguredAgentId: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  tryResolveLegacyCompatibilityAgentId: vi.fn(),
}));

vi.mock("../infra/gateway-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/gateway-lock.js")>()),
  readActiveGatewayLockIdentity: async () =>
    mocks.foreignOwner ? { pid: 12345, port: 18789, ownerId: "synthetic-owner" } : null,
  acquireGatewayLock: async () => ({ assertCurrent() {}, release: async () => {} }),
}));
// mock-isolation: Keep physical database custody outside the hook command fixture.
vi.mock("../infra/gateway-state-owner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/gateway-state-owner.js")>()),
  captureGatewayStateOwner: () => undefined,
  tryBorrowGatewayStateOwner: () => undefined,
}));
// mock-isolation: The real ownership guard runs against synthetic config effects.
vi.mock("../state/openclaw-state-db-async-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/openclaw-state-db-async-lifecycle.js")>()),
  createOpenClawDatabaseMaintenanceScope: () => ({
    run: async (run: () => Promise<unknown>) => run(),
    close: async () => {},
  }),
}));

const capture = createCliRuntimeCapture();
const readConfigMachineStateMock = vi.hoisted(() => vi.fn());

vi.mock("../state/config-machine-state.js", () => ({
  readConfigMachineState: readConfigMachineStateMock,
}));

vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds: mocks.listAgentIds,
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  resolveConfiguredAgentId: mocks.resolveConfiguredAgentId,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
  tryResolveLegacyCompatibilityAgentId: mocks.tryResolveLegacyCompatibilityAgentId,
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
  transformConfigFile: async ({ transform }: TransformConfigFileParams<HookStatusEntry>) => {
    const snapshot = await mocks.readConfigFileSnapshot();
    const transformed = await transform(
      snapshot.sourceConfig,
      { snapshot, previousHash: snapshot.hash, attempt: 0 },
      {},
    );
    await mocks.replaceConfigFile({ nextConfig: transformed.nextConfig, baseHash: snapshot.hash });
    return transformed;
  },
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
  isGatewayClientRequestError: (error: unknown) =>
    error instanceof Error && error.name === "GatewayClientRequestError",
  isGatewayCredentialsRequiredError: (error: unknown) =>
    error instanceof Error && error.name === "GatewayCredentialsRequiredError",
  isImplicitLocalGatewayTarget: async ({ config }: { config?: OpenClawConfig }) =>
    !process.env.OPENCLAW_GATEWAY_URL && config?.gateway?.mode !== "remote",
}));

vi.mock("../hooks/hooks-status.js", () => ({
  buildWorkspaceHookStatus: mocks.buildWorkspaceHookStatus,
}));

vi.mock("../hooks/policy.js", () => ({
  resolveHookEntries: (entries: unknown[]) => entries,
}));

vi.mock("../hooks/workspace.js", () => ({
  loadWorkspaceHookEntries: () => [],
}));

vi.mock("../plugins/status.js", () => ({
  withPluginDiagnosticsReport: async <T>(
    _params: unknown,
    consume: (report: { hooks: [] }) => T | Promise<T>,
  ) => consume({ hooks: [] }),
}));

vi.mock("../plugins/channel-plugin-ids.js", () => ({
  loadGatewayStartupPluginPlanWithMetadata: () => ({
    plan: { channelPluginIds: [], pluginIds: [] },
    metadataSnapshot: {},
  }),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: capture.defaultRuntime,
}));

vi.mock("./one-shot-exit.js", () => ({
  requestExitAfterOneShotOutput: mocks.requestExitAfterOneShotOutput,
}));

vi.mock("./native-hook-relay-cli.js", () => ({
  runNativeHookRelayCli: vi.fn(),
}));

vi.mock("./plugins-install-command.js", () => ({
  runPluginInstallCommand: vi.fn(),
}));

vi.mock("./plugins-update-command.js", () => ({
  runPluginUpdateCommand: vi.fn(),
}));

const sourceConfig = {
  hooks: {
    internal: {
      enabled: true,
      entries: {
        "metadata-key": {
          env: { HOOK_ENV: "preserved" },
        },
      },
    },
  },
};

const hook: HookStatusEntry = {
  name: "display-name",
  description: "Hook with a metadata config-key override",
  source: "openclaw-workspace",
  filePath: "/tmp/openclaw-hook-workspace/HOOK.md",
  baseDir: "/tmp/openclaw-hook-workspace",
  handlerPath: "/tmp/openclaw-hook-workspace/handler.js",
  hookKey: "metadata-key",
  events: ["command:new"],
  unknownEvents: [],
  always: false,
  enabledByConfig: true,
  requirementsSatisfied: true,
  loadable: true,
  managedByPlugin: false,
  ...createEmptyInstallChecks(),
};

const report: HookStatusReport = {
  workspaceDir: "/tmp/openclaw-hook-workspace",
  managedHooksDir: "/tmp/openclaw-managed-hooks",
  hooks: [hook],
};

const { registerHooksCli } = await import("./hooks-cli.js");

function createHooksProgram(): Command {
  const program = new Command().enablePositionalOptions();
  registerHooksCli(program);
  return program;
}

function createGatewayCloseError(code = 1006) {
  return new GatewayTransportError({
    kind: "closed",
    message: `gateway closed (${code}): unavailable`,
    connectionDetails: { url: "ws://127.0.0.1:18789", urlSource: "local loopback", message: "" },
    code,
    reason: "unavailable",
  });
}

function configureExplicitFleet() {
  const config = {
    ...sourceConfig,
    agents: {
      ownership: "explicit" as const,
      entries: {
        main: { workspace: "/tmp/openclaw-main-workspace" },
        research: { workspace: "/tmp/openclaw-research-workspace" },
      },
    },
  };
  mocks.getRuntimeConfig.mockReturnValue(config);
  mocks.listAgentIds.mockReturnValue(["main", "research"]);
  mocks.tryResolveLegacyCompatibilityAgentId.mockReturnValue(undefined);
  mocks.resolveDefaultAgentId.mockImplementation(() => {
    throw new Error("selection required");
  });
  mocks.resolveAgentWorkspaceDir.mockImplementation(
    (_config: unknown, agentId: string) => `/tmp/openclaw-${agentId}-workspace`,
  );
  return config;
}

describe("hooks CLI metadata config keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.foreignOwner = false;
    capture.resetRuntimeCapture();
    mocks.callGateway.mockRejectedValue(createGatewayCloseError());
    mocks.buildWorkspaceHookStatus.mockReturnValue(report);
    mocks.getRuntimeConfig.mockReturnValue(sourceConfig);
    mocks.listAgentIds.mockReturnValue(["main"]);
    mocks.resolveConfiguredAgentId.mockImplementation(
      (_config: OpenClawConfig, agentId: string) => {
        if (!mocks.listAgentIds().includes(agentId)) {
          throw new Error(`Unknown agent id "${agentId}"`);
        }
        return agentId;
      },
    );
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/tmp/openclaw-hook-workspace");
    mocks.resolveDefaultAgentId.mockReturnValue("main");
    mocks.tryResolveLegacyCompatibilityAgentId.mockReturnValue("main");
    mocks.readConfigFileSnapshot.mockResolvedValue({ sourceConfig, hash: "config-hash" });
    mocks.replaceConfigFile.mockResolvedValue(undefined);
    readConfigMachineStateMock.mockReturnValue(undefined);
  });

  it.each(["enable", "disable"])(
    "refuses hook %s while the Gateway owns state",
    async (command) => {
      mocks.foreignOwner = true;
      await expect(
        createHooksProgram().parseAsync(["hooks", command, "display-name"], { from: "user" }),
      ).rejects.toThrow("stop the Gateway");
      expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    },
  );

  it("rejects the ambiguous hook identifier shared-key without mutation", async () => {
    mocks.buildWorkspaceHookStatus.mockReturnValue({
      ...report,
      hooks: [
        { ...hook, name: "first-hook", hookKey: "shared-key" },
        { ...hook, name: "second-hook", hookKey: "shared-key" },
      ],
    });
    await expect(
      createHooksProgram().parseAsync(["hooks", "disable", "shared-key"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");
    expect(capture.runtimeErrors.at(-1)).toBe(
      'Error: Hook "shared-key" is ambiguous; matches: first-hook (shared-key), second-hook (shared-key). Use a unique hook name or hook key.',
    );
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("gives the recovery command for an unknown hook", async () => {
    mocks.buildWorkspaceHookStatus.mockReturnValue({ ...report, hooks: [] });

    await expect(
      createHooksProgram().parseAsync(["hooks", "enable", "missing-hook"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    expect(capture.runtimeErrors.at(-1)).toBe(
      'Error: Hook "missing-hook" not found. Run `openclaw hooks list` to see available hooks.',
    );
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("names missing requirements and the available install route", async () => {
    const ineligibleHook: HookStatusEntry = {
      ...hook,
      requirementsSatisfied: false,
      loadable: false,
      blockedReason: "missing requirements",
      missing: {
        bins: ["missing-bin"],
        anyBins: ["missing-any-a", "missing-any-b"],
        env: ["MISSING_ENV"],
        config: ["hooks.demo.enabled"],
        os: ["linux"],
      },
      install: [
        { id: "demo-npm", kind: "npm", label: "Install @openclaw/demo-hook (npm)", bins: [] },
      ],
    };
    mocks.buildWorkspaceHookStatus.mockReturnValue({ ...report, hooks: [ineligibleHook] });

    await expect(
      createHooksProgram().parseAsync(["hooks", "enable", "display-name"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    expect(capture.runtimeErrors.at(-1)).toBe(
      'Error: Hook "display-name" is not eligible; missing bins: missing-bin; anyBins: missing-any-a, missing-any-b; env: MISSING_ENV; config: hooks.demo.enabled; os: linux. Install options: Install @openclaw/demo-hook (npm). Run `openclaw hooks info display-name` for details.',
    );
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  describe("info selection", () => {
    const argv = (identifier: string, output: string) => [
      "hooks",
      ...(output === "parent JSON" ? ["--json"] : []),
      "info",
      identifier,
      ...(output === "leaf JSON" ? ["--json"] : []),
    ];
    const exactNameHook = { ...hook, name: "shared" };
    const collidingKeyHook = { ...hook, name: "another-hook", hookKey: "shared" };

    it.each([
      {
        label: "key before name",
        output: "human",
        hooks: [collidingKeyHook, exactNameHook],
        identifier: "shared",
        selected: exactNameHook,
      },
      {
        label: "unique key alias",
        output: "leaf JSON",
        hooks: [hook],
        identifier: "metadata-key",
        selected: hook,
      },
      {
        label: "plugin-managed hook",
        output: "human",
        hooks: [
          { ...hook, source: "openclaw-plugin", managedByPlugin: true, pluginId: "demo-plugin" },
        ],
        identifier: "metadata-key",
        selected: hook,
      },
    ])("inspects $label without mutation", async ({ hooks, identifier, selected, output }) => {
      const json = output !== "human";
      mocks.callGateway.mockResolvedValue({ ...report, hooks });

      await createHooksProgram().parseAsync(argv(identifier, output), { from: "user" });

      expect(capture.runtimeLogs).toHaveLength(1);
      if (json) {
        expect(JSON.parse(capture.runtimeLogs[0] ?? "")).toMatchObject({
          name: selected.name,
          hookKey: selected.hookKey,
        });
        expect(capture.defaultRuntime.writeStdout).toHaveBeenCalledOnce();
      } else {
        expect(capture.runtimeLogs[0]).toContain(`${selected.name} `);
        expect(capture.runtimeLogs[0]).not.toContain("another-hook");
        expect(capture.defaultRuntime.writeStdout).not.toHaveBeenCalled();
      }
      expect(mocks.requestExitAfterOneShotOutput).toHaveBeenCalledWith(capture.defaultRuntime, 0);
      expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
      expect(capture.runtimeErrors).toEqual([]);
    });

    it.each(["human", "parent JSON"])(
      "preserves missing-hook output and requests a failing exit (%s)",
      async (output) => {
        const json = output !== "human";
        await createHooksProgram().parseAsync(argv("missing-hook", output), { from: "user" });

        expect(capture.runtimeLogs).toHaveLength(1);
        if (json) {
          expect(JSON.parse(capture.runtimeLogs[0] ?? "")).toEqual({
            ok: false,
            error: { type: "cli_error", message: 'Hook "missing-hook" not found.' },
            hook: "missing-hook",
          });
          expect(capture.defaultRuntime.writeStdout).toHaveBeenCalledOnce();
        } else {
          expect(capture.runtimeLogs[0]).toBe(
            'Hook "missing-hook" not found. Run `openclaw hooks list` to see available hooks.',
          );
          expect(capture.defaultRuntime.writeStdout).not.toHaveBeenCalled();
        }
        expect(mocks.requestExitAfterOneShotOutput).toHaveBeenCalledWith(capture.defaultRuntime, 1);
        expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
      },
    );
  });

  it("still rejects disabling plugin-managed hooks", async () => {
    mocks.buildWorkspaceHookStatus.mockReturnValue({
      ...report,
      hooks: [
        { ...hook, source: "openclaw-plugin", managedByPlugin: true, pluginId: "demo-plugin" },
      ],
    });
    await expect(
      createHooksProgram().parseAsync(["hooks", "disable", "metadata-key"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");
    expect(capture.runtimeErrors.at(-1)).toContain('managed by plugin "demo-plugin"');
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("propagates blank leaf agent failures to the root CLI renderer", async () => {
    const message = "--agent must not be blank";
    const execution = createHooksProgram().parseAsync(["hooks", "list", "--agent", "", "--json"], {
      from: "user",
    });
    await expect(execution).rejects.toBeInstanceOf(ExpectedCliError);
    await expect(execution).rejects.toMatchObject({
      message,
      humanOutput: `Error: ${message}`,
      machineOutput: message,
    });
    expect(capture.defaultRuntime.error).not.toHaveBeenCalled();
    expect(capture.defaultRuntime.exit).not.toHaveBeenCalled();
    expect(capture.defaultRuntime.writeStdout).not.toHaveBeenCalled();
    expect(mocks.requestExitAfterOneShotOutput).not.toHaveBeenCalled();
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(mocks.buildWorkspaceHookStatus).not.toHaveBeenCalled();
    expect(mocks.resolveDefaultAgentId).not.toHaveBeenCalled();
  });

  it("uses hooks.status for the check read command", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "research"]);
    mocks.callGateway.mockResolvedValue({ ...report, workspaceDir: "/gateway/research" });
    mocks.buildWorkspaceHookStatus.mockClear();
    await createHooksProgram().parseAsync(["hooks", "check", "--agent", "research", "--json"], {
      from: "user",
    });
    expect(mocks.getRuntimeConfig).toHaveBeenCalledWith({ skipPluginValidation: true });
    expect(mocks.callGateway).toHaveBeenCalledWith({
      config: sourceConfig,
      method: "hooks.status",
      params: { agentId: "research" },
      timeoutMs: 1_500,
      clientName: "cli",
      mode: "cli",
    });
    expect(mocks.buildWorkspaceHookStatus).not.toHaveBeenCalled();
  });

  it("does not substitute local hooks after configured remote unsupported method", async () => {
    mocks.getRuntimeConfig.mockReturnValue({ ...sourceConfig, gateway: { mode: "remote" } });
    const message = "unknown method: hooks.status";
    mocks.callGateway.mockRejectedValue(
      new GatewayClientRequestError({ code: "INVALID_REQUEST", message }),
    );
    await expect(
      createHooksProgram().parseAsync(["hooks", "check"], { from: "user" }),
    ).rejects.toMatchObject({ name: "ExpectedCliError", message });
    expect(mocks.buildWorkspaceHookStatus).not.toHaveBeenCalled();
    expect(capture.defaultRuntime.writeStdout).not.toHaveBeenCalled();
    expect(mocks.requestExitAfterOneShotOutput).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "request validation",
      error: new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: 'invalid hooks.status params: unknown agent id "retired"',
      }),
    },
    { label: "pairing close", error: createGatewayCloseError(1008) },
  ])("does not substitute implicit-local hooks after $label", async ({ error }) => {
    mocks.callGateway.mockRejectedValue(error);

    await expect(
      createHooksProgram().parseAsync(["hooks", "list", "--json"], { from: "user" }),
    ).rejects.toMatchObject({ message: error.message });

    expect(mocks.buildWorkspaceHookStatus).not.toHaveBeenCalled();
    expect(mocks.requestExitAfterOneShotOutput).not.toHaveBeenCalled();
  });

  it("uses --agent for enable hook discovery", async () => {
    const explicitFleet = configureExplicitFleet();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      sourceConfig: explicitFleet,
      hash: "config-hash",
    });
    await createHooksProgram().parseAsync(
      ["hooks", "--agent", "research", "enable", "display-name"],
      {
        from: "user",
      },
    );
    expect(mocks.resolveDefaultAgentId).not.toHaveBeenCalled();
    expect(mocks.resolveAgentWorkspaceDir).toHaveBeenCalledWith(explicitFleet, "research");
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: {
        ...explicitFleet,
        hooks: {
          internal: {
            enabled: true,
            entries: {
              "metadata-key": {
                env: { HOOK_ENV: "preserved" },
                enabled: true,
              },
            },
          },
        },
      },
      baseHash: "config-hash",
    });
  });

  it("leaves config unchanged when the selected hook agent is invalid", async () => {
    const explicitFleet = configureExplicitFleet();
    const initialConfig = structuredClone(explicitFleet);
    mocks.readConfigFileSnapshot.mockResolvedValue({
      sourceConfig: explicitFleet,
      hash: "config-hash",
    });

    await expect(
      createHooksProgram().parseAsync(["hooks", "enable", "display-name", "--agent", "retired"], {
        from: "user",
      }),
    ).rejects.toThrow("__exit__:1");

    expect(capture.runtimeErrors.at(-1)).toContain('Unknown agent id "retired"');
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(explicitFleet).toEqual(initialConfig);
  });

  it("rejects a blank parent hook agent before dispatching a subcommand", async () => {
    await expect(
      createHooksProgram().parseAsync(["hooks", "--agent", "", "list"], { from: "user" }),
    ).rejects.toThrow("--agent must not be blank");

    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("uses the selected local fallback for an older Gateway", async () => {
    const explicitFleet = configureExplicitFleet();
    mocks.callGateway.mockRejectedValue(
      new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "invalid hooks.status params: at root: unexpected property 'agentId'",
      }),
    );
    await createHooksProgram().parseAsync(["hooks", "list", "--agent", "research", "--json"], {
      from: "user",
    });
    expect(mocks.resolveDefaultAgentId).not.toHaveBeenCalled();
    expect(mocks.resolveAgentWorkspaceDir).toHaveBeenCalledWith(explicitFleet, "research");
    expect(mocks.buildWorkspaceHookStatus).toHaveBeenCalledWith(
      "/tmp/openclaw-research-workspace",
      expect.anything(),
    );
  });
});
