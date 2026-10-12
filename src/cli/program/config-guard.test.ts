// Config guard tests cover program-level config checks before command execution.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { note } from "../../../packages/terminal-core/src/note.js";
import { setDeferredPluginMigrationConfigFacts } from "../../config/deferred-plugin-migration-config.js";
import type { ConfigSnapshotReadMeasure } from "../../config/io.js";
import type { ConfigValidationIssue } from "../../config/types.js";
import { getGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-state.js";
import {
  adoptProcessPluginCache,
  createPluginCache,
  getProcessPluginCache,
  withPluginCache,
} from "../../plugins/plugin-cache.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { ExitError } from "../../runtime.js";
import { withExistingOpenClawStateSchema } from "../../state/openclaw-state-db-schema-policy.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { formatCliCommand } from "../command-format.js";
import {
  clearGatewayRunConfigEnvironment,
  prepareGatewayRunBootstrap,
  takeAcceptedGatewayRunMigrations,
} from "../gateway-cli/pre-bootstrap.js";
import { ensureConfigReady, testApi } from "./config-guard.js";

const pluginPackagingRecoveryHint = [
  "This is a plugin packaging issue, not a local config problem.",
  "Update or reinstall the plugin after the publisher ships compiled JavaScript, or disable/uninstall the plugin until then.",
].join("\n");

const runStartupConfigPreflightMock = vi.hoisted(() => vi.fn());
const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const setRuntimeConfigSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("../../commands/startup-config-preflight.js", () => ({
  runStartupConfigPreflight: runStartupConfigPreflightMock,
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  setRuntimeConfigSnapshot: setRuntimeConfigSnapshotMock,
}));

const recoveryMocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  isInteractive: vi.fn(),
  runDoctor: vi.fn(),
}));
vi.mock("../prompt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../prompt.js")>()),
  promptYesNo: recoveryMocks.confirm,
}));
vi.mock("../terminal-interactivity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../terminal-interactivity.js")>()),
  isTerminalInteractive: recoveryMocks.isInteractive,
}));
// mock-isolation: Consent and retry tests must not initialize Doctor migrations or state admission.
vi.mock("../../commands/doctor.js", () => ({ doctorCommand: recoveryMocks.runDoctor }));

type ConfigIssue = ConfigValidationIssue;

function makeSnapshot() {
  return {
    exists: false,
    valid: true,
    raw: null as string | null,
    parsed: {},
    sourceConfig: {},
    issues: [] as ConfigIssue[],
    warnings: [] as ConfigIssue[],
    legacyIssues: [] as ConfigIssue[],
    path: "/tmp/openclaw.json",
  };
}

function makeRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function plainErrorCalls(runtime: ReturnType<typeof makeRuntime>): string[] {
  const ansiPattern = new RegExp(String.raw`\u001b\[[0-9;]*m`, "g");
  return runtime.error.mock.calls.map((call) => String(call[0]).replace(ansiPattern, ""));
}

async function withCapturedStdout(run: () => Promise<void>): Promise<string> {
  const writes: string[] = [];
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: unknown,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    writes.push(String(chunk));
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    done?.();
    return true;
  }) as typeof process.stdout.write);
  try {
    await run();
    return writes.join("");
  } finally {
    writeSpy.mockRestore();
  }
}

