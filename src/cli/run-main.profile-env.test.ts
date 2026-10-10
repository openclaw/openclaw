// Run-main profile env tests cover profile environment handling in the CLI entrypoint.
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { prepareDoctorDatabasePreflight } from "../commands/doctor-database-preflight.js";
import {
  finalizeDebugProxyCaptureAsync,
  initializeDebugProxyCaptureAsync,
} from "../proxy-capture/runtime.js";
import { ExitError } from "../runtime.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { runCliWithExitFinalization } from "./one-shot-exit.js";

const startup = vi.hoisted(() => ({
  readConfig: vi.fn(async () => ({ proxy: { selected: "synthetic" } })),
  startProxy: vi.fn(async () => null),
  ensurePath: vi.fn(),
  ensureDispatcher: vi.fn(),
  route: vi.fn(async () => true),
  schemas: { incompatible: [], indeterminate: [] },
  prepareDoctorDatabasePreflight: vi.fn<typeof prepareDoctorDatabasePreflight>(),
  runDoctorHealthFlow: vi.fn(),
}));

vi.mock("../commands/doctor-database-preflight.js", () => ({
  prepareDoctorDatabasePreflight: startup.prepareDoctorDatabasePreflight,
}));
vi.mock("../flows/doctor-health.js", () => ({
  runDoctorHealthFlow: startup.runDoctorHealthFlow,
}));
vi.mock("./program/preaction.js", () => ({ registerPreActionHooks() {} }));

vi.mock("../config/io.js", () => ({
  readSourceConfigBestEffort: startup.readConfig,
  readBestEffortConfig: startup.readConfig,
}));

vi.mock("../infra/net/proxy/proxy-lifecycle.js", () => ({
  startProxy: startup.startProxy,
}));

vi.mock("../infra/net/proxy-env.js", () => ({
  hasEnvHttpProxyAgentConfigured: () => true,
}));

vi.mock("../infra/net/undici-global-dispatcher.js", () => ({
  ensureGlobalUndiciEnvProxyDispatcher: startup.ensureDispatcher,
}));

const fileState = vi.hoisted(() => ({
  hasCliDotEnv: false,
}));

const dotenvState = vi.hoisted(() => {
  const state = {
    profileAtDotenvLoad: undefined as string | undefined,
  };
  return {
    state,
    loadDotEnv: vi.fn(() => {
      state.profileAtDotenvLoad = process.env.OPENCLAW_PROFILE;
    }),
  };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  type ExistsSyncPath = Parameters<typeof actual.existsSync>[0];
  return {
    ...actual,
    existsSync: vi.fn((target: ExistsSyncPath) => {
      if (typeof target === "string" && target.endsWith(".env")) {
        return fileState.hasCliDotEnv;
      }
      return actual.existsSync(target);
    }),
  };
});

vi.mock("./dotenv.js", () => ({
  loadCliDotEnv: dotenvState.loadDotEnv,
}));

vi.mock("../infra/env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/env.js")>()),
  normalizeEnv: vi.fn(),
}));

vi.mock("../infra/runtime-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/runtime-guard.js")>()),
  assertSupportedRuntime: vi.fn(async () => {}),
}));

vi.mock("../infra/path-env.js", () => ({
  ensureOpenClawCliOnPath: startup.ensurePath,
}));

vi.mock("./route.js", () => ({
  tryRouteCli: startup.route,
}));

vi.mock("./windows-argv.js", () => ({
  normalizeWindowsArgv: (argv: string[]) => argv,
}));

import { runCli } from "./run-main.js";

