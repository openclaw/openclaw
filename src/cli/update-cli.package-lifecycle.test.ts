import fs from "node:fs/promises";
import path from "node:path";
import { root as fsSafeRoot, type Root } from "@openclaw/fs-safe/root";
import { describe, expect, it, vi } from "vitest";
import type { PackageUpdateTransaction } from "../infra/package-update-swap-contract.js";
import type { UpdateDoctorConfigWriteRefusal } from "../infra/update-doctor-config.js";
import {
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  writeUpdatePostInstallDoctorResult,
} from "../infra/update-doctor-result.js";
import { cleanupStaleManagedServiceUpdateHandoffs } from "../infra/update-managed-service-handoff-cleanup.js";
import { renderUpdateRunReport } from "../infra/update-run-report.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { createCommandResult as commandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { VERSION } from "../version.js";
import {
  doctorCommandCall,
  doctorCommandCallIndex,
  expectNoSideEffects,
  expectPackageInstallSpec,
  getErrorOutput,
  getLogOutput,
  lastWriteJsonCall,
  packageInstallCommandCall,
  requireValue,
  spawnCall,
  commandCalls,
  freshRestartCalls,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import {
  createPreUpdateConfigSnapshotMock,
  readPackageName,
  readPackageVersion,
  resolveGlobalManager,
  resumeScheduledTaskAutoStartAfterUpdate,
  serviceLoaded,
  serviceReadRuntime,
  serviceRestart,
  serviceStart,
  suspendScheduledTaskAutoStartForUpdate,
  triageCommand,
  updateNpmInstalledPlugins,
  serviceStop,
} from "./update-cli-mocks.test-support.js";
import {
  defaultRuntime,
  ExitError,
  fetchNpmPackageTargetStatus,
  fetchNpmTagVersion,
  getUpdateRun,
  listUpdateRuns,
  replaceConfigFile,
  updateCommand,
  updateGitCheckout,
  resolveGatewayInstallEntrypoint,
  runCommandWithTimeout,
} from "./update-cli-modules.test-support.js";
import {
  writeNpmPackageInstall,
  writeOpenClawPackageFixture,
} from "./update-cli/update-cli-package.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const nodeExecutable = resolveTestNodeExecPath();
  const {
    createCaseDir,
    mockCurrentProcessFreshDoctor,
    mockFileBackedPathExists,
    mockNpmGlobalCommands,
    mockNpmGlobalRoot,
    mockPackageInstallAtCaseDir,
    mockPackageInstallStatus,
    mockRunningManagedGateway,
    primeNpmChannelTag,
    primeServiceCommand,
    setStdoutTty,
    setTty,
    setupInstalledPackageAtNodeModules,
    setupInstalledPackageRoot,
    tempDirs,
    useFileBackedConfig,
  } = createUpdateCliFixture();

  it.each([
    {
      name: "explicit git package spec",
      options: { yes: true, tag: "github:openclaw/openclaw#main" },
      packageSpec: undefined,
      expectedSpec: "github:openclaw/openclaw#main",
    },
    {
      name: "OPENCLAW_UPDATE_PACKAGE_SPEC override",
      options: { yes: true, tag: "latest" },
      packageSpec: "http://10.211.55.2:8138/openclaw-next.tgz",
      expectedSpec: "http://10.211.55.2:8138/openclaw-next.tgz",
    },
  ] as const)(
    "resolves package install specs from tags and env overrides: $name",
    async ({ options, packageSpec, expectedSpec }) => {
      vi.clearAllMocks();
      readPackageName.mockResolvedValue("openclaw");
      readPackageVersion.mockResolvedValue("1.0.0");
      resolveGlobalManager.mockResolvedValue("npm");
      await mockPackageInstallAtCaseDir();
      if (packageSpec) {
        await withEnvAsync({ OPENCLAW_UPDATE_PACKAGE_SPEC: packageSpec }, async () => {
          await updateCommand(options);
        });
      } else {
        await updateCommand(options);
      }
      expectPackageInstallSpec(expectedSpec);
      if (!packageSpec) {
        expect(fetchNpmTagVersion).not.toHaveBeenCalled();
        expect(fetchNpmPackageTargetStatus).not.toHaveBeenCalled();
      }
    },
  );

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
    expectNoSideEffects(resolveGlobalManager, replaceConfigFile, updateGitCheckout);
    expect(cleanupStaleManagedServiceUpdateHandoffs).not.toHaveBeenCalled();
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
    let transaction: PackageUpdateTransaction | undefined;
    const result = await withEnvAsync({ OPENCLAW_CONFIG_PATH: callerConfig }, async () => {
      const packageResult = await runPackageInstallUpdate({
        root: pkgRoot,
        installKind: "package",
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

  it("fails package activation when Doctor reports requester-revoked", async () => {
    const target = "2026.9.4";
    const { nodeModules, pkgRoot, entryPath } = await setupInstalledPackageRoot(
      tempDirs.make("openclaw-update-doctor-failure-"),
      "2026.9.3",
    );
    primeNpmChannelTag("latest", target);
    mockFileBackedPathExists();
    const refusal: UpdateDoctorConfigWriteRefusal = {
      reason: "requester-revoked",
      message: "The original write owner refused publication.",
      keys: ["meta", "plugins", "wizard"],
    };
    mockNpmGlobalCommands(nodeModules, async (argv, options) => {
      if (argv[1] === entryPath && argv[2] === "doctor") {
        const env = typeof options === "number" ? undefined : options.env;
        const resultPath = requireValue(
          env?.[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV],
          "Doctor receipt path",
        );
        await writeUpdatePostInstallDoctorResult({
          resultPath,
          result: { status: "error", configWriteRefusal: refusal },
        });
        return commandResult({ code: 1 });
      }
      if (argv[0] === "npm" && argv[1] === "i") {
        await writeNpmPackageInstall(argv, pkgRoot, target);
      }
      return undefined;
    });
    await expect(updateCommand({ yes: true, restart: false, json: true })).rejects.toEqual(
      new ExitError(1),
    );
    expect(lastWriteJsonCall()).toMatchObject({
      status: "error",
      reason: "requester-revoked",
      steps: expect.arrayContaining([expect.objectContaining({ configWriteRefusal: refusal })]),
    });
  });

  it("continues package post-core work for explicit post-update doctor advisories", async () => {
    const warning =
      "Doctor include-owned keys agents: promotion unavailable for include-owned configuration.";
    const tempDir = tempDirs.make("openclaw-update-package-doctor-warning-");
    const { nodeModules, pkgRoot, entryPath } = await setupInstalledPackageRoot(
      tempDir,
      "2026.4.20",
    );
    readPackageVersion.mockImplementation(async (root: string) => {
      const manifest: { version: string } = JSON.parse(
        await fs.readFile(path.join(root, "package.json"), "utf8"),
      );
      return manifest.version;
    });
    primeNpmChannelTag("latest", VERSION);
    mockFileBackedPathExists();
    mockNpmGlobalCommands(nodeModules, async (argv, options) => {
      if (argv[1] === entryPath && argv[2] === "doctor") {
        const env = options && typeof options !== "number" ? options.env : undefined;
        const resultPath = env?.[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV];
        if (!resultPath) {
          throw new Error("missing doctor result path");
        }
        await writeUpdatePostInstallDoctorResult({
          resultPath,
          result: { status: "ok", warnings: [warning] },
        });
        return commandResult({
          stderr: warning,
          code: 0,
        });
      }
      if (argv[0] === "npm" && argv[1] === "i") {
        await writeNpmPackageInstall(argv, pkgRoot, VERSION);
      }
      return undefined;
    });

    await withEnvAsync({ OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "1" }, async () => {
      await updateCommand({ yes: true, restart: false, json: true });
    });

    const doctorCall = doctorCommandCall();
    expect(doctorCall?.[0].slice(1)).toEqual([entryPath, "doctor", "--non-interactive", "--fix"]);
    expect(
      (doctorCall?.[1].env as NodeJS.ProcessEnv | undefined)
        ?.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION,
    ).toBe("0");
    expect(
      (doctorCall?.[1].env as NodeJS.ProcessEnv | undefined)
        ?.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR,
    ).toBe("0");
    expect(
      (doctorCall?.[1].env as NodeJS.ProcessEnv | undefined)
        ?.OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART,
    ).toBe("1");
    const postCoreCall = spawnCall();
    expect(postCoreCall?.[0]).toBe(process.execPath);
    expect(postCoreCall?.[1]).toEqual([
      entryPath,
      "update",
      "--json",
      "--no-restart",
      "--yes",
      "--timeout",
      "1800",
    ]);
    expect(postCoreCall?.[2]?.env?.OPENCLAW_UPDATE_POST_CORE).toBe("1");
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    const jsonOutput = lastWriteJsonCall() as UpdateRunResult | undefined;
    const doctorStep = jsonOutput?.steps.find((step) => step.name === "openclaw doctor");
    expect(jsonOutput?.status).toBe("ok");
    expect(doctorStep?.exitCode).toBe(0);
    // Keep the established advisory shape; complete ledger warnings travel on the step.
    expect(doctorStep?.advisory).toEqual({
      kind: "package-post-install-doctor",
      message: expect.stringContaining("recoverable update-time repair warning"),
    });
    expect(doctorStep).toMatchObject({
      warnings: [warning],
    });
    expect(doctorStep?.advisory?.message).not.toContain("gateway restart");
    expect(doctorStep?.stderrTail).toContain(warning);
    const record = requireValue(
      getUpdateRun(requireValue(jsonOutput?.runId, "updated run id")),
      "update run",
    );
    expect(record.status).toBe("succeeded");
    expect(record.steps).toContainEqual(
      expect.objectContaining({
        step: expect.stringMatching(/^warning:/),
        detail: expect.stringContaining(warning),
      }),
    );
    expect(renderUpdateRunReport(record).lines.join("\n")).toContain(warning);
  });

  it("retains the Windows autostart failure outcome through outer cleanup", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
    resumeScheduledTaskAutoStartAfterUpdate.mockRejectedValue(new Error("task restore denied"));
    const root = await mockPackageInstallAtCaseDir("openclaw-update-autostart-restore-failure");
    mockCurrentProcessFreshDoctor({ packageRoot: root });
    mockRunningManagedGateway([
      nodeExecutable,
      path.join(root, "dist", "index.js"),
      "gateway",
      "run",
    ]);
    mockFileBackedPathExists();
    setTty(true);
    setStdoutTty(true);
    try {
      await expect(
        withEnvAsync({ OPENCLAW_UPDATE_RUN_HANDOFF: undefined }, () =>
          updateCommand({ json: false }),
        ),
      ).rejects.toEqual(new ExitError(1));
      expect(resumeScheduledTaskAutoStartAfterUpdate).toHaveBeenCalledOnce();
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(triageCommand).toHaveBeenCalledTimes(1);
      const reportedFailure = triageCommand.mock.calls[0]?.[1]?.recovery?.updateFailure;
      expect(reportedFailure).toMatchObject({
        result: {
          status: "error",
          reason: "windows-task-autostart-restore-failed",
          recovery: { serviceRestartSafe: false },
        },
      });
      expect(listUpdateRuns({ limit: 1 })).toMatchObject([
        { phase: "finished", status: "failed", reason: "windows-task-autostart-restore-failed" },
      ]);
    } finally {
      platformSpy.mockRestore();
    }
  });
  it("gates old Gateway recovery at the swap boundary after staged npm shim swap failure", async () => {
    await useFileBackedConfig();
    const tempDir = tempDirs.make("openclaw-update-staged-fail-");
    const prefix = path.join(tempDir, "prefix");
    const nodeModules = path.join(prefix, "lib", "node_modules");
    const { pkgRoot, entryPath } = await setupInstalledPackageAtNodeModules(
      nodeModules,
      "2026.7.1",
    );
    mockFileBackedPathExists();
    mockRunningManagedGateway([process.execPath, entryPath, "gateway", "run"]);
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(entryPath);
    const targetShim = path.join(prefix, "bin", "openclaw");
    const oldLauncher = path.join(pkgRoot, "openclaw.mjs");
    await fs.writeFile(oldLauncher, "old shim\n");
    await fs.mkdir(path.dirname(targetShim), { recursive: true });
    await fs.symlink(path.relative(path.dirname(targetShim), oldLauncher), targetShim);
    let stagedShim: string | undefined;
    const prototype = Object.getPrototypeOf(await fsSafeRoot(tempDir)) as Root;
    // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted Root receiver to preserve its path and mutation authority.
    const copy = prototype.copyIn;
    let injections = 0;
    const copySpy = vi.spyOn(prototype, "copyIn").mockImplementation(async function (
      this: Root,
      destination,
      source,
      options,
    ) {
      if (source === stagedShim) {
        injections += 1;
        expect(
          JSON.parse(await fs.readFile(path.join(pkgRoot, "package.json"), "utf8")).version,
        ).toBe("2026.8.1");
        throw new Error("staged shim copy failed");
      }
      await copy.call(this, destination, source, options);
    });
    readPackageVersion.mockResolvedValue("2026.7.1");
    primeNpmChannelTag("latest", "2026.8.1");
    mockNpmGlobalCommands(nodeModules, async (argv) => {
      if (argv[0] === "npm" && argv[1] === "i" && argv.includes("--prefix")) {
        expect(serviceStop).not.toHaveBeenCalled();
        expect(freshRestartCalls()).toEqual([]);
        const stagePrefix = argv[argv.indexOf("--prefix") + 1];
        if (typeof stagePrefix !== "string") {
          throw new Error("missing stage prefix");
        }
        const stageRoot = path.join(stagePrefix, "lib", "node_modules", "openclaw");
        await writeOpenClawPackageFixture(stageRoot, "2026.8.1", {
          entrySource: "export {};\n",
          inventory: true,
        });
        stagedShim = path.join(stagePrefix, "bin", "openclaw");
        await fs.mkdir(path.dirname(stagedShim), { recursive: true });
        await fs.writeFile(stagedShim, "new shim\n");
      }
      return undefined;
    });

    try {
      await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));
    } finally {
      copySpy.mockRestore();
    }

    expect(injections).toBe(1);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(doctorCommandCall()).toBeUndefined();
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(
      commandCalls()
        .filter(([argv]) => argv[0] === process.execPath && argv[1]?.includes("/scripts/"))
        .map(([argv]) => path.basename(requireValue(argv[1], "lifecycle script"))),
    ).toEqual([]);
    await expect(fs.readFile(path.join(pkgRoot, "package.json"), "utf-8")).resolves.toContain(
      '"version":"2026.7.1"',
    );
    const logs = getLogOutput();
    expect(logs).toContain("package-swap");
    expect(logs).toContain("staged shim copy failed");
    await expect(fs.readFile(targetShim, "utf8")).resolves.toBe("old shim\n");
    expect(freshRestartCalls()).toEqual([]);
    expect(serviceStop).toHaveBeenCalledTimes(1);
    expect(logs).not.toContain(
      "Recovered managed gateway service and verified readiness after failed update.",
    );
    expectNoSideEffects(serviceStart, serviceRestart);
  });

  it("runs old package doctors without fix mode when the service belongs to another install", async () => {
    const tempDir = tempDirs.make("openclaw-update-package-");
    const { nodeModules, entryPath } = await setupInstalledPackageRoot(tempDir, "2026.4.20");
    const foreignRoot = createCaseDir("old-doctor-foreign");
    const foreignEntry = await writeOpenClawPackageFixture(foreignRoot, "1.0.0", {
      entrySource: "export {};\n",
      git: true,
    });
    await fs.mkdir(path.join(foreignRoot, "src"));
    await fs.mkdir(path.join(foreignRoot, "extensions"));
    primeServiceCommand([nodeExecutable, foreignEntry, "gateway", "run"]);
    serviceLoaded.mockResolvedValue(true);
    serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
    readPackageVersion.mockImplementation(
      async (packageRoot: string) =>
        (
          JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")) as {
            version: string;
          }
        ).version,
    );
    primeNpmChannelTag("latest", "2026.4.21");
    mockFileBackedPathExists();
    mockNpmGlobalRoot(nodeModules);

    await withEnvAsync({ OPENCLAW_SERVICE_REPAIR_POLICY: "external" }, async () => {
      await updateCommand({ yes: true });
    });

    const doctorCall = doctorCommandCall();
    expect(doctorCall?.[0][0]).toBe(nodeExecutable);
    expect(doctorCall?.[0].slice(1)).toEqual([entryPath, "doctor", "--non-interactive"]);
    expect(
      (doctorCall?.[1].env as NodeJS.ProcessEnv | undefined)?.OPENCLAW_UPDATE_IN_PROGRESS,
    ).toBe("1");
    expect(
      (doctorCall?.[1].env as NodeJS.ProcessEnv | undefined)
        ?.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION,
    ).toBe("0");
    expect(
      (doctorCall?.[1].env as NodeJS.ProcessEnv | undefined)
        ?.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR,
    ).toBe("0");
    expect(
      (doctorCall?.[1].env as NodeJS.ProcessEnv | undefined)
        ?.OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART,
    ).toBe("1");
    expect(
      (doctorCall?.[1].env as NodeJS.ProcessEnv | undefined)?.OPENCLAW_SERVICE_REPAIR_POLICY,
    ).toBeUndefined();
    const doctorIndex = doctorCommandCallIndex();
    const snapshotOrder = createPreUpdateConfigSnapshotMock.mock.invocationCallOrder[0];
    const doctorOrder = vi.mocked(runCommandWithTimeout).mock.invocationCallOrder[doctorIndex];
    expect(requireValue(snapshotOrder, "pre-update snapshot call order")).toBeLessThan(
      requireValue(doctorOrder, "post-update doctor call order"),
    );
  });
});
