import { ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Installer from "../../scripts/lib/cross-os-release-checks/install.ts";
import type * as Process from "../../scripts/lib/cross-os-release-checks/process.ts";
import type * as Runtime from "../../scripts/lib/cross-os-release-checks/runtime.ts";
import { sleep } from "../../scripts/lib/cross-os-release-checks/shared.ts";
import { createScriptTestHarness } from "./test-helpers.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn), spawnSync: vi.fn(actual.spawnSync) };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

vi.mock("../../scripts/lib/cross-os-release-checks/shared.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/cross-os-release-checks/shared.ts")>()),
  sleep: vi.fn(),
}));

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  // Native socket prototypes outlive a test file in shared workers.
  return { ...actual, createServer: vi.fn(actual.createServer) };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, tmpdir: vi.fn(actual.tmpdir) };
});

const mocks = vi.hoisted(() => ({
  ensureLocalNpmShim: vi.fn(),
  ensureDevUpdateGitInstall: vi.fn(),
  installPackageSpec: vi.fn(),
  installTarballPackage: vi.fn(),
  readInstalledMetadata: vi.fn(),
  readInstalledVersion: vi.fn(),
  runAgentTurn: vi.fn(),
  runBundledPluginPostinstall: vi.fn(),
  runDashboardSmoke: vi.fn(),
  runModelsSet: vi.fn(),
  runInstalledModelsSet: vi.fn(),
  runInstallerSmoke: vi.fn(),
  resolveInstallerTargetVersion: vi.fn(),
  runCommand: vi.fn(),
  runOpenClaw: vi.fn(),
  startGateway: vi.fn(),
  stopGateway: vi.fn(),
  waitForGateway: vi.fn(),
  verifyFreshShellCommand: vi.fn(),
}));

vi.mock(import("../../scripts/lib/cross-os-release-checks/install.ts"), async (importOriginal) => ({
  ...(await importOriginal()),
  ensureLocalNpmShim: mocks.ensureLocalNpmShim,
  installPackageSpec: mocks.installPackageSpec,
  installTarballPackage: mocks.installTarballPackage,
  readInstalledMetadata: mocks.readInstalledMetadata,
  readInstalledVersion: mocks.readInstalledVersion,
  runBundledPluginPostinstall: mocks.runBundledPluginPostinstall,
}));

vi.mock(import("../../scripts/lib/cross-os-release-checks/runtime.ts"), async (importOriginal) => ({
  ...(await importOriginal()),
  runAgentTurn: mocks.runAgentTurn,
  runDashboardSmoke: mocks.runDashboardSmoke,
  runModelsSet: mocks.runModelsSet,
  runOpenClaw: mocks.runOpenClaw,
  startGateway: mocks.startGateway,
  waitForGateway: mocks.waitForGateway,
}));

vi.mock(import("../../scripts/lib/cross-os-release-checks/process.ts"), async (importOriginal) => ({
  ...(await importOriginal()),
  stopGateway: mocks.stopGateway,
  runCommand: mocks.runCommand,
  runCommandInvocation: (invocation: { command: string; args: string[] }, options: unknown) =>
    mocks.runCommand(invocation.command, invocation.args, options),
}));

vi.mock(
  import("../../scripts/lib/cross-os-release-checks/installed.ts"),
  async (importOriginal) => ({
    ...(await importOriginal()),
    ensureDevUpdateGitInstall: mocks.ensureDevUpdateGitInstall,
    resolveInstallerTargetVersion: mocks.resolveInstallerTargetVersion,
    runInstalledAgentTurn: mocks.runAgentTurn,
    runInstalledCli: mocks.runOpenClaw,
    runInstalledModelsSet: mocks.runInstalledModelsSet,
    runInstallerSmoke: mocks.runInstallerSmoke,
    startManualGatewayFromInstalledCli: mocks.startGateway,
    verifyFreshShellCommand: mocks.verifyFreshShellCommand,
    waitForInstalledGateway: mocks.waitForGateway,
  }),
);

import {
  runDevUpdateSuite,
  runFreshLane,
  runUpgradeLane,
} from "../../scripts/lib/cross-os-release-checks/lanes.ts";

const { createTempDir, trackTempDir } = createScriptTestHarness();

