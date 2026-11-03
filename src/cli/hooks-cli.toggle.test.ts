import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import type { TransformConfigFileParams } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { GatewayTransportError } from "../gateway/transport-error.js";
import type { HookStatusEntry, HookStatusReport } from "../hooks/hooks-status.js";
import { makeHookStatusEntry } from "./cli-fixtures.test-support.js";
import { ExpectedCliError } from "./expected-cli-error.js";

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

const capture = await vi.hoisted(async () => {
  const { createCliRuntimeCapture } = await import("./test-runtime-capture.js");
  return createCliRuntimeCapture();
});
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

// mock-isolation: Hook toggle fixtures own the config snapshot and write receipt without touching operator state.
vi.mock("../config/config.js", async () => {
  const { createTestConfigReadMocks } = await import("../commands/test-runtime-config-helpers.js");
  return {
    ...createTestConfigReadMocks(mocks, "getRuntimeConfig"),
    transformConfigFile: async ({ transform }: TransformConfigFileParams<HookStatusEntry>) => {
      const snapshot = await mocks.readConfigFileSnapshot();
      const transformed = await transform(
        snapshot.sourceConfig,
        { snapshot, previousHash: snapshot.hash, attempt: 0 },
        {},
      );
      await mocks.replaceConfigFile({
        nextConfig: transformed.nextConfig,
        baseHash: snapshot.hash,
      });
      return transformed;
    },
  };
});

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

const hook = makeHookStatusEntry({
  name: "display-name",
  description: "Hook with a metadata config-key override",
  source: "openclaw-workspace",
  baseDir: "/tmp/openclaw-hook-workspace",
  hookKey: "metadata-key",
});

const report: HookStatusReport = {
  workspaceDir: "/tmp/openclaw-hook-workspace",
  managedHooksDir: "/tmp/openclaw-managed-hooks",
  hooks: [hook],
};

const { registerHooksCli } = await import("./hooks-cli.js");

function runHooks(...args: string[]) {
  const program = new Command().enablePositionalOptions();
  registerHooksCli(program);
  return program.parseAsync(["hooks", ...args], { from: "user" });
}

async function expectToggleFailure(command: string, identifier: string, message: string) {
  await expect(runHooks(command, identifier)).rejects.toThrow("__exit__:1");
  expect(capture.runtimeErrors.at(-1)).toBe(message);
  expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
}

