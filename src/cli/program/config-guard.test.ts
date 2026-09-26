// Config guard tests cover program-level config checks before command execution.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { note } from "../../../packages/terminal-core/src/note.js";
import type { ConfigSnapshotReadMeasure } from "../../config/io.js";
import { getGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-state.js";
import {
  adoptProcessPluginCache,
  createPluginCache,
  getProcessPluginCache,
  withPluginCache,
} from "../../plugins/plugin-cache.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { ExitError } from "../../runtime.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { VERSION } from "../../version.js";
import { formatCliCommand } from "../command-format.js";
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

type ConfigIssue = { path: string; pathSegments?: Array<string | number>; message: string };

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
    resetConfigGuardStateForTests();
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    useTempOpenClawHome();
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
    ["prepares non-observing status snapshots", ["status"], 1],
    ["leaves Doctor orchestration to Doctor itself", ["doctor"], 0],
    ["skips state preparation for update status", ["update", "status"], 0],
    ["skips state preparation for health", ["health"], 0],
    ["skips state preparation for logs", ["logs"], 0],
    ["skips state preparation for sessions", ["sessions"], 0],
    ["skips state preparation for remote gateway calls", ["gateway", "call"], 0],
    ["skips state preparation for gateway restart control", ["gateway", "restart"], 0],
    ["skips state preparation for legacy daemon restart control", ["daemon", "restart"], 0],
    ["skips state preparation for config set", ["config", "set"], 0],
    ["skips state preparation for config patch", ["config", "patch"], 0],
    ["skips state preparation for config get", ["config", "get"], 0],
    ["skips state preparation for config unset", ["config", "unset"], 0],
    ["prepares ordinary agent snapshots", ["agent"], 1],
    ["prepares plugin listing snapshots", ["plugins", "list"], 1],
    ["prepares snapshots for operational commands", ["message"], 1],
    ["prepares snapshots for unknown commands", ["unknown-command"], 1],
    ["prepares snapshots when the command path is empty", [], 1],
  ])("%s", async (_name, commandPath, expectedPreflightCalls) => {
    await runEnsureConfigReady(commandPath);
    expect(runStartupConfigPreflightMock).toHaveBeenCalledTimes(expectedPreflightCalls);
    expect(getProcessPluginCache()).toBe(processCache);
    if (expectedPreflightCalls > 0) {
      expect(runStartupConfigPreflightMock).toHaveBeenCalledWith({
        gateway: false,
        ...(commandPath[0] === "status" ? { observe: false } : {}),
      });
    }
  });

  it("keeps status config guard reads non-observing", async () => {
    await runEnsureConfigReady(["status"]);

    expect(runStartupConfigPreflightMock).toHaveBeenCalledWith({ gateway: false, observe: false });
  });

  it("keeps logs config guard reads non-observing and independent of plugin state", async () => {
    await runEnsureConfigReady(["logs"]);

    expect(readConfigFileSnapshotMock).toHaveBeenCalledWith({
      observe: false,
      pluginValidation: "core-only",
    });
  });

  it("validates config without observing health, plugins, or startup migrations", async () => {
    await ensureConfigReady({
      runtime: makeRuntime() as never,
      commandPath: ["nodes", "approve"],
      validateConfigOnly: true,
    });

    expect(readConfigFileSnapshotMock).toHaveBeenCalledWith({
      observe: false,
      pluginValidation: "core-only",
    });
    expect(runStartupConfigPreflightMock).not.toHaveBeenCalled();
  });

  it("keeps remote gateway call config reads non-observing", async () => {
    await runEnsureConfigReady(["gateway", "call"]);

    expect(readConfigFileSnapshotMock).toHaveBeenCalledWith({ observe: false });
  });

  it.each([
    [["gateway"], false],
    [["gateway"], true],
    [["gateway", "run"], false],
    [["gateway", "run"], true],
  ])(
    "retains accepted startup facts for %j (suppressed: %s)",
    async (commandPath, suppressDoctorStdout) => {
      await runEnsureConfigReady(commandPath, suppressDoctorStdout);

      expect(runStartupConfigPreflightMock).toHaveBeenCalledWith({
        gateway: true,
        validateStartupConfig: expect.any(Function),
      });
      expect(getProcessPluginCache() === preflightCache).toBe(true);
      // Cache reuse must not freeze the Gateway inventory before its final config read.
      expect(getGatewayPluginMetadataSnapshot()).toBeUndefined();
    },
  );

  it("keeps the process owner when accepted config preparation fails", async () => {
    const error = new Error("runtime config preparation failed");
    setRuntimeConfigSnapshotMock.mockImplementationOnce(() => {
      throw error;
    });

    await expect(runEnsureConfigReady(["gateway", "run"])).rejects.toThrow(error);

    expect(getProcessPluginCache()).toBe(processCache);
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

  it("keeps Gateway probes on snapshot-only readiness", async () => {
    await runEnsureConfigReady(["gateway", "health"]);

    expect(runStartupConfigPreflightMock).toHaveBeenCalledWith({
      gateway: false,
    });
    expect(getProcessPluginCache()).toBe(processCache);
  });

  it("pins a valid preflight snapshot for command code reuse", async () => {
    const snapshot = {
      ...makeSnapshot(),
      config: { runtime: true },
      runtimeConfig: { runtime: true, materialized: true },
      sourceConfig: { source: true },
    };
    readConfigFileSnapshotMock.mockResolvedValue(snapshot);

    await runEnsureConfigReady(["health"]);

    expect(setRuntimeConfigSnapshotMock).toHaveBeenCalledWith(
      snapshot.runtimeConfig,
      snapshot.sourceConfig,
    );
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

  it("pins plugin listing config from ordinary readiness", async () => {
    const snapshot = {
      ...makeSnapshot(),
      config: { plugins: { entries: { alpha: { enabled: true } } } },
      runtimeConfig: { plugins: { entries: { alpha: { enabled: true } } } },
      sourceConfig: { plugins: { entries: { alpha: { enabled: true } } } },
    };
    runStartupConfigPreflightMock.mockResolvedValue({
      snapshot,
      baseConfig: snapshot.sourceConfig,
    });

    await runEnsureConfigReady(["plugins", "list"]);

    expect(runStartupConfigPreflightMock).toHaveBeenCalledOnce();
    expect(setRuntimeConfigSnapshotMock).toHaveBeenCalledWith(
      snapshot.runtimeConfig,
      snapshot.sourceConfig,
    );
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

  it.each([
    { commandPath: ["message"] },
    { commandPath: ["tasks"] },
    { commandPath: ["tasks", "list"] },
    { commandPath: ["tasks", "audit"] },
  ])(
    "exits for invalid config on non-allowlisted command: $commandPath",
    async ({ commandPath }) => {
      setInvalidSnapshot();
      const runtime = await runEnsureConfigReady(commandPath);

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
    },
  );

  it("renders unknown keys and received values with the shared source diagnostics", async () => {
    setInvalidSnapshot({
      raw: '{\n  "meta": { "migrations": { "futureMarker": true } },\n  "gateway": { "port": "nope" }\n}',
      parsed: {
        meta: { migrations: { futureMarker: true } },
        gateway: { port: "nope" },
      },
      sourceConfig: {
        meta: { migrations: { futureMarker: true } },
        gateway: { port: "nope" },
      },
      issues: [
        {
          path: "meta",
          pathSegments: ["meta"],
          message: 'Unrecognized key: "migrations"',
        },
        {
          path: "gateway.port",
          pathSegments: ["gateway", "port"],
          message: "Invalid input: expected number",
        },
      ],
    });

    const runtime = await runEnsureConfigReady(["message"]);
    const output = plainErrorCalls(runtime).join("\n");

    expect(output).toContain('  - openclaw.json:2 — meta: Unrecognized key: "migrations"');
    expect(output).toContain(
      '  - openclaw.json:3 — gateway.port: Invalid input: expected number, got: "nope"',
    );
  });

  it.each([
    ["9999.1.1", true],
    [VERSION, false],
  ])(
    "shows a config version-skew hint only for newer writers (%s)",
    async (touchedVersion, expected) => {
      setInvalidSnapshot({ sourceConfig: { meta: { lastTouchedVersion: touchedVersion } } });

      const runtime = await runEnsureConfigReady(["message"]);
      const output = plainErrorCalls(runtime).join("\n");
      const hint = `Config was last written by OpenClaw ${touchedVersion}, but you are running ${VERSION} — upgrade or re-run setup.`;

      expect(output.includes(hint)).toBe(expected);
    },
  );

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
    const confirm = vi.fn(async () => true);
    const runDoctor = vi.fn(async () => {});

    await ensureConfigReady(
      { runtime: runtime as never, commandPath: ["message"] },
      { confirm, isInteractive: () => true, runDoctor },
    );

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

  it("does not prompt for repair when stdout belongs to a machine-readable command", async () => {
    setInvalidSnapshot();
    const runtime = makeRuntime();
    const confirm = vi.fn(async () => true);

    await ensureConfigReady(
      {
        runtime: runtime as never,
        commandPath: ["agents", "list"],
        suppressDoctorStdout: true,
      },
      { confirm, isInteractive: () => true },
    );

    expect(confirm).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it.each([
    ["blocked JSON commands", ["onboard"], ["node", "openclaw", "onboard", "--json"], 1, true],
    ["protocol-owned stdout", ["mcp", "serve"], ["node", "openclaw", "mcp", "serve"], 1, false],
    [
      "allowed read-only JSON diagnostics",
      ["status"],
      ["node", "openclaw", "status", "--json"],
      undefined,
      false,
    ],
    [
      "blocked JSON gateway startup",
      ["gateway", "run"],
      ["node", "openclaw", "gateway", "run", "--json"],
      78,
      true,
    ],
  ])(
    "preserves output ownership for %s",
    async (_name, commandPath, argv, exitCode, writesJson) => {
      setInvalidSnapshot();
      const runtime = makeRuntime();
      const originalArgv = process.argv;
      process.argv = argv;
      try {
        await ensureConfigReady({
          runtime,
          commandPath,
          suppressDoctorStdout: true,
        });
      } finally {
        process.argv = originalArgv;
      }

      if (writesJson) {
        expect(runtime.log).toHaveBeenCalledOnce();
        expect(JSON.parse(String(runtime.log.mock.calls[0]?.[0]))).toMatchObject({
          ok: false,
          error: {
            type: "cli_error",
            message: "OpenClaw config is invalid: /tmp/openclaw.json",
          },
          issues: [{ path: "channels.quietchat", message: "invalid" }],
        });
      } else {
        expect(runtime.log).not.toHaveBeenCalled();
      }
      if (exitCode === undefined) {
        expect(runtime.exit).not.toHaveBeenCalled();
      } else {
        expect(runtime.exit).toHaveBeenCalledWith(exitCode);
      }
    },
  );

  it.each(["OPENCLAW_NIX_MODE", "OPENCLAW_CONFIG_READONLY"])(
    "keeps invalid %s config on the manual recovery path",
    async (mode) => {
      setInvalidSnapshot();
      setTestEnvValue(mode, "1");
      const runtime = makeRuntime();
      const confirm = vi.fn(async () => true);

      await ensureConfigReady(
        { runtime: runtime as never, commandPath: ["gateway", "run"] },
        { confirm, isInteractive: () => true },
      );

      expect(confirm).not.toHaveBeenCalled();
      expect(plainErrorCalls(runtime).join("\n")).toContain(`${mode}=1`);
      expect(runtime.exit).toHaveBeenCalledWith(78);
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

  it("allows an explicit invalid-config override", async () => {
    setInvalidSnapshot();
    const runtime = makeRuntime();
    await ensureConfigReady({
      runtime: runtime as never,
      commandPath: ["plugins", "install"],
      allowInvalid: true,
    });
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("does not offer repair for an explicitly allowed gateway startup", async () => {
    setInvalidSnapshot();
    const runtime = makeRuntime();
    const confirm = vi.fn(async () => true);

    await ensureConfigReady(
      {
        runtime: runtime as never,
        commandPath: ["gateway", "run"],
        allowInvalid: true,
      },
      { confirm, isInteractive: () => true },
    );

    expect(confirm).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(getProcessPluginCache()).toBe(processCache);
  });

  it("runs startup readiness only once per module instance", async () => {
    const runtimeA = makeRuntime();
    const runtimeB = makeRuntime();

    await ensureConfigReady({ runtime: runtimeA as never, commandPath: ["message"] });
    await ensureConfigReady({ runtime: runtimeB as never, commandPath: ["message"] });
    expect(runStartupConfigPreflightMock).toHaveBeenCalledTimes(1);
  });

  it("still prepares readiness when stdout suppression is enabled", async () => {
    await runEnsureConfigReady(["message"], true);
    expect(runStartupConfigPreflightMock).toHaveBeenCalledTimes(1);
  });

  it("prevents preflight note noise when suppression is enabled", async () => {
    runStartupConfigPreflightMock.mockImplementation(async () => {
      note("Startup warnings", "Config warnings");
      return {
        snapshot: makeSnapshot(),
        baseConfig: {},
      };
    });
    const output = await withCapturedStdout(async () => {
      await runEnsureConfigReady(["message"], true);
    });
    expect(output).not.toContain("Startup warnings");
  });

  it("allows preflight note noise when suppression is not enabled", async () => {
    runStartupConfigPreflightMock.mockImplementation(async () => {
      note("Startup warnings", "Config warnings");
      return {
        snapshot: makeSnapshot(),
        baseConfig: {},
      };
    });
    const output = await withCapturedStdout(async () => {
      await runEnsureConfigReady(["message"], false);
    });
    expect(output).toContain("Startup warnings");
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