const candidate = {
  candidateTgz: "/tmp/openclaw-candidate.tgz",
  candidateVersion: "2026.8.28-beta.1",
  candidateFileName: "openclaw-candidate.tgz",
  sourceDir: "/tmp/source",
  sourceSha: "abc123",
};

let logsDir: string;

function commandResult(stdout = "", exitCode = 0, stderr = "") {
  return { exitCode, stdout, stderr };
}

function jsonResult(value: unknown, exitCode = 0) {
  return commandResult(JSON.stringify(value), exitCode);
}

function gatewayFixture(logPath = "/tmp/upgrade-gateway.log") {
  return { child: {}, closeLog: vi.fn(), launchLogOffset: 0, logPath, waitForClose: vi.fn() };
}

function tempEnv(path: string) {
  return { TEMP: path, TMP: path, TMPDIR: path, Temp: path };
}

function stubTemp(path: string) {
  for (const [key, value] of Object.entries(tempEnv(path))) {
    vi.stubEnv(key, value);
  }
}

function windows() {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
}

function readLog(name = "upgrade-update") {
  return readFileSync(join(logsDir, `${name}.log`), "utf8");
}

function installedVersion(version: string) {
  mocks.readInstalledMetadata.mockReturnValue({ version, commit: candidate.sourceSha });
}

function expectCalls(count: number, ...functions: Array<ReturnType<typeof vi.fn>>) {
  for (const fn of functions) {
    expect(fn).toHaveBeenCalledTimes(count);
  }
}

function expectUpdateEnv(env: NodeJS.ProcessEnv) {
  expect(mocks.runOpenClaw).toHaveBeenCalledWith(
    expect.objectContaining({
      args: expect.arrayContaining(["update", "--json"]),
      env: expect.objectContaining(env),
    }),
  );
}

const updateTimeout = () =>
  new Error(
    "Command timed out: C:\\prefix\\node_modules\\openclaw\\openclaw.mjs update --tag http://127.0.0.1:49951/openclaw-candidate.tgz --yes --json --no-restart --timeout 600",
  );

function expectPhases(
  result: Awaited<ReturnType<typeof runUpgradeLane>>,
  phases: Record<string, string>,
) {
  for (const [name, status] of Object.entries(phases)) {
    expect(result.phaseTimings).toContainEqual(expect.objectContaining({ name, status }));
  }
}

function cliCalls(command: string) {
  return mocks.runOpenClaw.mock.calls
    .map(([call]) => call)
    .filter((call) => call.args[0] === command);
}

function upgradeParams() {
  return {
    baselineSpec: "openclaw@2026.7.1",
    baselineTgz: "",
    build: candidate,
    candidateUrl: "http://127.0.0.1:49951/openclaw-candidate.tgz",
    ref: "main",
    sourceSha: candidate.sourceSha,
    runDiscordRoundtrip: false,
    companions: [],
    logsDir,
    providerConfig: {
      extensionId: "openai",
      secretEnv: "OPENAI_API_KEY",
      authChoice: "openai-api-key",
      model: "openai/gpt-5.6-luna",
      requiredCompanionPackages: [],
    },
    providerSecretValue: "secret",
  };
}
function arrangeSuccessfulLane() {
  mocks.installPackageSpec.mockResolvedValue(undefined);
  mocks.installTarballPackage.mockResolvedValue(undefined);
  mocks.readInstalledVersion
    .mockReturnValueOnce("2026.7.1")
    .mockReturnValue(candidate.candidateVersion);
  installedVersion(candidate.candidateVersion);
  mocks.runBundledPluginPostinstall.mockResolvedValue(undefined);
  mocks.runCommand.mockResolvedValue(commandResult());
  mocks.runOpenClaw.mockResolvedValue(commandResult("{}"));
  mocks.resolveInstallerTargetVersion.mockResolvedValue("2026.7.1");
  mocks.runInstallerSmoke.mockImplementation(async ({ lane }) => trackTempDir(lane.rootDir));
  mocks.verifyFreshShellCommand.mockResolvedValue({ cliPath: join(logsDir, "openclaw") });
  mocks.ensureDevUpdateGitInstall.mockResolvedValue({ cliPath: join(logsDir, "openclaw") });
  mocks.runModelsSet.mockResolvedValue(undefined);
  mocks.startGateway.mockResolvedValue(gatewayFixture());
  mocks.waitForGateway.mockResolvedValue(undefined);
  mocks.runDashboardSmoke.mockResolvedValue(undefined);
  mocks.runAgentTurn.mockResolvedValue(commandResult("OK"));
}

