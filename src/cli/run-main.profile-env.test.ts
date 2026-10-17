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
  prepareDatabase: vi.fn(async () => {}),
  startProxy: vi.fn(async () => null),
  ensurePath: vi.fn(),
  ensureDispatcher: vi.fn(),
  route: vi.fn(async () => true),
  schemas: { incompatible: [], indeterminate: [] },
  prepareDoctorDatabasePreflight: vi.fn<typeof prepareDoctorDatabasePreflight>(),
  runDoctorHealthFlow: vi.fn(),
  hasCliDotEnv: false,
  profileAtDotenvLoad: undefined as string | undefined,
  loadDotEnv: vi.fn((): void => {
    startup.profileAtDotenvLoad = process.env.OPENCLAW_PROFILE;
  }),
}));
vi.mock("../commands/doctor-database-preflight.js", () => ({
  prepareDoctorDatabasePreflight: startup.prepareDoctorDatabasePreflight,
}));
vi.mock("../flows/doctor-health.js", () => ({ runDoctorHealthFlow: startup.runDoctorHealthFlow }));
vi.mock("./program/preaction.js", () => ({ registerPreActionHooks() {} }));
// mock-isolation: This suite tests dispatch ordering; engine routing has separate boundary coverage.
vi.mock("./database-engine-selection.js", () => ({
  prepareCliDatabaseEngine: startup.prepareDatabase,
}));
vi.mock("../config/io.js", () => ({
  readSourceConfigBestEffort: startup.readConfig,
  readBestEffortConfig: startup.readConfig,
}));
vi.mock("../infra/net/proxy/proxy-lifecycle.js", () => ({ startProxy: startup.startProxy }));
vi.mock("../infra/net/proxy-env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/net/proxy-env.js")>()),
  hasEnvHttpProxyAgentConfigured: () => true,
}));
vi.mock("../infra/net/undici-global-dispatcher.js", () => ({
  ensureGlobalUndiciEnvProxyDispatcher: startup.ensureDispatcher,
}));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  type ExistsSyncPath = Parameters<typeof actual.existsSync>[0];
  return {
    ...actual,
    existsSync: vi.fn((target: ExistsSyncPath) => {
      if (typeof target === "string" && target.endsWith(".env")) {
        return startup.hasCliDotEnv;
      }
      return actual.existsSync(target);
    }),
  };
});
vi.mock("./dotenv.js", () => ({ loadCliDotEnv: startup.loadDotEnv }));
vi.mock("../infra/env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/env.js")>()),
  normalizeEnv: vi.fn(),
}));
vi.mock("../infra/runtime-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/runtime-guard.js")>()),
  assertSupportedRuntime: vi.fn(async () => {}),
}));
vi.mock("../infra/path-env.js", () => ({ ensureOpenClawCliOnPath: startup.ensurePath }));
vi.mock("./route.js", () => ({ tryRouteCli: startup.route }));
vi.mock("./windows-argv.js", () => ({
  normalizeWindowsArgv: (argv: string[]) => argv,
}));

import { runCli } from "./run-main.js";

describe("runCli environment and passive startup", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const envKeys =
    "UPDATE_IN_PROGRESS PROFILE STATE_DIR CONFIG_PATH CONTAINER GATEWAY_PORT GATEWAY_URL GATEWAY_TOKEN GATEWAY_PASSWORD"
      .split(" ")
      .map((key) => `OPENCLAW_${key}`);
  const envSnapshot = captureEnv(envKeys);
  let originalArgv: string[];
  let originalExitCode: typeof process.exitCode;
  let originalListeners: ReturnType<typeof process.listeners>;

  beforeEach(() => {
    originalArgv = process.argv;
    originalExitCode = process.exitCode;
    originalListeners = process.listeners("uncaughtException");
    vi.clearAllMocks();
    startup.prepareDoctorDatabasePreflight.mockResolvedValue(startup.schemas);
    envKeys.forEach(deleteTestEnvValue);
    startup.profileAtDotenvLoad = undefined;
    startup.hasCliDotEnv = false;
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    for (const listener of process.listeners("uncaughtException")) {
      if (!originalListeners.includes(listener)) {
        process.off("uncaughtException", listener);
      }
    }
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
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
        const argv = (process.argv = ["node", "openclaw", ...args]);
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
      await finalizeDebugProxyCaptureAsync().finally(() => closeOpenClawStateDatabaseAsync());
    }
  });

  it("carries the single early update preflight through Commander into Doctor", async () => {
    setTestEnvValue("OPENCLAW_UPDATE_IN_PROGRESS", "1");
    startup.route.mockResolvedValueOnce(false);
    process.argv = ["node", "openclaw", "doctor", "--fix", "--non-interactive"];
    await expect(runCli(process.argv)).rejects.toEqual(new ExitError(0));
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
    { args: ["--channel", "--", "cleanup"], starts: 0 },
    { args: ["cleanup", "--version"], starts: 0 },
    { args: ["--channel", "cleanup"], starts: 1 },
  ])("starts update infrastructure only for a channel value: $args", async ({ args, starts }) => {
    const argv = ["node", "openclaw", "update", ...args];
    await runCli(argv);

    expect(startup.route).toHaveBeenCalledWith(argv);
    expect(
      [startup.readConfig, startup.startProxy, startup.ensurePath, startup.ensureDispatcher].map(
        (mock) => mock.mock.calls.length,
      ),
    ).toEqual([starts, starts, starts, starts]);
    if (starts) {
      expect(startup.startProxy).toHaveBeenCalledWith({ selected: "synthetic" });
    }
  });

  it("applies --profile before dotenv loading", async () => {
    startup.hasCliDotEnv = true;
    await runCli(["node", "openclaw", "--profile", "rawdog", "status"]);

    expect(startup.loadDotEnv).toHaveBeenCalledOnce();
    expect(startup.loadDotEnv).toHaveBeenCalledBefore(startup.prepareDatabase);
    expect([startup.profileAtDotenvLoad, process.env.OPENCLAW_PROFILE]).toEqual([
      "rawdog",
      "rawdog",
    ]);
  });

  it("rejects --container combined with interleaved --dev", async () => {
    await expect(
      runCli(["node", "openclaw", "status", "--container", "demo", "--dev"]),
    ).rejects.toThrow("--container cannot be combined with --profile/--dev");
  });
});