describe("ensureConfigReady", () => {
  const resetConfigGuardStateForTests = testApi.resetConfigGuardStateForTests;
  const tempRoots: string[] = [];
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;
  let processCache: ReturnType<typeof getProcessPluginCache>;
  let preflightCache: ReturnType<typeof createPluginCache>;
  let preflightMetadata: ReturnType<typeof createPluginMetadataSnapshotFixture>;
  let statePath: string;

  async function runEnsureConfigReady(commandPath: string[], suppressDoctorStdout = false) {
    const runtime = makeRuntime();
    await ensureConfigReady({ runtime: runtime as never, commandPath, suppressDoctorStdout });
    return runtime;
  }

  function setInvalidSnapshot(overrides?: Partial<ReturnType<typeof makeSnapshot>>) {
    const snapshot = {
      ...makeSnapshot(),
      exists: true,
      valid: false,
      issues: [{ path: "channels.quietchat", message: "invalid" }],
      ...overrides,
    };
    readConfigFileSnapshotMock.mockResolvedValue(snapshot);
    runStartupConfigPreflightMock.mockResolvedValue({
      snapshot,
      baseConfig: {},
      pluginMetadataSnapshot: preflightMetadata,
    });
    return snapshot;
  }

  function useTempOpenClawHome(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-guard-"));
    tempRoots.push(root);
    setTestEnvValue("OPENCLAW_HOME", root);
    deleteTestEnvValue("OPENCLAW_NIX_MODE");
    deleteTestEnvValue("OPENCLAW_CONFIG_READONLY");
    deleteTestEnvValue("OPENCLAW_PROFILE");
    deleteTestEnvValue("OPENCLAW_STATE_DIR");
    return root;
  }

  beforeEach(() => {
    processCache = getProcessPluginCache();
    preflightCache = createPluginCache();
    preflightMetadata = withPluginCache(preflightCache, createPluginMetadataSnapshotFixture);
    envSnapshot = captureEnv([
      "HOME",
      "OPENCLAW_HOME",
      "OPENCLAW_NIX_MODE",
      "OPENCLAW_CONFIG_READONLY",
      "OPENCLAW_PROFILE",
      "OPENCLAW_STATE_DIR",
    ]);
    vi.clearAllMocks();
    recoveryMocks.confirm.mockReset().mockResolvedValue(true);
    recoveryMocks.isInteractive.mockReset().mockReturnValue(false);
    recoveryMocks.runDoctor.mockReset().mockResolvedValue(undefined);
    resetConfigGuardStateForTests();
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    statePath = path.join(useTempOpenClawHome(), ".openclaw", "state", "openclaw.sqlite");
    readConfigFileSnapshotMock.mockResolvedValue(makeSnapshot());
    runStartupConfigPreflightMock.mockImplementation(async () => ({
      snapshot: makeSnapshot(),
      baseConfig: {},
      pluginMetadataSnapshot: preflightMetadata,
    }));
  });

  afterEach(() => {
    adoptProcessPluginCache(processCache);
    envSnapshot?.restore();
    envSnapshot = undefined;
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { commandPath: ["connect"], valid: true },
    { commandPath: ["node", "run"], valid: false },
  ])("validates managed $commandPath with valid=$valid", async ({ commandPath, valid }) => {
    const config = { plugins: { entries: { fixture: { enabled: true } } } };
    readConfigFileSnapshotMock.mockResolvedValue({
      ...makeSnapshot(),
      exists: true,
      valid,
      raw: JSON.stringify(config),
      parsed: config,
      config,
      runtimeConfig: config,
      sourceConfig: config,
      issues: valid
        ? []
        : [{ path: "plugins.entries.fixture.config", message: "invalid plugin value" }],
    });
    const runtime = makeRuntime();
    runtime.exit.mockImplementation((code: number): never => {
      throw new ExitError(code);
    });
    recoveryMocks.isInteractive.mockReturnValue(true);
    const result = withExistingOpenClawStateSchema({ path: statePath }, () =>
      ensureConfigReady({ runtime, commandPath }),
    );
    if (valid) {
      await result;
      expect(setRuntimeConfigSnapshotMock).toHaveBeenCalledWith(config, config);
      expect(runtime.exit).not.toHaveBeenCalled();
    } else {
      await expect(result).rejects.toMatchObject({ name: "ExitError", code: 1 });
      expect(recoveryMocks.isInteractive).not.toHaveBeenCalled();
      expect(setRuntimeConfigSnapshotMock).not.toHaveBeenCalled();
      expect(runtime.error.mock.calls.join("\n")).toContain("invalid plugin value");
    }
    expect(runStartupConfigPreflightMock).not.toHaveBeenCalled();
    expect(readConfigFileSnapshotMock).toHaveBeenCalledWith({ observe: false });
  });

  it("rejects changed state selectors before config or migration work", async () => {
    await expect(
      withExistingOpenClawStateSchema({ path: statePath }, async () => {
        setTestEnvValue("OPENCLAW_STATE_DIR", path.join(path.dirname(statePath), "other"));
        await ensureConfigReady({ runtime: makeRuntime(), commandPath: ["node", "run"] });
      }),
    ).rejects.toThrow(/state.*(?:bound|changed)/i);

    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
    expect(runStartupConfigPreflightMock).not.toHaveBeenCalled();
  });

  it.each([
    ["skips state preparation for update status", ["update", "status"], 0],
    ["skips state preparation for logs", ["logs"], 0],
    ["prepares snapshots when the command path is empty", [], 1],
  ])("%s", async (_name, commandPath, expectedPreflightCalls) => {
    await runEnsureConfigReady(commandPath);
    expect(runStartupConfigPreflightMock).toHaveBeenCalledTimes(expectedPreflightCalls);
    expect(getProcessPluginCache()).toBe(processCache);
    if (expectedPreflightCalls > 0) {
      expect(runStartupConfigPreflightMock).toHaveBeenCalledWith({
        gateway: false,
      });
    }
    if (commandPath[0] === "logs") {
      expect(readConfigFileSnapshotMock).toHaveBeenCalledWith({
        observe: false,
        pluginValidation: "core-only",
      });
    }
  });

  it("retains accepted startup facts with stdout suppressed", async () => {
    await runEnsureConfigReady(["gateway", "run"], true);

    expect(runStartupConfigPreflightMock).toHaveBeenCalledWith({
      gateway: true,
      validateStartupConfig: expect.any(Function),
    });
    expect(getProcessPluginCache() === preflightCache).toBe(true);
    // Cache reuse must not freeze the Gateway inventory before its final config read.
    expect(getGatewayPluginMetadataSnapshot()).toBeUndefined();
  });

  const pendingMigration = { command: "openclaw doctor --fix", pluginId: "demo", reason: "kept" };
  it.each([
    { name: "pending", exists: true, valid: true, pending: [pendingMigration] },
    { name: "empty", exists: true, valid: true, pending: [] },
    { name: "missing-config", exists: false, valid: true, pending: undefined },
    { name: "invalid", exists: true, valid: false, pending: undefined },
  ])("hands the final gateway read $name accepted migration facts once", async (fixture) => {
    try {
      const runtime = makeRuntime() as never;
      expect(await prepareGatewayRunBootstrap({ opts: {}, runtime })).toBe(true);
      const sourceConfig = { gateway: { mode: "local" as const } };
      // Preflight snapshots carry their migration generation only when it is nonempty.
      setDeferredPluginMigrationConfigFacts(sourceConfig, fixture.pending ?? [pendingMigration]);
      const snapshot = { ...makeSnapshot(), exists: fixture.exists, valid: fixture.valid };
      runStartupConfigPreflightMock.mockResolvedValue({
        snapshot: {
          ...snapshot,
          sourceConfig,
          ...(fixture.valid ? {} : { issues: [{ path: "gateway", message: "invalid" }] }),
        },
        baseConfig: sourceConfig,
        pluginMetadataSnapshot: preflightMetadata,
      });

      await runEnsureConfigReady(["gateway", "run"]);

      expect(takeAcceptedGatewayRunMigrations()).toEqual(
        fixture.pending ? { deferredPluginMigrations: fixture.pending } : {},
      );
      expect(takeAcceptedGatewayRunMigrations()).toEqual({});
    } finally {
      clearGatewayRunConfigEnvironment();
    }
  });

  it("honors a readiness refusal after preflight resources unwind", async () => {
    let preflightUnwound = false;
    runStartupConfigPreflightMock.mockImplementation(async () => {
      try {
        throw new ExitError(78);
      } finally {
        preflightUnwound = true;
      }
    });
    const runtime = makeRuntime();
    runtime.exit.mockImplementation(() => {
      expect(preflightUnwound).toBe(true);
    });

    await expect(
      ensureConfigReady({ runtime: runtime as never, commandPath: ["gateway"] }),
    ).rejects.toMatchObject({ name: "ExitError", code: 78 });

    expect(runtime.exit).toHaveBeenCalledWith(78);
    expect(getProcessPluginCache()).toBe(processCache);
  });

  it("forwards config snapshot phase measurement", async () => {
    const snapshot = makeSnapshot();
    const measuredStages: string[] = [];
    const measure: ConfigSnapshotReadMeasure = async (stage, run) => {
      measuredStages.push(stage);
      return await run();
    };
    readConfigFileSnapshotMock.mockImplementationOnce(
      async (options?: { measure?: ConfigSnapshotReadMeasure }) => {
        await options?.measure?.("config.snapshot.read.validate", async () => undefined);
        return snapshot;
      },
    );

    await ensureConfigReady({
      runtime: makeRuntime() as never,
      commandPath: ["health"],
      measure,
    });

    expect(measuredStages).toEqual(["config.snapshot.read.validate"]);
  });

  it("forwards config snapshot phase measurement through startup preflight", async () => {
    const measuredStages: string[] = [];
    const measure: ConfigSnapshotReadMeasure = async (stage, run) => {
      measuredStages.push(stage);
      return await run();
    };
    runStartupConfigPreflightMock.mockImplementationOnce(
      async (options?: { measure?: ConfigSnapshotReadMeasure }) => {
        await options?.measure?.("config.snapshot.read.validate", async () => undefined);
        return { snapshot: makeSnapshot(), baseConfig: {} };
      },
    );

    await ensureConfigReady({
      runtime: makeRuntime() as never,
      commandPath: ["agent"],
      measure,
    });

    expect(measuredStages).toEqual(["config.snapshot.read.validate"]);
  });

  it("retries the cached config snapshot after a read rejection", async () => {
    const transientError = new Error("temporary config read failure");
    const recoveredSnapshot = makeSnapshot();
    readConfigFileSnapshotMock
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce(recoveredSnapshot);

    await expect(runEnsureConfigReady(["health"])).rejects.toThrow(transientError);
    await expect(runEnsureConfigReady(["health"])).resolves.toBeDefined();
    await expect(runEnsureConfigReady(["health"])).resolves.toBeDefined();

    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(2);
    expect(setRuntimeConfigSnapshotMock).toHaveBeenCalledWith(undefined, {});
  });

  it("exits for invalid config on non-allowlisted commands", async () => {
    setInvalidSnapshot();
    const runtime = await runEnsureConfigReady(["message"]);

    expect(plainErrorCalls(runtime)).toEqual([
      "OpenClaw config is invalid",
      "File: /tmp/openclaw.json",
      "Problem:",
      "  - channels.quietchat: invalid",
      "",
      `Inspect: ${formatCliCommand("openclaw config validate")}`,
      "Audit, status, health, logs, and doctor commands still run with invalid config.",
      `Run "${formatCliCommand("openclaw doctor --fix")}" to repair the config, then retry.`,
    ]);
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("runs doctor and retries the config guard once after consent", async () => {
    const invalidSnapshot = setInvalidSnapshot();
    const validSnapshot = {
      ...makeSnapshot(),
      config: { gateway: { mode: "local" } },
      sourceConfig: { gateway: { mode: "local" } },
    };
    runStartupConfigPreflightMock
      .mockResolvedValueOnce({ snapshot: invalidSnapshot, baseConfig: {} })
      .mockResolvedValueOnce({ snapshot: validSnapshot, baseConfig: validSnapshot.config });
    readConfigFileSnapshotMock.mockResolvedValue(validSnapshot);
    const runtime = makeRuntime();
    const confirm = recoveryMocks.confirm;
    recoveryMocks.isInteractive.mockReturnValue(true);
    const runDoctor = recoveryMocks.runDoctor;

    await ensureConfigReady({ runtime: runtime as never, commandPath: ["message"] });

    expect(confirm).toHaveBeenCalledWith(
      `Run "${formatCliCommand("openclaw doctor --fix")}" now?`,
      true,
    );
    expect(runDoctor).toHaveBeenCalledOnce();
    expect(runStartupConfigPreflightMock).toHaveBeenCalledTimes(2);
    expect(runStartupConfigPreflightMock).toHaveBeenLastCalledWith({ gateway: false });
    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
    expect(setRuntimeConfigSnapshotMock).toHaveBeenCalledWith(
      validSnapshot.config,
      validSnapshot.sourceConfig,
    );
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("preserves JSON output ownership for blocked commands", async () => {
    setInvalidSnapshot();
    const runtime = makeRuntime();
    recoveryMocks.isInteractive.mockReturnValue(true);
    const originalArgv = process.argv;
    process.argv = ["node", "openclaw", "onboard", "--json"];
    try {
      await ensureConfigReady({
        runtime,
        commandPath: ["onboard"],
        suppressDoctorStdout: true,
      });
    } finally {
      process.argv = originalArgv;
    }

    expect(runtime.log).toHaveBeenCalledOnce();
    expect(JSON.parse(String(runtime.log.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        type: "cli_error",
        message: "OpenClaw config is invalid: /tmp/openclaw.json",
      },
      issues: [{ path: "channels.quietchat", message: "invalid" }],
    });
    expect(recoveryMocks.confirm).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("preserves protocol-owned stdout for MCP serve", async () => {
    setInvalidSnapshot();
    const runtime = makeRuntime();
    const originalArgv = process.argv;
    process.argv = ["node", "openclaw", "mcp", "serve"];
    try {
      await ensureConfigReady({
        runtime,
        commandPath: ["mcp", "serve"],
        suppressDoctorStdout: true,
      });
    } finally {
      process.argv = originalArgv;
    }

    expect(runtime.log).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("keeps invalid Nix config on the manual recovery path", async () => {
    setInvalidSnapshot();
    setTestEnvValue("OPENCLAW_NIX_MODE", "1");
    const runtime = makeRuntime();
    const confirm = recoveryMocks.confirm;
    recoveryMocks.isInteractive.mockReturnValue(true);

    await ensureConfigReady({ runtime: runtime as never, commandPath: ["gateway", "run"] });

    expect(confirm).not.toHaveBeenCalled();
    expect(plainErrorCalls(runtime).join("\n")).toContain("OPENCLAW_NIX_MODE=1");
    expect(runtime.exit).toHaveBeenCalledWith(78);
  });

  it("replaces doctor fix advice for plugin packaging-only invalid config", async () => {
    setInvalidSnapshot({
      issues: [
        {
          path: "plugins.slots.memory",
          message: "plugin not found: source-only-pack",
        },
      ],
      warnings: [
        {
          path: "plugins",
          message:
            "plugin source-only-pack: installed plugin package requires compiled runtime output for TypeScript entry index.ts: expected ./dist/index.js. This is a plugin packaging issue, not a local config problem.",
        },
      ],
    });
    const runtime = await runEnsureConfigReady(["message"]);
    const calls = plainErrorCalls(runtime);

    expect(calls).toContain(`Fix: ${pluginPackagingRecoveryHint}`);
    expect(calls).not.toContain(`Fix: ${formatCliCommand("openclaw doctor --fix")}`);
    expect(runtime.exit).toHaveBeenCalledWith(1);

    const gatewayRuntime = await runEnsureConfigReady(["gateway", "start"]);
    expect(gatewayRuntime.exit).toHaveBeenCalledWith(78);
  });

  it("allows read-only invalid-config commands but blocks gateway startup", async () => {
    setInvalidSnapshot({
      issues: [{ path: "agents.defaults", message: 'Unrecognized key: "agentRuntime"' }],
    });
    const statusRuntime = await runEnsureConfigReady(["status"]);
    expect(statusRuntime.exit).not.toHaveBeenCalled();

    const auditRuntime = await runEnsureConfigReady(["audit"]);
    expect(auditRuntime.exit).not.toHaveBeenCalled();

    const bareGatewayRuntime = await runEnsureConfigReady(["gateway"]);
    expect(bareGatewayRuntime.exit).toHaveBeenCalledWith(78);

    const gatewayRunRuntime = await runEnsureConfigReady(["gateway", "run"]);
    expect(gatewayRunRuntime.exit).toHaveBeenCalledWith(78);

    const gatewayStartRuntime = await runEnsureConfigReady(["gateway", "start"]);
    expect(gatewayStartRuntime.exit).toHaveBeenCalledWith(78);

    const gatewayRestartRuntime = await runEnsureConfigReady(["gateway", "restart"]);
    expect(gatewayRestartRuntime.exit).toHaveBeenCalledWith(78);

    const gatewayRuntime = await runEnsureConfigReady(["gateway", "health"]);
    expect(gatewayRuntime.exit).not.toHaveBeenCalled();

    const doctorRuntime = await runEnsureConfigReady(["doctor", "fix"]);
    expect(doctorRuntime.exit).not.toHaveBeenCalled();
    expect(doctorRuntime.error).toHaveBeenCalledWith(expect.stringContaining("agentRuntime"));
    expect(getProcessPluginCache()).toBe(processCache);
  });

  it("keeps gateway start restartable when configuration could not be read", async () => {
    setInvalidSnapshot({
      issues: [{ path: "", errorCode: "CONFIG_READ_FAILED", message: "read failed: ENOSPC" }],
    });
    const runtime = makeRuntime();
    const confirm = recoveryMocks.confirm;
    recoveryMocks.isInteractive.mockReturnValue(true);
    await ensureConfigReady({
      runtime,
      commandPath: ["gateway", "start"],
    });
    expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(plainErrorCalls(runtime).join("\n")).not.toContain("doctor --fix");
  });

  it("does not suppress unrelated concurrent stdout writes while suppressing preflight notes", async () => {
    let releasePreflight: (() => void) | undefined;
    let preflightStarted: (() => void) | undefined;
    const preflightStartedPromise = new Promise<void>((resolve) => {
      preflightStarted = resolve;
    });
    const releasePreflightPromise = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    runStartupConfigPreflightMock.mockImplementation(async () => {
      note("Startup warnings", "Config warnings");
      preflightStarted?.();
      await releasePreflightPromise;
      return {
        snapshot: makeSnapshot(),
        baseConfig: {},
      };
    });

    let callbackCalled = false;
    const output = await withCapturedStdout(async () => {
      const ready = runEnsureConfigReady(["message"], true);
      await preflightStartedPromise;
      process.stdout.write("Concurrent output\n", () => {
        callbackCalled = true;
      });
      releasePreflight?.();
      await ready;
    });

    expect(output).toContain("Concurrent output");
    expect(output).not.toContain("Startup warnings");
    expect(callbackCalled).toBe(true);
  });
});