function expectOneShotOutput(json: boolean, code: number) {
  expect(capture.runtimeLogs).toHaveLength(1);
  expect(capture.defaultRuntime.writeStdout).toHaveBeenCalledTimes(json ? 1 : 0);
  expect(mocks.requestExitAfterOneShotOutput).toHaveBeenCalledWith(capture.defaultRuntime, code);
  expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
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
  mocks.readConfigFileSnapshot.mockResolvedValue({ sourceConfig: config, hash: "config-hash" });
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

  it("refuses hook enable while the Gateway owns state", async () => {
    mocks.foreignOwner = true;
    await expect(runHooks("enable", "display-name")).rejects.toThrow("stop the Gateway");
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("rejects the ambiguous hook identifier shared-key without mutation", async () => {
    mocks.buildWorkspaceHookStatus.mockReturnValue({
      ...report,
      hooks: [
        { ...hook, name: "first-hook", hookKey: "shared-key" },
        { ...hook, name: "second-hook", hookKey: "shared-key" },
      ],
    });
    await expectToggleFailure(
      "disable",
      "shared-key",
      'Error: Hook "shared-key" is ambiguous; matches: first-hook (shared-key), second-hook (shared-key). Use a unique hook name or hook key.',
    );
  });

  it("gives the recovery command for an unknown hook", async () => {
    mocks.buildWorkspaceHookStatus.mockReturnValue({ ...report, hooks: [] });

    await expectToggleFailure(
      "enable",
      "missing-hook",
      'Error: Hook "missing-hook" not found. Run `openclaw hooks list` to see available hooks.',
    );
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

    await expectToggleFailure(
      "enable",
      "display-name",
      'Error: Hook "display-name" is not eligible; missing bins: missing-bin; anyBins: missing-any-a, missing-any-b; env: MISSING_ENV; config: hooks.demo.enabled; os: linux. Install options: Install @openclaw/demo-hook (npm). Run `openclaw hooks info display-name` for details.',
    );
  });

  it.each<[string[], HookStatusEntry[], string, boolean]>([
    [
      ["info", "shared"],
      [
        { ...hook, name: "another-hook", hookKey: "shared" },
        { ...hook, name: "shared" },
      ],
      "shared",
      false,
    ],
    [["info", "metadata-key", "--json"], [hook], hook.name, true],
    [
      ["info", "metadata-key"],
      [{ ...hook, source: "openclaw-plugin", managedByPlugin: true, pluginId: "demo-plugin" }],
      hook.name,
      false,
    ],
  ])("inspects %j without mutation", async (args, hooks, name, json) => {
    mocks.callGateway.mockResolvedValue({ ...report, hooks });
    await runHooks(...args);
    expectOneShotOutput(json, 0);
    const output = capture.runtimeLogs[0] ?? "";
    if (json) {
      expect(JSON.parse(output)).toMatchObject({ name, hookKey: "metadata-key" });
    } else {
      expect(output).toContain(`${name} `);
      expect(output).not.toContain("another-hook");
    }
    expect(capture.runtimeErrors).toEqual([]);
  });

  it.each([false, true])("reports a missing hook (parent JSON=%s)", async (json) => {
    await runHooks(...(json ? ["--json"] : []), "info", "missing-hook");
    expectOneShotOutput(json, 1);
    const output = capture.runtimeLogs[0] ?? "";
    if (json) {
      expect(JSON.parse(output)).toEqual({
        ok: false,
        error: { type: "cli_error", message: 'Hook "missing-hook" not found.' },
        hook: "missing-hook",
      });
    } else {
      expect(output).toBe(
        'Hook "missing-hook" not found. Run `openclaw hooks list` to see available hooks.',
      );
    }
  });

  it("still rejects disabling plugin-managed hooks", async () => {
    mocks.buildWorkspaceHookStatus.mockReturnValue({
      ...report,
      hooks: [
        { ...hook, source: "openclaw-plugin", managedByPlugin: true, pluginId: "demo-plugin" },
      ],
    });
    await expect(runHooks("disable", "metadata-key")).rejects.toThrow("__exit__:1");
    expect(capture.runtimeErrors.at(-1)).toContain('managed by plugin "demo-plugin"');
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("sanitizes ambiguous hook metadata only in the human error", async () => {
    const escape = "\u001b]0;untrusted-title\u0007\u009f";
    mocks.callGateway.mockResolvedValue({
      ...report,
      hooks: [
        { ...hook, name: `first${escape}`, hookKey: "shared-key" },
        { ...hook, name: "second", hookKey: "shared-key" },
      ],
    });
    const execution = runHooks("info", "shared-key");
    await expect(execution).rejects.toMatchObject({
      humanOutput: expect.stringContaining("first (shared-key), second (shared-key)"),
      machineOutput: expect.stringContaining(escape),
    });
    await expect(execution).rejects.toMatchObject({
      humanOutput: expect.not.stringContaining(escape),
    });
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("propagates blank leaf agent failures to the root CLI renderer", async () => {
    const message = "--agent must not be blank";
    const execution = runHooks("list", "--agent", "", "--json");
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
    await runHooks("check", "--agent", "research", "--json");
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
    await expect(runHooks("check")).rejects.toMatchObject({ name: "ExpectedCliError", message });
    expect(mocks.buildWorkspaceHookStatus).not.toHaveBeenCalled();
    expect(capture.defaultRuntime.writeStdout).not.toHaveBeenCalled();
    expect(mocks.requestExitAfterOneShotOutput).not.toHaveBeenCalled();
  });

  it("keeps multi-line remote failures on separate human lines without controls", async () => {
    mocks.getRuntimeConfig.mockReturnValue({ ...sourceConfig, gateway: { mode: "remote" } });
    const message = [
      "gateway remote mode misconfigured: gateway.remote.url missing",
      "Fix: set gateway.remote.url\u001b]0;untrusted-title\u0007",
    ].join("\n");
    mocks.callGateway.mockRejectedValue(new Error(message));

    await expect(runHooks("list", "--json")).rejects.toMatchObject({
      humanOutput: [
        "Error: gateway remote mode misconfigured: gateway.remote.url missing",
        "Fix: set gateway.remote.url",
      ].join("\n"),
      machineOutput: message,
    });
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

    await expect(runHooks("list", "--json")).rejects.toMatchObject({ message: error.message });

    expect(mocks.buildWorkspaceHookStatus).not.toHaveBeenCalled();
    expect(mocks.requestExitAfterOneShotOutput).not.toHaveBeenCalled();
  });

  it("uses --agent for enable hook discovery", async () => {
    const explicitFleet = configureExplicitFleet();
    await runHooks("--agent", "research", "enable", "display-name");
    expect(mocks.resolveDefaultAgentId).not.toHaveBeenCalled();
    expect(mocks.resolveAgentWorkspaceDir).toHaveBeenCalledWith(explicitFleet, "research");
    const nextConfig = structuredClone(explicitFleet);
    Object.assign(nextConfig.hooks.internal.entries["metadata-key"], { enabled: true });
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      nextConfig,
      baseHash: "config-hash",
    });
  });

  it("leaves config unchanged when the selected hook agent is invalid", async () => {
    const explicitFleet = configureExplicitFleet();
    const initialConfig = structuredClone(explicitFleet);
    await expect(runHooks("enable", "display-name", "--agent", "retired")).rejects.toThrow(
      "__exit__:1",
    );

    expect(capture.runtimeErrors.at(-1)).toContain('Unknown agent id "retired"');
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(explicitFleet).toEqual(initialConfig);
  });

  it("rejects a blank parent hook agent before dispatching a subcommand", async () => {
    await expect(runHooks("--agent", "", "list")).rejects.toThrow("--agent must not be blank");

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
    await runHooks("list", "--agent", "research", "--json");
    expect(mocks.resolveDefaultAgentId).not.toHaveBeenCalled();
    expect(mocks.resolveAgentWorkspaceDir).toHaveBeenCalledWith(explicitFleet, "research");
    expect(mocks.buildWorkspaceHookStatus).toHaveBeenCalledWith(
      "/tmp/openclaw-research-workspace",
      expect.anything(),
    );
  });
});
