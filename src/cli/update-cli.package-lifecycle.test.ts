import fs from "node:fs/promises";
import path from "node:path";
import { root as fsSafeRoot, type Root } from "@openclaw/fs-safe/root";
import { expect, it, vi } from "vitest";
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
import * as checks from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as cli from "./update-cli-modules.test-support.js";
import {
  writeNpmPackageInstall,
  writeOpenClawPackageFixture,
} from "./update-cli/update-cli-package.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

const nodeExecutable = resolveTestNodeExecPath();
const f = createUpdateCliFixture();

const readText = (file: string) => fs.readFile(file, "utf8");
const expectText = (file: string) => expect(readText(file)).resolves;
const manifestPath = (root: string) => path.join(root, "package.json");
const expectUpdateFailure = (options: Parameters<typeof cli.updateCommand>[0]) =>
  expect(cli.updateCommand(options)).rejects.toEqual(new cli.ExitError(1));
async function readVersion(root: string) {
  const manifest: { version: string } = JSON.parse(await readText(manifestPath(root)));
  return manifest.version;
}
const launcherNames = ["openclaw", "openclaw.cmd", "openclaw.ps1"];
async function writeLaunchers(dir: string, label: string) {
  await fs.mkdir(dir, { recursive: true });
  await Promise.all(
    launcherNames.map((name) => fs.writeFile(path.join(dir, name), `${label} ${name}\n`, "utf8")),
  );
}
async function expectLaunchers(dir: string, label: string) {
  for (const name of launcherNames) {
    await expectText(path.join(dir, name)).toBe(`${label} ${name}\n`);
  }
}
async function writeStagedPackage(argv: readonly string[], version: string, entrySource: string) {
  const prefix = checks.requireValue(argv[argv.indexOf("--prefix") + 1], "staged prefix");
  await writeOpenClawPackageFixture(path.join(prefix, "lib", "node_modules", "openclaw"), version, {
    entrySource,
    inventory: true,
  });
  return prefix;
}
function expectDoctorEnv(extra: NodeJS.ProcessEnv = {}) {
  expect(checks.doctorCommandCall()?.[1].env).toMatchObject({
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
    OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART: "1",
    ...extra,
  });
}
type DoctorResult = Parameters<typeof writeUpdatePostInstallDoctorResult>[0]["result"];
async function packageDoctor(
  version: string,
  target: string,
  receipt: DoctorResult,
  output = commandResult(),
) {
  const install = await f.setupInstalledPackageRoot(
    f.tempDirs.make("openclaw-package-doctor-"),
    version,
  );
  f.primeNpmChannelTag("latest", target);
  f.mockFileBackedPathExists();
  f.mockNpmGlobalCommands(install.nodeModules, async (argv, options) => {
    if (argv[1] === install.entryPath && argv[2] === "doctor") {
      const env = typeof options === "number" ? undefined : options.env;
      const resultPath = checks.requireValue(
        env?.[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV],
        "Doctor receipt path",
      );
      await writeUpdatePostInstallDoctorResult({ resultPath, result: receipt });
      return output;
    }
    if (argv[0] === "npm" && argv[1] === "i") {
      await writeNpmPackageInstall(argv, install.pkgRoot, target);
    }
    return undefined;
  });
  return install;
}

it.each([
  ["github:openclaw/openclaw#main", undefined],
  ["latest", "http://10.211.55.2:8138/openclaw-next.tgz"],
] as const)(
  "resolves package install specs from tag %s and env override %s",
  async (tag, packageSpec) => {
    vi.clearAllMocks();
    mocks.readPackageName.mockResolvedValue("openclaw");
    mocks.readPackageVersion.mockResolvedValue("1.0.0");
    mocks.resolveGlobalManager.mockResolvedValue("npm");
    await f.mockPackageInstallAtCaseDir();
    const update = () => cli.updateCommand({ yes: true, tag });
    await (packageSpec
      ? withEnvAsync({ OPENCLAW_UPDATE_PACKAGE_SPEC: packageSpec }, update)
      : update());
    checks.expectPackageInstallSpec(packageSpec ?? tag);
    if (!packageSpec) {
      checks.expectNoSideEffects(cli.fetchNpmTagVersion, cli.fetchNpmPackageTargetStatus);
    }
  },
);

