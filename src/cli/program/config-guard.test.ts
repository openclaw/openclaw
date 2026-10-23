import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { note } from "../../../packages/terminal-core/src/note.js";
import type { ConfigSnapshotReadMeasure } from "../../config/io.js";
import type { ConfigValidationIssue, OpenClawConfig } from "../../config/types.js";
import { getGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-state.js";
import {
  adoptProcessPluginCache,
  createPluginCache,
  getPluginCacheRetirementSignal,
  getProcessPluginCache,
  withPluginCache,
} from "../../plugins/plugin-cache.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { ExitError } from "../../runtime.js";
import { withExistingOpenClawStateSchema } from "../../state/openclaw-state-db-schema-policy.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { formatCliCommand } from "../command-format.js";
import { ensureConfigReady, testApi } from "./config-guard.js";
import { captureStdout, expectNoCalls } from "./program.test-helpers.js";

const pluginPackagingRecoveryHint = [
  "This is a plugin packaging issue, not a local config problem.",
  "Update or reinstall the plugin after the publisher ships compiled JavaScript, or disable/uninstall the plugin until then.",
].join("\n");
const resetEnv = [
  "OPENCLAW_NIX_MODE",
  "OPENCLAW_CONFIG_READONLY",
  "OPENCLAW_PROFILE",
  "OPENCLAW_STATE_DIR",
];

const preflightMock = vi.hoisted(() => vi.fn());
const readSnapshotMock = vi.hoisted(() => vi.fn());
const publishConfigMock = vi.hoisted(() => vi.fn());

// mock-isolation: Control startup preflight outcomes without running real repair operations.
vi.mock("../../commands/startup-config-preflight.js", () => ({
  runStartupConfigPreflight: preflightMock,
}));

// mock-isolation: Use explicit invalid and legacy config fixtures without reading operator config.
vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: readSnapshotMock,
  setRuntimeConfigSnapshot: publishConfigMock,
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

function makeSnapshot(config?: OpenClawConfig) {
  return {
    exists: false,
    valid: true,
    raw: null as string | null,
    parsed: {},
    sourceConfig: config ?? {},
    issues: [] as ConfigValidationIssue[],
    warnings: [] as ConfigValidationIssue[],
    legacyIssues: [] as ConfigValidationIssue[],
    path: "/tmp/openclaw.json",
    ...(config ? { config } : {}),
  };
}

const makeRuntime = () => ({ log: vi.fn(), error: vi.fn(), exit: vi.fn() });

function plainErrorCalls(runtime: ReturnType<typeof makeRuntime>): string[] {
  const ansiPattern = new RegExp(String.raw`\u001b\[[0-9;]*m`, "g");
  return runtime.error.mock.calls.map((call) => String(call[0]).replace(ansiPattern, ""));
}

describe("ensureConfigReady", () => {
  const resetConfigGuardStateForTests = testApi.resetConfigGuardStateForTests;
  let home: string;
  let envSnapshot: ReturnType<typeof captureEnv>;
  let processCache: ReturnType<typeof getProcessPluginCache>;
  let cache: ReturnType<typeof createPluginCache>;
  let metadata: ReturnType<typeof createPluginMetadataSnapshotFixture>;
  let statePath: string;
  let runtime: ReturnType<typeof makeRuntime>;
  let originalArgv: string[];

  function preflightResult(snapshot = makeSnapshot()) {
    return { snapshot, baseConfig: {}, pluginCache: cache, pluginMetadataSnapshot: metadata };
  }

  function throwOnExit() {
    runtime.exit.mockImplementation((code: number): never => {
      throw new ExitError(code);
    });
  }

  const guard = (command: string, options: Partial<Parameters<typeof ensureConfigReady>[0]> = {}) =>
    ensureConfigReady({ runtime, commandPath: command ? command.split(" ") : [], ...options });

  async function runGuard(command: string, suppressDoctorStdout = false) {
    const commandRuntime = makeRuntime();
    await guard(command, { runtime: commandRuntime, suppressDoctorStdout });
    return commandRuntime;
  }

  function setInvalidSnapshot(overrides?: Partial<ReturnType<typeof makeSnapshot>>) {
    const snapshot = {
      ...makeSnapshot(),
      exists: true,
      valid: false,
      issues: [{ path: "channels.quietchat", message: "invalid" }],
      ...overrides,
    };
    readSnapshotMock.mockResolvedValue(snapshot);
    preflightMock.mockResolvedValue(preflightResult(snapshot));
    return snapshot;
  }

  beforeEach(() => {
    runtime = makeRuntime();
    originalArgv = process.argv;
    processCache = getProcessPluginCache();
    cache = createPluginCache();
    metadata = withPluginCache(cache, createPluginMetadataSnapshotFixture);
    envSnapshot = captureEnv(["HOME", "OPENCLAW_HOME", ...resetEnv]);
    vi.clearAllMocks();
    recoveryMocks.confirm.mockReset().mockResolvedValue(true);
    recoveryMocks.isInteractive.mockReset().mockReturnValue(false);
    recoveryMocks.runDoctor.mockReset().mockResolvedValue(undefined);
    resetConfigGuardStateForTests();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-guard-"));
    setTestEnvValue("OPENCLAW_HOME", home);
    for (const key of resetEnv) {
      deleteTestEnvValue(key);
    }
    statePath = path.join(home, ".openclaw", "state", "openclaw.sqlite");
    readSnapshotMock.mockResolvedValue(makeSnapshot());
    preflightMock.mockImplementation(async () => preflightResult());
  });

  afterEach(async () => {
    process.argv = originalArgv;
    adoptProcessPluginCache(processCache);
    await cache[Symbol.asyncDispose]();
    envSnapshot.restore();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it.each([
    { command: "connect", valid: true },
    { command: "node run", valid: false },
  ])("validates managed $command with valid=$valid", async ({ command, valid }) => {
    const config = { plugins: { entries: { fixture: { enabled: true } } } };
    readSnapshotMock.mockResolvedValue({
      ...makeSnapshot(config),
      exists: true,
      valid,
      raw: JSON.stringify(config),
      parsed: config,
      runtimeConfig: config,
      issues: valid
        ? []
        : [{ path: "plugins.entries.fixture.config", message: "invalid plugin value" }],
    });
    throwOnExit();
    recoveryMocks.isInteractive.mockReturnValue(true);
    const result = withExistingOpenClawStateSchema({ path: statePath }, () => guard(command));
    if (valid) {
      await result;
      expect(publishConfigMock).toHaveBeenCalledWith(config, config);
      expect(runtime.exit).not.toHaveBeenCalled();
    } else {
      await expect(result).rejects.toMatchObject({ name: "ExitError", code: 1 });
      expectNoCalls(recoveryMocks.isInteractive, publishConfigMock);
      expect(runtime.error.mock.calls.join("\n")).toContain("invalid plugin value");
    }
    expect(preflightMock).not.toHaveBeenCalled();
    expect(readSnapshotMock).toHaveBeenCalledWith({ observe: false });
  });

  it("rejects changed state selectors before config or migration work", async () => {
    await expect(
      withExistingOpenClawStateSchema({ path: statePath }, async () => {
        setTestEnvValue("OPENCLAW_STATE_DIR", path.join(path.dirname(statePath), "other"));
        await guard("node run", { runtime: makeRuntime() });
      }),
    ).rejects.toThrow(/state.*(?:bound|changed)/i);

    expectNoCalls(readSnapshotMock, preflightMock);
  });

  it.each([
    ["update status", 0],
    ["logs", 0],
    ["", 1],
  ])("prepares %s with %s preflight calls", async (command, expectedPreflightCalls) => {
    await runGuard(command);
    expect(preflightMock).toHaveBeenCalledTimes(expectedPreflightCalls);
    expect(getProcessPluginCache()).toBe(processCache);
    if (expectedPreflightCalls > 0) {
      expect(preflightMock).toHaveBeenCalledWith({ gateway: false });
    }
    if (command === "logs") {
      expect(readSnapshotMock).toHaveBeenCalledWith({
        observe: false,
        pluginValidation: "core-only",
      });
    }
  });

  it.each([true, false])("retires non-Gateway preflight resources with valid=%s", async (valid) => {
    if (!valid) {
      setInvalidSnapshot();
    }
    const retired = getPluginCacheRetirementSignal(cache);
    throwOnExit();

    const ready = guard("message");
    if (valid) {
      await ready;
    } else {
      await expect(ready).rejects.toMatchObject({ name: "ExitError", code: 1 });
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
    }

    expect(retired.aborted).toBe(true);
    expect(getProcessPluginCache()).toBe(processCache);
  });

  it("retains accepted startup facts with stdout suppressed", async () => {
    const retired = getPluginCacheRetirementSignal(cache);
    await runGuard("gateway run", true);

    expect(preflightMock).toHaveBeenCalledWith({
      gateway: true,
      validateStartupConfig: expect.any(Function),
    });
    expect(getProcessPluginCache() === cache).toBe(true);
    expect(retired.aborted).toBe(false);
    // Cache reuse must not freeze the Gateway inventory before its final config read.
    expect(getGatewayPluginMetadataSnapshot()).toBeUndefined();
  });

  it("honors a readiness refusal after preflight resources unwind", async () => {
    let preflightUnwound = false;
    preflightMock.mockImplementation(async () => {
      try {
        throw new ExitError(78);
      } finally {
        preflightUnwound = true;
      }
    });
    runtime.exit.mockImplementation(() => {
      expect(preflightUnwound).toBe(true);
    });

    await expect(guard("gateway")).rejects.toMatchObject({ name: "ExitError", code: 78 });

    expect(runtime.exit).toHaveBeenCalledWith(78);
    expect(getProcessPluginCache()).toBe(processCache);
  });

  it.each([
    { command: "health", preflight: false },
    { command: "agent", preflight: true },
  ])(
    "forwards config snapshot measurement with preflight=$preflight",
    async ({ command, preflight }) => {
      const measuredStages: string[] = [];
      const measure: ConfigSnapshotReadMeasure = async (stage, run) => {
        measuredStages.push(stage);
        return await run();
      };
      const read = preflight ? preflightMock : readSnapshotMock;
      read.mockImplementationOnce(async (options?: { measure?: ConfigSnapshotReadMeasure }) => {
        await options?.measure?.("config.snapshot.read.validate", async () => undefined);
        return preflight ? { snapshot: makeSnapshot(), baseConfig: {} } : makeSnapshot();
      });

      await guard(command, { measure });
      expect(measuredStages).toEqual(["config.snapshot.read.validate"]);
    },
  );

  it("retries the cached config snapshot after a read rejection", async () => {
    const transientError = new Error("temporary config read failure");
    readSnapshotMock.mockRejectedValueOnce(transientError).mockResolvedValueOnce(makeSnapshot());

    await expect(runGuard("health")).rejects.toThrow(transientError);
    await expect(runGuard("health")).resolves.toBeDefined();
    await expect(runGuard("health")).resolves.toBeDefined();

    expect(readSnapshotMock).toHaveBeenCalledTimes(2);
    expect(publishConfigMock).toHaveBeenCalledWith(undefined, {});
  });

  it("runs doctor and retries the config guard once after consent", async () => {
    const invalidSnapshot = setInvalidSnapshot();
    const validSnapshot = makeSnapshot({ gateway: { mode: "local" } });
    preflightMock
      .mockResolvedValueOnce({ snapshot: invalidSnapshot, baseConfig: {} })
      .mockResolvedValueOnce({ snapshot: validSnapshot, baseConfig: validSnapshot.config });
    readSnapshotMock.mockResolvedValue(validSnapshot);
    recoveryMocks.isInteractive.mockReturnValue(true);

    await guard("message");

    expect(recoveryMocks.confirm).toHaveBeenCalledWith(
      `Run "${formatCliCommand("openclaw doctor --fix")}" now?`,
      true,
    );
    expect(recoveryMocks.runDoctor).toHaveBeenCalledOnce();
    expect(preflightMock).toHaveBeenCalledTimes(2);
    expect(preflightMock).toHaveBeenLastCalledWith({ gateway: false });
    expectNoCalls(readSnapshotMock, runtime.exit);
    expect(publishConfigMock).toHaveBeenCalledWith(
      validSnapshot.config,
      validSnapshot.sourceConfig,
    );
  });

  it.each([
    ["json", ["onboard", "--json"], 1],
    ["mcp", ["mcp", "serve"], 1],
    ["nix", ["gateway", "run"], 78],
    ["read-failure", ["gateway", "start"], 1],
  ] as const)(
    "handles invalid config for %s without interactive repair",
    async (mode, argv, exitCode) => {
      setInvalidSnapshot(
        mode === "read-failure"
          ? {
              issues: [
                { path: "", errorCode: "CONFIG_READ_FAILED", message: "read failed: ENOSPC" },
              ],
            }
          : {},
      );
      if (mode === "nix") {
        setTestEnvValue("OPENCLAW_NIX_MODE", "1");
      }
      recoveryMocks.isInteractive.mockReturnValue(true);
      process.argv = ["node", "openclaw", ...argv];
      await guard(argv.filter((arg) => !arg.startsWith("--")).join(" "), {
        suppressDoctorStdout: mode === "json" || mode === "mcp",
      });
      expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(exitCode);
      expectNoCalls(recoveryMocks.confirm);
      if (mode === "json") {
        expect(runtime.log).toHaveBeenCalledOnce();
        expect(JSON.parse(String(runtime.log.mock.calls[0]?.[0]))).toMatchObject({
          ok: false,
          error: { type: "cli_error", message: "OpenClaw config is invalid: /tmp/openclaw.json" },
          repairHint: "Run `openclaw doctor --fix` to repair, then retry.",
          issues: [{ path: "channels.quietchat", message: "invalid" }],
        });
      } else if (mode === "mcp") {
        expectNoCalls(runtime.log);
      } else if (mode === "nix") {
        expect(plainErrorCalls(runtime).join("\n")).toContain("OPENCLAW_NIX_MODE=1");
      } else {
        expect(plainErrorCalls(runtime).join("\n")).not.toContain("doctor --fix");
      }
    },
  );

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
    const messageRuntime = await runGuard("message");
    const calls = plainErrorCalls(messageRuntime);

    expect(calls).toContain(`Fix: ${pluginPackagingRecoveryHint}`);
    expect(calls).not.toContain(`Fix: ${formatCliCommand("openclaw doctor --fix")}`);
    expect(messageRuntime.exit).toHaveBeenCalledWith(1);

    const gatewayRuntime = await runGuard("gateway start");
    expect(gatewayRuntime.exit).toHaveBeenCalledWith(78);
  });

  it("allows read-only invalid-config commands but blocks gateway startup", async () => {
    setInvalidSnapshot({
      issues: [{ path: "agents.defaults", message: 'Unrecognized key: "agentRuntime"' }],
    });
    for (const command of ["status", "audit", "gateway health"]) {
      expect((await runGuard(command)).exit).not.toHaveBeenCalled();
    }
    for (const command of ["gateway", "gateway run", "gateway start", "gateway restart"]) {
      expect((await runGuard(command)).exit).toHaveBeenCalledWith(78);
    }

    const doctorRuntime = await runGuard("doctor fix");
    expect(doctorRuntime.exit).not.toHaveBeenCalled();
    expect(doctorRuntime.error).toHaveBeenCalledWith(expect.stringContaining("agentRuntime"));
    expect(getProcessPluginCache()).toBe(processCache);
  });

  it("does not suppress unrelated concurrent stdout writes while suppressing preflight notes", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    preflightMock.mockImplementation(async () => {
      note("Startup warnings", "Config warnings");
      started.resolve();
      await release.promise;
      return { snapshot: makeSnapshot(), baseConfig: {} };
    });

    let callbackCalled = false;
    const output = await captureStdout(async () => {
      const ready = runGuard("message", true);
      await started.promise;
      process.stdout.write("Concurrent output\n", () => {
        callbackCalled = true;
      });
      release.resolve();
      await ready;
    });

    expect(output).toContain("Concurrent output");
    expect(output).not.toContain("Startup warnings");
    expect(callbackCalled).toBe(true);
  });
});