describe("runCli environment and passive startup", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const envSnapshot = captureEnv([
    "OPENCLAW_UPDATE_IN_PROGRESS",
    "OPENCLAW_PROFILE",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_CONTAINER",
    "OPENCLAW_GATEWAY_PORT",
    "OPENCLAW_GATEWAY_URL",
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_GATEWAY_PASSWORD",
  ]);

  beforeEach(() => {
    vi.clearAllMocks();
    deleteTestEnvValue("OPENCLAW_UPDATE_IN_PROGRESS");
    startup.prepareDoctorDatabasePreflight.mockResolvedValue(startup.schemas);
    deleteTestEnvValue("OPENCLAW_PROFILE");
    deleteTestEnvValue("OPENCLAW_STATE_DIR");
    deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
    deleteTestEnvValue("OPENCLAW_CONTAINER");
    deleteTestEnvValue("OPENCLAW_GATEWAY_PORT");
    deleteTestEnvValue("OPENCLAW_GATEWAY_URL");
    deleteTestEnvValue("OPENCLAW_GATEWAY_TOKEN");
    deleteTestEnvValue("OPENCLAW_GATEWAY_PASSWORD");
    dotenvState.state.profileAtDotenvLoad = undefined;
    dotenvState.loadDotEnv.mockClear();
    fileState.hasCliDotEnv = false;
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it("defers capture before update, Doctor, and proxy dispatch with debug capture enabled", async () => {
    const stateDir = tempDirs.make("cli-deferred-capture-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "1");
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_REQUIRE", "1");
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_SESSION_ID", "cli-original-state");
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_URL", undefined);
    vi.stubGlobal("fetch", globalThis.fetch);
    const database = resolveOpenClawStateSqlitePath();
    const originalArgv = process.argv;
    const originalExitCode = process.exitCode;
    const originalListeners = process.listeners("uncaughtException");
    try {
      for (const args of [
        ["update"],
        ["proxy", "start"],
        ["proxy", "run", "--", "synthetic-child"],
        ["--update"],
        ["doctor", "--fix", "--non-interactive"],
        ["update", "status"],
        ["update", "--dry-run"],
        ["update", "--help"],
        ["doctor", "--help"],
      ]) {
        if (!args.includes("--help")) {
          startup.route.mockImplementationOnce(async () => {
            expect(existsSync(database), `before dispatch: ${args.join(" ")}`).toBe(false);
            return true;
          });
        }
        const argv = ["node", "openclaw", ...args];
        process.argv = argv;
        await runCliWithExitFinalization({
          run: () => runCli(argv),
          onError: (error) => {
            throw error;
          },
        });
        expect(existsSync(database), `after invocation: ${args.join(" ")}`).toBe(false);
      }
      await initializeDebugProxyCaptureAsync("cli-enabled-control");
      expect(existsSync(database)).toBe(true);
    } finally {
      try {
        await finalizeDebugProxyCaptureAsync();
      } finally {
        try {
          await closeOpenClawStateDatabaseAsync();
        } finally {
          process.argv = originalArgv;
          process.exitCode = originalExitCode;
          for (const listener of process.listeners("uncaughtException")) {
            if (!originalListeners.includes(listener)) {
              process.off("uncaughtException", listener);
            }
          }
          vi.unstubAllGlobals();
          vi.unstubAllEnvs();
        }
      }
    }
  });

  it("carries the single early update preflight through Commander into Doctor", async () => {
    setTestEnvValue("OPENCLAW_UPDATE_IN_PROGRESS", "1");
    startup.route.mockResolvedValueOnce(false);
    const argv = ["node", "openclaw", "doctor", "--fix", "--non-interactive"];
    const originalArgv = process.argv;
    const originalListeners = process.listeners("uncaughtException");
    process.argv = argv;
    try {
      await expect(runCli(argv)).rejects.toEqual(new ExitError(0));
    } finally {
      process.argv = originalArgv;
      for (const listener of process.listeners("uncaughtException")) {
        if (!originalListeners.includes(listener)) {
          process.off("uncaughtException", listener);
        }
      }
    }

    // Omitted options and explicit undefined both select the full fleet.
    expect(
      startup.prepareDoctorDatabasePreflight.mock.calls.map(([options]) => options?.scope),
    ).toEqual([undefined]);
    expect(startup.prepareDoctorDatabasePreflight).toHaveBeenCalledBefore(startup.startProxy);
    expect(startup.runDoctorHealthFlow).toHaveBeenCalledExactlyOnceWith(
      expect.any(Object),
      expect.objectContaining({ repair: true, nonInteractive: true }),
      undefined,
      startup.schemas,
    );
  });

  it.each([
    ["--channel", "--", "cleanup"],
    ["cleanup", "--version"],
  ])("keeps cleanup passive before dispatch: %j", async (...args) => {
    const argv = ["node", "openclaw", "update", ...args];
    await runCli(argv);

    expect(startup.route).toHaveBeenCalledWith(argv);
    expect({
      configReads: startup.readConfig.mock.calls.length,
      proxyStarts: startup.startProxy.mock.calls.length,
      pathEnsures: startup.ensurePath.mock.calls.length,
      dispatcherEnsures: startup.ensureDispatcher.mock.calls.length,
    }).toEqual({ configReads: 0, proxyStarts: 0, pathEnsures: 0, dispatcherEnsures: 0 });
  });

  it.each(["--channel"])("retains update startup when cleanup is the value of %s", async (flag) => {
    await runCli(["node", "openclaw", "update", flag, "cleanup"]);
    expect(startup.readConfig).toHaveBeenCalledOnce();
    expect(startup.startProxy).toHaveBeenCalledWith({ selected: "synthetic" });
    expect(startup.ensurePath).toHaveBeenCalledOnce();
    expect(startup.ensureDispatcher).toHaveBeenCalledOnce();
  });

  it("applies --profile before dotenv loading", async () => {
    fileState.hasCliDotEnv = true;
    await runCli(["node", "openclaw", "--profile", "rawdog", "status"]);

    expect(dotenvState.loadDotEnv).toHaveBeenCalledOnce();
    expect(dotenvState.state.profileAtDotenvLoad).toBe("rawdog");
    expect(process.env.OPENCLAW_PROFILE).toBe("rawdog");
  });

  it("rejects --container combined with interleaved --dev", async () => {
    await expect(
      runCli(["node", "openclaw", "status", "--container", "demo", "--dev"]),
    ).rejects.toThrow("--container cannot be combined with --profile/--dev");
  });
});