it("refuses --tag main before dry-run package resolution", async () => {
  f.mockPackageInstallStatus(f.createCaseDir("openclaw-update-main-refusal"));

  await expectUpdateFailure({ dryRun: true, json: true, tag: "main", yes: true });

  const result = checks.lastWriteJsonCall() as UpdateRunResult | undefined;
  expect(result).toMatchObject({
    status: "error",
    reason: "unsupported-package-target",
    steps: [
      {
        name: "unsupported-package-target",
        exitCode: 1,
        failureFacts: [
          {
            check: "unsupported-package-target",
            code: "unsupported-package-target",
          },
        ],
      },
    ],
  });
  expect(checks.packageInstallCommandCall()?.[0]).toBeUndefined();
  checks.expectNoSideEffects(
    mocks.resolveGlobalManager,
    cli.replaceConfigFile,
    cli.updateGitCheckout,
    cleanupStaleManagedServiceUpdateHandoffs,
    cli.defaultRuntime.exit,
  );
  expect(checks.getErrorOutput()).toContain("openclaw update --channel dev");
});

it("retains the exact package and launchers for explicit rollback after managed Doctor fails", async () => {
  const tempDir = f.tempDirs.make("openclaw-update-managed-backup-");
  const { nodeModules, pkgRoot, entryPath } = await f.setupInstalledPackageAtNodeModules(
    path.join(tempDir, "lib", "node_modules"),
  );
  const candidateVersion = "2026.5.14";
  const packageEntry = path.join(pkgRoot, "dist", "index.js");
  const launcherDir = path.join(tempDir, "bin");
  await fs.writeFile(packageEntry, "old package entry\n", "utf8");
  await writeLaunchers(launcherDir, "old");
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
  mocks.createPreUpdateConfigSnapshotMock.mockImplementation(createPreUpdateConfigSnapshot);
  f.mockFileBackedPathExists();
  mocks.readPackageVersion.mockImplementation(readVersion);
  let backupAtDoctorEntry: string | undefined;
  f.mockNpmGlobalCommands(nodeModules, async (argv, options) => {
    if (argv[0] === "npm" && argv[1] === "i" && argv.includes("--prefix")) {
      const stagePrefix = await writeStagedPackage(
        argv,
        candidateVersion,
        "candidate package entry\n",
      );
      await writeLaunchers(path.join(stagePrefix, "bin"), "candidate");
    }
    if (argv[1] !== entryPath || argv[2] !== "doctor") {
      return undefined;
    }
    await expectText(manifestPath(pkgRoot)).toContain(`"version":"${candidateVersion}"`);
    await expectText(packageEntry).toBe("candidate package entry\n");
    await expectLaunchers(launcherDir, "candidate");
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

  expect(backupAtDoctorEntry).toBe(managedBytes);
  await expectText(`${managedConfig}.pre-update`).toBe(managedBytes);
  await expectText(callerConfig).toBe(callerBytes);
  await expectText(`${callerConfig}.pre-update`).toBe(existingCallerBackup);
  expect(result).toMatchObject({
    status: "error",
    after: { version: candidateVersion },
    recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
  });
  const retained = checks.requireValue(transaction, "retained package transaction");
  expect(await readVersion(retained.backupRoot)).toBe("2026.4.21");
  await expectText(packageEntry).toBe("candidate package entry\n");
  const assertCurrent = () => {};
  expect(await retained.rollback(assertCurrent)).toMatchObject({ exitCode: 0 });
  await retained.complete({ activationVerified: false }, assertCurrent);
  const doctorStep = result.steps.find((step) => step.name === "openclaw doctor");
  expect([doctorStep?.exitCode, doctorStep?.advisory]).toEqual([1, undefined]);
  await expectText(manifestPath(pkgRoot)).toContain('"version":"2026.4.21"');
  await expectText(packageEntry).toBe("old package entry\n");
  expect(await fs.stat(pkgRoot)).toMatchObject({
    dev: originalPackageIdentity.dev,
    ino: originalPackageIdentity.ino,
  });
  await expectLaunchers(launcherDir, "old");
  expect(
    (await fs.readdir(nodeModules)).filter((entry) =>
      /^\.openclaw(?:\.update-stage-|[.-](?:package|shim)-backup-)/.test(entry),
    ),
  ).toEqual([]);
  checks.expectNoSideEffects(mocks.serviceStart, mocks.serviceRestart);
});

it("fails package activation when Doctor reports requester-revoked", async () => {
  const refusal: UpdateDoctorConfigWriteRefusal = {
    reason: "requester-revoked",
    message: "The original write owner refused publication.",
    keys: ["meta", "plugins", "wizard"],
  };
  await packageDoctor(
    "2026.9.3",
    "2026.9.4",
    { status: "error", configWriteRefusal: refusal },
    commandResult({ code: 1 }),
  );
  await expectUpdateFailure({ yes: true, restart: false, json: true });
  expect(checks.lastWriteJsonCall()).toMatchObject({
    status: "error",
    reason: "requester-revoked",
    steps: expect.arrayContaining([expect.objectContaining({ configWriteRefusal: refusal })]),
  });
});

it("continues package post-core work for explicit post-update doctor advisories", async () => {
  const warning =
    "Doctor include-owned keys agents: promotion unavailable for include-owned configuration.";
  mocks.readPackageVersion.mockImplementation(readVersion);
  const { entryPath } = await packageDoctor(
    "2026.4.20",
    VERSION,
    { status: "ok", warnings: [warning] },
    commandResult({ stderr: warning, code: 0 }),
  );

  await withEnvAsync({ OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "1" }, async () => {
    await cli.updateCommand({ yes: true, restart: false, json: true });
  });

  const doctorCall = checks.doctorCommandCall();
  expect(doctorCall?.[0].slice(1)).toEqual([entryPath, "doctor", "--non-interactive", "--fix"]);
  expectDoctorEnv();
  const postCoreCall = checks.spawnCall();
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
  expect(mocks.updateNpmInstalledPlugins).not.toHaveBeenCalled();
  expect(cli.defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  const jsonOutput = checks.lastWriteJsonCall() as UpdateRunResult | undefined;
  const doctorStep = jsonOutput?.steps.find((step) => step.name === "openclaw doctor");
  expect(jsonOutput?.status).toBe("ok");
  expect(doctorStep).toMatchObject({ exitCode: 0, warnings: [warning] });
  expect(doctorStep?.advisory).toEqual({
    kind: "package-post-install-doctor",
    message: expect.stringContaining("recoverable update-time repair warning"),
  });
  expect(doctorStep?.advisory?.message).not.toContain("gateway restart");
  expect(doctorStep?.stderrTail).toContain(warning);
  const record = checks.requireValue(
    cli.getUpdateRun(checks.requireValue(jsonOutput?.runId, "updated run id")),
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
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  mocks.suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
  mocks.resumeScheduledTaskAutoStartAfterUpdate.mockRejectedValue(new Error("task restore denied"));
  const root = await f.mockPackageInstallAtCaseDir("openclaw-update-autostart-restore-failure");
  f.mockCurrentProcessFreshDoctor({ packageRoot: root });
  f.mockRunningManagedGateway([
    nodeExecutable,
    path.join(root, "dist", "index.js"),
    "gateway",
    "run",
  ]);
  f.mockFileBackedPathExists();
  f.setTty(true);
  f.setStdoutTty(true);
  await expect(
    withEnvAsync({ OPENCLAW_UPDATE_RUN_HANDOFF: undefined }, () =>
      cli.updateCommand({ json: false }),
    ),
  ).rejects.toEqual(new cli.ExitError(1));
  expect(mocks.resumeScheduledTaskAutoStartAfterUpdate).toHaveBeenCalledOnce();
  expect(cli.defaultRuntime.exit).not.toHaveBeenCalled();
  expect(mocks.triageCommand).toHaveBeenCalledTimes(1);
  expect(mocks.triageCommand.mock.calls[0]?.[1]?.recovery?.updateFailure).toMatchObject({
    result: {
      status: "error",
      reason: "windows-task-autostart-restore-failed",
      recovery: { serviceRestartSafe: false },
    },
  });
  expect(cli.listUpdateRuns({ limit: 1 })).toMatchObject([
    { phase: "finished", status: "failed", reason: "windows-task-autostart-restore-failed" },
  ]);
});
it("gates old Gateway recovery at the swap boundary after staged npm shim swap failure", async () => {
  await f.useFileBackedConfig();
  const tempDir = f.tempDirs.make("openclaw-update-staged-fail-");
  const prefix = path.join(tempDir, "prefix");
  const nodeModules = path.join(prefix, "lib", "node_modules");
  const { pkgRoot, entryPath } = await f.setupInstalledPackageAtNodeModules(
    nodeModules,
    "2026.7.1",
  );
  f.mockFileBackedPathExists();
  f.mockRunningManagedGateway([process.execPath, entryPath, "gateway", "run"]);
  vi.mocked(cli.resolveGatewayInstallEntrypoint).mockResolvedValue(entryPath);
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
  vi.spyOn(prototype, "copyIn").mockImplementation(async function (
    this: Root,
    destination,
    source,
    options,
  ) {
    if (source === stagedShim) {
      injections += 1;
      expect(await readVersion(pkgRoot)).toBe("2026.8.1");
      throw new Error("staged shim copy failed");
    }
    await copy.call(this, destination, source, options);
  });
  mocks.readPackageVersion.mockResolvedValue("2026.7.1");
  f.primeNpmChannelTag("latest", "2026.8.1");
  f.mockNpmGlobalCommands(nodeModules, async (argv) => {
    if (argv[0] === "npm" && argv[1] === "i" && argv.includes("--prefix")) {
      expect(mocks.serviceStop).not.toHaveBeenCalled();
      expect(checks.freshRestartCalls()).toEqual([]);
      const stagePrefix = await writeStagedPackage(argv, "2026.8.1", "export {};\n");
      stagedShim = path.join(stagePrefix, "bin", "openclaw");
      await fs.mkdir(path.dirname(stagedShim), { recursive: true });
      await fs.writeFile(stagedShim, "new shim\n");
    }
    return undefined;
  });

  await expectUpdateFailure({ yes: true });

  expect(injections).toBe(1);
  checks.expectNoSideEffects(cli.defaultRuntime.exit, mocks.updateNpmInstalledPlugins);
  expect(checks.doctorCommandCall()).toBeUndefined();
  expect(
    checks
      .commandCalls()
      .filter(([argv]) => argv[0] === process.execPath && argv[1]?.includes("/scripts/")),
  ).toEqual([]);
  await expectText(manifestPath(pkgRoot)).toContain('"version":"2026.7.1"');
  const logs = checks.getLogOutput();
  expect(logs).toContain("package-swap");
  expect(logs).toContain("staged shim copy failed");
  await expectText(targetShim).toBe("old shim\n");
  expect(checks.freshRestartCalls()).toEqual([]);
  expect(mocks.serviceStop).toHaveBeenCalledTimes(1);
  expect(logs).not.toContain(
    "Recovered managed gateway service and verified readiness after failed update.",
  );
  checks.expectNoSideEffects(mocks.serviceStart, mocks.serviceRestart);
});

it("runs old package doctors without fix mode when the service belongs to another install", async () => {
  const tempDir = f.tempDirs.make("openclaw-update-package-");
  const { nodeModules, entryPath } = await f.setupInstalledPackageRoot(tempDir, "2026.4.20");
  const foreignRoot = f.createCaseDir("old-doctor-foreign");
  const foreignEntry = await writeOpenClawPackageFixture(foreignRoot, "1.0.0", {
    entrySource: "export {};\n",
    git: true,
  });
  await fs.mkdir(path.join(foreignRoot, "src"));
  await fs.mkdir(path.join(foreignRoot, "extensions"));
  f.primeServiceCommand([nodeExecutable, foreignEntry, "gateway", "run"]);
  mocks.serviceLoaded.mockResolvedValue(true);
  mocks.serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
  mocks.readPackageVersion.mockImplementation(readVersion);
  f.primeNpmChannelTag("latest", "2026.4.21");
  f.mockFileBackedPathExists();
  f.mockNpmGlobalRoot(nodeModules);

  await withEnvAsync({ OPENCLAW_SERVICE_REPAIR_POLICY: "external" }, () =>
    cli.updateCommand({ yes: true }),
  );

  const doctorCall = checks.doctorCommandCall();
  expect(doctorCall?.[0]).toEqual([nodeExecutable, entryPath, "doctor", "--non-interactive"]);
  expectDoctorEnv({ OPENCLAW_UPDATE_IN_PROGRESS: "1" });
  expect(doctorCall?.[1].env?.OPENCLAW_SERVICE_REPAIR_POLICY).toBeUndefined();
  const doctorIndex = checks.doctorCommandCallIndex();
  const snapshotOrder = mocks.createPreUpdateConfigSnapshotMock.mock.invocationCallOrder[0];
  const doctorOrder = vi.mocked(cli.runCommandWithTimeout).mock.invocationCallOrder[doctorIndex];
  expect(checks.requireValue(snapshotOrder, "pre-update snapshot call order")).toBeLessThan(
    checks.requireValue(doctorOrder, "post-update doctor call order"),
  );
});
