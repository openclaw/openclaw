import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PackageUpdateTransaction } from "../infra/package-update-swap-contract.js";
import { resolveGlobalInstallTarget } from "../infra/update-global.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createCommandResult as commandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import * as release from "../update/cli.js";
import {
  expectNoSideEffects,
  getErrorOutput,
  lastWriteJsonCall,
  packageInstallCommandCall,
  requireValue,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import {
  createPreUpdateConfigSnapshotMock,
  readPackageVersion,
  resolveGlobalManager,
  serviceRestart,
  serviceStart,
} from "./update-cli-mocks.test-support.js";
import {
  defaultRuntime,
  ExitError,
  listUpdateRuns,
  replaceConfigFile,
  updateCommand,
  updateGitRelease,
  runCommandWithTimeout,
} from "./update-cli-modules.test-support.js";
import { writeOpenClawPackageFixture } from "./update-cli/update-cli-package.test-support.js";
import * as channelConfig from "./update-cli/update-command-config.js";
import * as legacyTarget from "./update-cli/update-command-target.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const {
    createCaseDir,
    mockFileBackedPathExists,
    mockNpmGlobalCommands,
    mockPackageInstallAtCaseDir,
    mockPackageInstallStatus,
    setupInstalledPackageAtNodeModules,
    tempDirs,
  } = createUpdateCliFixture();

  it.each([
    {
      name: "explicit git package spec",
      tag: "github:openclaw/openclaw#main",
      packageSpec: undefined,
      expectedSpec: "github:openclaw/openclaw#main",
    },
    {
      name: "OPENCLAW_UPDATE_PACKAGE_SPEC override",
      tag: "latest",
      packageSpec: "http://10.211.55.2:8138/openclaw-next.tgz",
      expectedSpec: "http://10.211.55.2:8138/openclaw-next.tgz",
    },
  ] as const)(
    "forwards $name to the release update owner",
    async ({ tag, packageSpec, expectedSpec }) => {
      const root = await mockPackageInstallAtCaseDir();
      const runRelease = vi.spyOn(release, "runReleaseUpdateCli").mockResolvedValue(undefined);

      await withEnvAsync({ OPENCLAW_UPDATE_PACKAGE_SPEC: packageSpec }, () =>
        updateCommand({ yes: true, tag }),
      );

      expect(runRelease).toHaveBeenCalledWith(
        expect.objectContaining({ runningRoot: root, tag: expectedSpec }),
      );
      expect(packageInstallCommandCall()).toBeUndefined();
    },
  );

  it.each([true, false])(
    "keeps %s explicit dev selection at the existing Git conversion owner",
    async (explicit) => {
      await mockPackageInstallAtCaseDir();
      const config = await channelConfig.readUpdateChannelConfig(false);
      vi.spyOn(channelConfig, "readUpdateChannelConfig").mockResolvedValue({
        ...config,
        storedChannel: explicit ? null : "dev",
      });
      const resolveLegacyTarget = vi
        .spyOn(legacyTarget, "resolveUpdateCommandTarget")
        .mockResolvedValue(undefined);
      const runRelease = vi.spyOn(release, "runReleaseUpdateCli").mockResolvedValue(undefined);

      await updateCommand({ yes: true, channel: explicit ? "dev" : undefined });

      expect(resolveLegacyTarget).toHaveBeenCalledOnce();
      expect(runRelease).not.toHaveBeenCalled();
    },
  );

  it("keeps an explicit one-off package tag on the release path despite saved dev", async () => {
    await mockPackageInstallAtCaseDir();
    const config = await channelConfig.readUpdateChannelConfig(false);
    vi.spyOn(channelConfig, "readUpdateChannelConfig").mockResolvedValue({
      ...config,
      storedChannel: "dev",
    });
    const runRelease = vi.spyOn(release, "runReleaseUpdateCli").mockResolvedValue(undefined);

    await updateCommand({ yes: true, tag: "latest" });

    expect(runRelease).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "latest", storedChannel: "dev" }),
    );
  });

  it.each([
    {
      option: { reapplyLocalOverrides: true },
      guidance: "update without this flag, then reapply the overrides by hand",
    },
    {
      option: { fullIntegrityCheck: true },
      guidance: "openclaw doctor --fix --full-integrity-check",
    },
  ])("refuses unsupported $option before release preparation", async ({ option, guidance }) => {
    await mockPackageInstallAtCaseDir();
    const runRelease = vi.spyOn(release, "runReleaseUpdateCli").mockResolvedValue(undefined);
    const runsBefore = listUpdateRuns();

    await expect(updateCommand({ yes: true, json: true, ...option })).rejects.toThrow(guidance);

    expect(packageInstallCommandCall()).toBeUndefined();
    expect(runRelease).not.toHaveBeenCalled();
    expect(listUpdateRuns()).toEqual(runsBefore);
  });

  it("refuses --tag main before dry-run package resolution", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-update-main-refusal"));

    await expect(
      updateCommand({ dryRun: true, json: true, tag: "main", yes: true }),
    ).rejects.toEqual(new ExitError(1));

    const result = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(result).toMatchObject({
      status: "error",
      reason: "unsupported-package-target",
      steps: [
        expect.objectContaining({
          name: "unsupported-package-target",
          exitCode: 1,
          failureFacts: [
            expect.objectContaining({
              check: "unsupported-package-target",
              code: "unsupported-package-target",
            }),
          ],
        }),
      ],
    });
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expectNoSideEffects(resolveGlobalManager, replaceConfigFile, updateGitRelease);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(getErrorOutput()).toContain("openclaw update --channel dev");
  });

  it("retains the exact package and launchers for explicit rollback after managed Doctor fails", async () => {
    const tempDir = tempDirs.make("openclaw-update-managed-backup-");
    const { nodeModules, pkgRoot, entryPath } = await setupInstalledPackageAtNodeModules(
      path.join(tempDir, "lib", "node_modules"),
    );
    const candidateVersion = "2026.5.14";
    const packageEntry = path.join(pkgRoot, "dist", "index.js");
    const launcherDir = path.join(tempDir, "bin");
    const launcherNames = ["openclaw", "openclaw.cmd", "openclaw.ps1"];
    await fs.writeFile(packageEntry, "old package entry\n", "utf8");
    await fs.mkdir(launcherDir, { recursive: true });
    await Promise.all(
      launcherNames.map((name) =>
        fs.writeFile(path.join(launcherDir, name), `old ${name}\n`, "utf8"),
      ),
    );
    const originalPackageIdentity = await fs.stat(pkgRoot);
    const callerConfig = path.join(tempDir, "caller.json");
    const managedConfig = path.join(tempDir, "managed.json");
    const callerBytes = '{"gateway":{"mode":"local"},"env":{"vars":{"CANARY":"caller"}}}\n';
    const managedBytes = '{"gateway":{"mode":"local"},"env":{"vars":{"CANARY":"managed"}}}\n';
    const existingCallerBackup = "synthetic-previous-caller-backup\n";
    await fs.writeFile(callerConfig, callerBytes);
    await fs.writeFile(`${callerConfig}.pre-update`, existingCallerBackup);
    await fs.writeFile(managedConfig, managedBytes);
    const { createPreUpdateConfigSnapshot } = await vi.importActual<
      typeof import("../config/backup-rotation.js")
    >("../config/backup-rotation.js");
    createPreUpdateConfigSnapshotMock.mockImplementation(createPreUpdateConfigSnapshot);
    mockFileBackedPathExists();
    readPackageVersion.mockImplementation(async (packageRoot: string) => {
      const manifest = JSON.parse(
        await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
      ) as { version?: string };
      return manifest.version ?? null;
    });
    let backupAtDoctorEntry: string | undefined;
    let doctorStarted = false;
    mockNpmGlobalCommands(nodeModules, async (argv, options) => {
      if (argv[0] === "npm" && argv[1] === "i" && argv.includes("--prefix")) {
        const stagePrefix = requireValue(argv[argv.indexOf("--prefix") + 1], "staged prefix");
        const stageRoot = path.join(stagePrefix, "lib", "node_modules", "openclaw");
        await writeOpenClawPackageFixture(stageRoot, candidateVersion, {
          entrySource: "candidate package entry\n",
          inventory: true,
        });
        const stagedLauncherDir = path.join(stagePrefix, "bin");
        await fs.mkdir(stagedLauncherDir, { recursive: true });
        await Promise.all(
          launcherNames.map((name) =>
            fs.writeFile(path.join(stagedLauncherDir, name), `candidate ${name}\n`, "utf8"),
          ),
        );
      }
      if (argv[1] !== entryPath || argv[2] !== "doctor") {
        return undefined;
      }
      doctorStarted = true;
      await expect(fs.readFile(path.join(pkgRoot, "package.json"), "utf8")).resolves.toContain(
        `"version":"${candidateVersion}"`,
      );
      await expect(fs.readFile(packageEntry, "utf8")).resolves.toBe("candidate package entry\n");
      for (const name of launcherNames) {
        await expect(fs.readFile(path.join(launcherDir, name), "utf8")).resolves.toBe(
          `candidate ${name}\n`,
        );
      }
      const doctorEnv = typeof options === "number" ? undefined : options.env;
      expect(doctorEnv?.OPENCLAW_CONFIG_PATH).toBe(managedConfig);
      backupAtDoctorEntry = await fs
        .readFile(`${managedConfig}.pre-update`, "utf8")
        .catch(() => undefined);
      await fs.writeFile(managedConfig, '{"gateway":{"mode":"local"}}\n');
      return commandResult({ code: 1, stderr: "Doctor failed after rewriting the managed config" });
    });
    const { runPackageInstallUpdate } = await import("./update-cli/update-command-package.js");
    const installTarget = await resolveGlobalInstallTarget({
      manager: "npm",
      runCommand: runCommandWithTimeout,
      timeoutMs: 30_000,
      pkgRoot,
    });
    let transaction: PackageUpdateTransaction | undefined;
    const result = await withEnvAsync({ OPENCLAW_CONFIG_PATH: callerConfig }, async () => {
      const packageResult = await runPackageInstallUpdate({
        root: pkgRoot,
        installKind: "package",
        installTarget,
        tag: candidateVersion,
        timeoutMs: 30_000,
        startedAt: Date.now(),
        progress: {},
        managedServiceEnv: { OPENCLAW_CONFIG_PATH: managedConfig },
        validateCandidate: async () => [],
        beforeActivate: async () => {},
        onTransaction: (retained) => {
          transaction = retained;
        },
      });
      expect(process.env.OPENCLAW_CONFIG_PATH).toBe(callerConfig);
      return packageResult;
    });

    expect(doctorStarted).toBe(true);
    expect(backupAtDoctorEntry).toBe(managedBytes);
    await expect(fs.readFile(`${managedConfig}.pre-update`, "utf8")).resolves.toBe(managedBytes);
    await expect(fs.readFile(callerConfig, "utf8")).resolves.toBe(callerBytes);
    await expect(fs.readFile(`${callerConfig}.pre-update`, "utf8")).resolves.toBe(
      existingCallerBackup,
    );
    expect(result.status).toBe("error");
    expect(result.after?.version).toBe(candidateVersion);
    expect(result.recovery).toMatchObject({
      serviceRestartSafe: false,
      reason: "runtime-verification-failed",
    });
    const retained = requireValue(transaction, "retained package transaction");
    expect(
      JSON.parse(await fs.readFile(path.join(retained.backupRoot, "package.json"), "utf8")),
    ).toMatchObject({ version: "2026.4.21" });
    await expect(fs.readFile(packageEntry, "utf8")).resolves.toBe("candidate package entry\n");
    const assertCurrent = () => {};
    const rollback = await retained.rollback(assertCurrent);
    expect(rollback.exitCode).toBe(0);
    await retained.complete({ activationVerified: false }, assertCurrent);
    const doctorStep = result.steps.find((step) => step.name === "openclaw doctor");
    expect(doctorStep?.exitCode).toBe(1);
    expect(doctorStep?.advisory).toBeUndefined();
    await expect(fs.readFile(path.join(pkgRoot, "package.json"), "utf8")).resolves.toContain(
      '"version":"2026.4.21"',
    );
    await expect(fs.readFile(packageEntry, "utf8")).resolves.toBe("old package entry\n");
    const restoredPackageIdentity = await fs.stat(pkgRoot);
    expect({ dev: restoredPackageIdentity.dev, ino: restoredPackageIdentity.ino }).toEqual({
      dev: originalPackageIdentity.dev,
      ino: originalPackageIdentity.ino,
    });
    for (const name of launcherNames) {
      await expect(fs.readFile(path.join(launcherDir, name), "utf8")).resolves.toBe(
        `old ${name}\n`,
      );
    }
    expect(
      (await fs.readdir(nodeModules)).filter((entry) =>
        [
          ".openclaw.update-stage-",
          ".openclaw.package-backup-",
          ".openclaw-package-backup-",
          ".openclaw.shim-backup-",
          ".openclaw-shim-backup-",
        ].some((prefix) => entry.startsWith(prefix)),
      ),
    ).toEqual([]);
    expectNoSideEffects(serviceStart, serviceRestart);
  });
});