describe("cross-OS manual gateway lane evidence", () => {
  beforeEach(() => {
    logsDir = createTempDir("openclaw-upgrade-lane-test-");
    mocks.ensureLocalNpmShim.mockImplementation(({ rootDir }) => trackTempDir(rootDir));
    vi.mocked(sleep).mockResolvedValue(undefined);
    arrangeSuccessfulLane();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.mocked(tmpdir).mockRestore();
    vi.mocked(rmSync).mockRestore();
    vi.mocked(spawn).mockRestore();
    vi.mocked(spawnSync).mockRestore();
    vi.mocked(sleep).mockReset();
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
  });

  it("passes inherited Windows temp directories to the published updater", async () => {
    const shortTemp = String.raw`C:\Users\RUNNER~1\AppData\Local\Temp`;
    const longTemp = String.raw`C:\Users\runneradmin\AppData\Local\Temp`;
    vi.mocked(tmpdir).mockReturnValue(logsDir);
    windows();
    const realpath = vi.spyOn(realpathSync, "native").mockReturnValue(longTemp);
    stubTemp(shortTemp);

    const result = await runUpgradeLane(upgradeParams());

    expect(result).toMatchObject({ status: "pass" });
    const expectedEnv = tempEnv(longTemp);
    expect(mocks.installPackageSpec).toHaveBeenCalledWith(
      expect.objectContaining({ env: expect.objectContaining(expectedEnv) }),
    );
    expectUpdateEnv(expectedEnv);
    expect(process.env.TEMP).toBe(shortTemp);
    expect(realpath).toHaveBeenCalledWith(shortTemp);
  });

  it.runIf(process.platform !== "win32")(
    "canonicalizes macOS temp paths before invoking the published updater",
    async () => {
      const createdPhysicalTemp = join(logsDir, "physical-temp");
      const aliasedTemp = join(logsDir, "aliased-temp");
      mkdirSync(createdPhysicalTemp);
      const physicalTemp = realpathSync.native(createdPhysicalTemp);
      symlinkSync(physicalTemp, aliasedTemp, process.platform === "win32" ? "junction" : "dir");
      vi.mocked(tmpdir).mockReturnValue(aliasedTemp);
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      stubTemp(aliasedTemp);

      const result = await runUpgradeLane(upgradeParams());

      expect(result).toMatchObject({ status: "pass" });
      const baselineInstall = mocks.installPackageSpec.mock.calls[0]?.[0];
      const underPhysicalTemp = new RegExp(
        `^${physicalTemp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      );
      expect(baselineInstall?.lane.rootDir).toMatch(underPhysicalTemp);
      expect(baselineInstall?.env).toMatchObject(tempEnv(physicalTemp));
      expectUpdateEnv({
        ...tempEnv(physicalTemp),
        NPM_CONFIG_PREFIX: expect.stringMatching(underPhysicalTemp),
      });
      expect(process.env.TEMP).toBe(aliasedTemp);
    },
  );

  describe.each([
    ["fresh", runFreshLane],
    ["dev-update", runDevUpdateSuite],
  ] as const)("%s gateway port ownership", (_name, runLane) => {
    const listeners: Array<{
      server: ReturnType<typeof createServer>;
      closed: ReturnType<typeof vi.fn>;
      port?: number;
    }> = [];

    beforeEach(async () => {
      listeners.length = 0;
      const actual = await vi.importActual<typeof import("node:net")>("node:net");
      vi.mocked(createServer).mockImplementation((...args) => {
        const server = actual.createServer(...args);
        const closed = vi.fn();
        const listener: (typeof listeners)[number] = { server, closed };
        server.on("close", closed);
        server.once("listening", () => {
          const address = server.address();
          if (address && typeof address !== "string") {
            listener.port = address.port;
          }
        });
        listeners.push(listener);
        return server;
      });
    });

    afterEach(async () => {
      try {
        for (const { server } of listeners) {
          if (server.listening) {
            await new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
            });
          }
        }
      } finally {
        // restoreAllMocks does not reset module spies' custom implementations.
        vi.mocked(createServer).mockRestore();
      }
    });

    function expectReservationClosed(port: number) {
      const owners = listeners.filter((listener) => listener.port === port);
      expect(owners).toHaveLength(1);
      const owner = owners[0]!;
      expect(owner.closed).toHaveBeenCalledOnce();
      expect(owner.server.listening).toBe(false);
      expect(owner.server.address()).toBeNull();
    }

    it.each(["success", "onboard"] as const)(
      "reserves the port until spawn or %s cleanup",
      async (outcome) => {
        let port = 0;
        const phases: string[] = [];
        mocks.runCommand.mockImplementation(async (_command, args: string[]) => {
          if (args.includes("onboard")) {
            port = Number(args[args.indexOf("--gateway-port") + 1]);
            phases.push("onboard");
            expect(await probeBind(port)).toBe("EADDRINUSE");
            if (outcome === "onboard") {
              throw new Error("injected onboard failure");
            }
          }
          return commandResult();
        });
        mocks.runModelsSet.mockImplementation(async ({ lane }) => {
          expect(lane.gatewayPort).toBe(port);
          phases.push("models-set");
          expect(await probeBind(port)).toBe("EADDRINUSE");
          if (_name === "fresh") {
            writeFileSync(join(lane.stateDir, "openclaw.json"), "{}\n", "utf8");
          }
        });
        mocks.runInstalledModelsSet.mockImplementation(() =>
          mocks.runModelsSet({ lane: { gatewayPort: port } }),
        );
        mocks.startGateway.mockImplementation(async ({ lane }) => {
          expect(lane.gatewayPort).toBe(port);
          phases.push("start-gateway");
          expectReservationClosed(port);
          return gatewayFixture(join(logsDir, "gateway.log"));
        });

        const result = await runLane(upgradeParams()).catch((error: unknown) => ({
          status: "fail",
          error: String(error),
        }));

        if (outcome === "success") {
          expect(result, JSON.stringify(result)).toMatchObject({ status: "pass" });
          expect(phases).toEqual(["onboard", "models-set", "start-gateway"]);
        } else {
          expect(result, JSON.stringify(result)).toMatchObject({
            status: "fail",
            error: expect.stringContaining(`injected ${outcome} failure`),
          });
          expect(mocks.startGateway).not.toHaveBeenCalled();
        }
        // Failure cleanup and the spawn boundary both relinquish the same port.
        expect(port).toBeGreaterThan(0);
        expectReservationClosed(port);
      },
    );
  });

  it.each(["retained", "missing", "expanded"] as const)(
    "preserves authored nested paths: %s",
    async (outcome) => {
      const authored = {
        plugins: {
          enabled: true,
          allow: ["openai"],
          deny: ["retired"],
          slots: { memory: "none" },
          entries: { openai: { enabled: true, config: { apiKey: "fixture-secret" } } },
        },
        agents: { defaults: { model: "openai/gpt-5.6-luna" } },
        gateway: { mode: "local" },
      };
      let configPath = "";
      mocks.runModelsSet.mockImplementation(async ({ lane }) => {
        configPath = join(lane.stateDir, "openclaw.json");
        writeFileSync(configPath, JSON.stringify(authored), "utf8");
      });
      mocks.waitForGateway.mockImplementation(async () => {
        const config = JSON.parse(readFileSync(configPath, "utf8"));
        expect(config).toEqual({
          ...authored,
          plugins: {
            ...authored.plugins,
            entries: {
              ...authored.plugins.entries,
              wiki: { enabled: false, config: { store: { path: "~/.openclaw/wiki" } } },
            },
          },
        });
        if (outcome === "missing") {
          delete config.plugins.entries.wiki.config.store.path;
        } else if (outcome === "expanded") {
          config.plugins.entries.wiki.config.store.path = "C:\\Users\\fixture\\.openclaw\\wiki";
        }
        writeFileSync(configPath, JSON.stringify(config), "utf8");
      });

      const result = runFreshLane(upgradeParams());
      if (outcome === "retained") {
        await expect(result).resolves.toMatchObject({
          status: "pass",
          phaseTimings: expect.arrayContaining([
            expect.objectContaining({ name: "verify-nested-plugin-path", status: "pass" }),
          ]),
        });
      } else {
        await expect(result).rejects.toThrow(
          "Fresh Gateway startup changed the authored nested plugin path.",
        );
      }
      const completed = outcome === "retained" ? 1 : 0;
      expectCalls(1, mocks.startGateway, mocks.waitForGateway, mocks.stopGateway);
      expectCalls(completed, mocks.runDashboardSmoke, mocks.runAgentTurn);
    },
  );

  it.each([
    ["pass", 16],
    ["update refused", 15],
    ["skipped", 15],
  ] as const)(
    "requires 9.2 self-update, not direct install: %s/%i",
    async (outcome, publishedVersion) => {
      mocks.readInstalledVersion.mockReset().mockReturnValue("2026.9.2");
      installedVersion("2026.9.3");
      mocks.stopGateway.mockImplementation(async (gateway) => {
        if (gateway) {
          gateway.child.exitCode = 0;
        }
      });
      mocks.runCommand.mockImplementation(async (_command, args: string[]) => {
        const schemaIndex = args.indexOf("schema");
        if (schemaIndex !== -1) {
          const contentVersion = Number(args[schemaIndex + 1]);
          return jsonResult({
            publishedVersion: contentVersion === 15 ? 15 : publishedVersion,
            contentVersion,
          });
        }
        if (args.includes("refusal") || args.includes("receipt")) {
          throw new Error("obsolete external transition assertion");
        }
        return commandResult(args.includes("session-key") ? "agent:main:retained" : "{}");
      });
      mocks.runOpenClaw.mockImplementation(async ({ args }: { args: string[] }) => {
        if (args[0] === "update") {
          return jsonResult(
            { status: outcome === "pass" ? "ok" : outcome === "skipped" ? "skipped" : "error" },
            outcome === "update refused" ? 1 : 0,
          );
        }
        return commandResult(
          args.includes("system-presence")
            ? JSON.stringify([{ mode: "gateway", reason: "self", version: "2026.9.3" }])
            : "{}",
        );
      });
      const result = await runUpgradeLane({
        ...upgradeParams(),
        build: { ...candidate, candidateVersion: "2026.9.3" },
      });
      if (outcome === "pass") {
        expect(result).toMatchObject({
          status: "pass",
          method: "packaged-self-update",
          selfUpdatePassed: true,
          retainedSessionPassed: true,
          persistedCandidateTurnPassed: true,
          schemaAfterUpdate: { publishedVersion, contentVersion: 16 },
          schemaAfterServing: { publishedVersion, contentVersion: 16 },
        });
        expect(mocks.startGateway).toHaveBeenCalledTimes(2);
        expect(cliCalls("agent")).toHaveLength(2);
      } else {
        expect(result).toMatchObject({
          status: "fail",
          error: expect.stringContaining("packaged self-update"),
        });
      }
      expect(cliCalls("update")).toHaveLength(1);
      expect(cliCalls("doctor")).toEqual([]);
      expect(mocks.installTarballPackage).not.toHaveBeenCalled();
    },
  );

  it.each(["terminated", "failed", "unclosed"] as const)(
    "joins taskkill and updater close: %s",
    async (outcome) => {
      const realProcess = await vi.importActual<typeof Process>(
        "../../scripts/lib/cross-os-release-checks/process.ts",
      );
      const realRuntime = await vi.importActual<typeof Runtime>(
        "../../scripts/lib/cross-os-release-checks/runtime.ts",
      );
      windows();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      const child = new ChildProcess();
      Object.defineProperty(child, "pid", { value: 4242 });
      vi.spyOn(child, "kill").mockReturnValue(true);
      vi.mocked(spawn).mockReturnValue(child);
      vi.mocked(spawnSync).mockReturnValue({
        pid: 4243,
        output: [],
        stdout: "",
        stderr: "",
        status: outcome === "failed" ? 1 : 0,
        signal: null,
      });
      // A failed taskkill must never target an actual host PID while checking leader liveness.
      vi.spyOn(process, "kill").mockReturnValue(true);
      mocks.runCommand.mockImplementationOnce(realProcess.runCommand);
      mocks.runOpenClaw.mockImplementationOnce(realRuntime.runOpenClaw);
      const running = runUpgradeLane(upgradeParams());
      await vi.advanceTimersByTimeAsync(1_320_000);
      expect(spawnSync).toHaveBeenCalledWith(
        expect.stringMatching(/taskkill\.exe$/u),
        ["/PID", "4242", "/T", "/F"],
        expect.objectContaining({ timeout: 10_000 }),
      );
      expect(mocks.installPackageSpec).toHaveBeenCalledTimes(1);
      if (outcome === "unclosed") {
        await vi.advanceTimersByTimeAsync(15_000);
      } else {
        child.emit("close", 1);
      }
      const result = await running;
      if (outcome === "unclosed") {
        child.emit("close", 1);
      }
      expect(result.status).toBe(outcome === "terminated" ? "pass" : "fail");
      expect(mocks.installPackageSpec).toHaveBeenCalledTimes(outcome === "terminated" ? 2 : 1);
      const log = readLog();
      expect(log).toContain(`process-tree=${outcome === "failed" ? "unverified" : "terminated"}`);
      if (outcome !== "terminated") {
        expect(result).not.toHaveProperty("updateFallback");
        expect(result.error).toContain(
          outcome === "failed" ? "timeout cleanup failed" : "could not be terminated cleanly",
        );
      }
    },
  );

  it.each([
    ["EBUSY", false],
    ["EPERM", true],
    ["EACCES", true],
  ] as const)("bounds removal retries: %s persistent=%s", async (code, persistent) => {
    const realInstall = await vi.importActual<typeof Installer>(
      "../../scripts/lib/cross-os-release-checks/install.ts",
    );
    windows();
    mocks.runOpenClaw.mockRejectedValueOnce(updateTimeout());
    mocks.installPackageSpec
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(realInstall.installPackageSpec);
    const locked = () => {
      throw Object.assign(new Error(`${code}: package directory is locked`), { code });
    };
    if (persistent) {
      vi.mocked(rmSync).mockImplementation(locked);
    } else {
      vi.mocked(rmSync).mockImplementationOnce(locked);
    }

    const result = await runUpgradeLane(upgradeParams());

    expect(result).toMatchObject({
      status: persistent ? "fail" : "pass",
      updateFallback: { reason: "timeout", action: "direct-candidate-install" },
    });
    const attempts = persistent ? (code === "EPERM" ? 6 : 1) : 2;
    expect(rmSync).toHaveBeenCalledTimes(attempts);
    expect(vi.mocked(sleep).mock.calls.map(([ms]) => ms)).toEqual(
      persistent ? (code === "EPERM" ? [500, 1000, 2000, 4000, 8000] : []) : [500],
    );
    const log = readLog("upgrade-update-fallback-install");
    expect(log).toContain(`attempt=1 code=${code}`);
    expect(log).toContain(
      persistent ? `attempt=${attempts} code=${code} failed` : "attempt=2 success",
    );
    expectPhases(result, { "update-fallback-install": persistent ? "fail" : "pass" });
    const npmInstalls = mocks.runCommand.mock.calls.filter(([, args]) => args.includes("install"));
    expect(npmInstalls).toHaveLength(persistent ? 0 : 1);
    if (persistent) {
      expect(result.error).toContain(`${code}: package directory is locked`);
    }
  });

  it("records bounded evidence when the supported Windows timeout fallback succeeds", async () => {
    windows();
    let npmLogPath = "";
    let capturedBeforeFallback = false;
    mocks.runOpenClaw.mockImplementationOnce(async ({ env }) => {
      const npmLogsDir = join(env.LOCALAPPDATA, "npm-cache", "_logs");
      mkdirSync(npmLogsDir, { recursive: true });
      npmLogPath = join(npmLogsDir, "2026-08-29T00_00_00_000Z-debug-0.log");
      writeFileSync(npmLogPath, "0 error code ETIMEDOUT\n1 error token=updater-secret\n");
      throw updateTimeout();
    });
    mocks.installPackageSpec
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => {
        capturedBeforeFallback = readLog().includes('"errorCodes":["ETIMEDOUT"]');
        writeFileSync(npmLogPath, "0 verbose exit 0\n");
      });

    const result = await runUpgradeLane(upgradeParams());

    expect(result).toMatchObject({
      status: "pass",
      updateFallback: { reason: "timeout", action: "direct-candidate-install" },
      updateTimings: [],
    });
    expectPhases(result, { update: "pass", "update-fallback-install": "pass" });
    expect(capturedBeforeFallback).toBe(true);
    expect(readLog()).not.toContain("updater-secret");
  });

  it("retains sanitized updater timings when a later upgrade phase fails", async () => {
    windows();
    mocks.runOpenClaw.mockResolvedValue(
      jsonResult({
        durationMs: 622_000,
        root: String.raw`C:\npm-updater-private-fixture\openclaw`,
        steps: [
          {
            name: "global update",
            command: "npm install --global secret-package",
            durationMs: 461_000,
          },
        ],
      }),
    );
    mocks.runBundledPluginPostinstall
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("post-update plugin failure"));

    const result = await runUpgradeLane(upgradeParams());

    expect(result).toMatchObject({
      status: "fail",
      updateTimings: [
        { name: "total", durationMs: 622_000 },
        { name: "package-install", durationMs: 461_000 },
      ],
    });
    expect(result.error).toContain("post-update plugin failure");
    expect(result).not.toHaveProperty("updateFallback");
    expectPhases(result, { update: "pass", "run-bundled-plugin-postinstall": "fail" });
    expect(JSON.stringify(result)).not.toContain("npm-updater-private-fixture");
    expect(JSON.stringify(result)).not.toContain("npm install");
  });

  it.each(["success", "unsettled-exit", "other failure", "timeout", "switched install"] as const)(
    "retries the shipped liveness defect once: %s",
    async (retryOutcome) => {
      windows();
      const params = {
        ...upgradeParams(),
        // Recovery must use the installed baseline, even when selected by a moving tag.
        baselineSpec: "openclaw@latest",
        build: { ...candidate, candidateVersion: "2026.9.7" },
      };
      const unsettledExit = {
        exitCode: 13,
        stdout: "",
        stderr:
          "Warning: Detected unsettled top-level await at file:///C:/prefix/node_modules/openclaw/openclaw.mjs:757",
      };
      mocks.readInstalledVersion
        .mockReset()
        .mockReturnValueOnce("2026.9.6")
        .mockReturnValueOnce("2026.9.6")
        .mockReturnValueOnce(retryOutcome === "switched install" ? "2026.9.7" : "2026.9.6")
        .mockReturnValue("2026.9.7");
      installedVersion("2026.9.7");
      mocks.runOpenClaw.mockResolvedValueOnce(unsettledExit).mockImplementationOnce(async () => {
        if (retryOutcome === "timeout") {
          throw updateTimeout();
        }
        if (retryOutcome === "success") {
          return commandResult('{"status":"ok","durationMs":1234}');
        }
        return retryOutcome === "other failure"
          ? commandResult("", 13, "Different failure")
          : unsettledExit;
      });

      const result = await runUpgradeLane(params);

      const updates = cliCalls("update").filter((call) => call.args[1] === "--tag");
      expect(updates).toHaveLength(2);
      expect(updates[1]).toEqual(updates[0]);
      const recovered = retryOutcome === "success" || retryOutcome === "unsettled-exit";
      expect(result.status).toBe(recovered ? "pass" : "fail");
      expect(mocks.installPackageSpec).toHaveBeenCalledTimes(
        retryOutcome === "unsettled-exit" ? 2 : 1,
      );
      expect(mocks.runOpenClaw.mock.calls.some(([call]) => call.args[1] === "status")).toBe(
        retryOutcome === "success",
      );
      expect(mocks.runAgentTurn).toHaveBeenCalledTimes(recovered ? 1 : 0);
      if (recovered) {
        const action = retryOutcome === "success" ? "retry-update" : "direct-candidate-install";
        expect(result.updateFallback).toEqual({ reason: "unsettled-exit", action });
        expect(result.updateTimings).toEqual(
          retryOutcome === "success" ? [{ name: "total", durationMs: 1234 }] : [],
        );
      } else {
        expect(result).not.toHaveProperty("updateFallback");
        expect(result.error).toContain(
          retryOutcome === "timeout" ? "Command timed out" : "Packaged upgrade failed",
        );
      }
      expect(readLog()).toContain(
        "Windows baseline 2026.9.6 updater exited 13 (known shipped liveness defect fixed in 2026.9.7)",
      );
    },
  );
});

async function probeBind(port: number): Promise<string> {
  const server = createServer();
  return await new Promise((resolve) => {
    server.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve("available")));
  });
}
