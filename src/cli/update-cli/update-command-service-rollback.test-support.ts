import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { captureGatewayServiceDefinitionBackup } from "../../daemon/service-definition-backup.js";
import { withGatewayServiceOperationLock } from "../../daemon/service-operation-lock.js";
import { withSystemdDefinitionMutation } from "../../daemon/systemd-definition-mutation.js";
import * as systemdExec from "../../daemon/systemd-exec.js";
import * as systemdFiles from "../../daemon/systemd-service-files.js";
import * as systemdSystem from "../../daemon/systemd-system.js";
import { buildSystemdUnit } from "../../daemon/systemd-unit.js";
import { writePackageRoot } from "../../infra/package-update-steps.test-support.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-swap-contract.js";
import { swapStagedPackageInstall } from "../../infra/package-update-swap.js";
import * as candidateState from "../../infra/update-candidate-state.js";
import type { ResolvedGlobalInstallTarget } from "../../infra/update-global.js";
import { prepareNativePackageStage } from "../../infra/update-native-package-stage.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import { createCommandResult as commandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { VERSION } from "../../version.js";
import { writeFixtureJson } from "../cli-fixtures.test-support.js";
import { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";
import { updateResult, updateStep } from "./update-command-maintenance-fixtures.test-support.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";
import type {
  PreManagedServiceStop,
  UpdateServiceDefinitionRecovery,
} from "./update-command-service-context-types.js";
import { maintenanceDefaults } from "./update-command-service-fixtures.test-support.js";
import type { InstallRootTransitionFixture } from "./update-command-service-fixtures.test-support.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service.js";

const readText = (file: string) => fs.readFile(file, "utf8");
const gatewayArgs = (root: string, ...args: string[]) => [
  process.execPath,
  path.join(root, "dist", "index.js"),
  "gateway",
  ...args,
];
async function expectPackageVersion(root: string, version: string) {
  expect(await readText(path.join(root, "package.json"))).toContain(version);
}
const packageRoot = (owner: string) => path.join(owner, "node_modules", "openclaw");
async function writePackageOwner(owner: string, version: string) {
  await writePackageRoot(packageRoot(owner), version);
  await writeFixtureJson(path.join(owner, "package.json"), { dependencies: { openclaw: version } });
}

export function registerPackageRootRollbackTests(
  getFixture: () => InstallRootTransitionFixture & { mocks: { managerUid: number | undefined } },
) {
  it.each([
    "removed",
    "running original",
    "changed command",
    "changed manager",
    "unavailable manager",
    "sealed definition",
    "foreign command",
    "changed manager after restore",
    "foreign command after restore",
    "backup restored",
    "backup restored from another install",
    "backup restore failed",
    "backup edited",
    "backup unverified",
  ] as const)("rolls back a pnpm generation with %s service ownership", async (scenario) => {
    const { root, run, mocks } = getFixture();
    const backupScenario = scenario.startsWith("backup ");
    const installationDrift = scenario === "backup restored from another install";
    const backupRestored = scenario === "backup restored" || installationDrift;
    const previousPackageVersion = installationDrift ? "2026.1.1" : VERSION;
    const changesAfterRestore =
      scenario === "changed manager after restore" || scenario === "foreign command after restore";
    // A removed group must not resolve to the fixture's enclosing package.
    await fs.rm(path.join(root, "package.json"));
    const globalRoot = path.join(root, "pnpm", "global", "v11");
    const previousOwner = path.join(globalRoot, "previous");
    const previousRoot = packageRoot(previousOwner);
    const { recordPhase } = createUpdateCommandExecutionGuards({ run }, previousRoot);
    const candidateRoot = packageRoot(path.join(globalRoot, "candidate"));
    const binDir = path.join(root, "bin");
    const serviceRoot = installationDrift ? path.join(root, "service-install") : previousRoot;
    await writePackageOwner(previousOwner, previousPackageVersion);
    if (installationDrift) {
      await writePackageRoot(serviceRoot, VERSION);
    }
    await fs.symlink("previous", path.join(globalRoot, "active-openclaw"));
    await fs.mkdir(binDir);
    await fs.writeFile(path.join(binDir, "openclaw"), "previous launcher\n");
    const definitionPath = systemdFiles.resolveSystemdUnitPath(run.env);
    const readDefinition = () => readText(definitionPath);
    const command = {
      programArguments: gatewayArgs(serviceRoot, "--port", "19305"),
      environment: { HOME: root },
      sourcePath: definitionPath,
      definitionPaths: [definitionPath],
    };
    mocks.command.mockResolvedValue(command);
    mocks.capability.mockResolvedValue({ kind: "writable" });
    const previousDefinition = buildSystemdUnit(command).replace("KillMode=mixed\n", "");
    await fs.writeFile(definitionPath, previousDefinition);
    if (backupScenario) {
      vi.spyOn(systemdFiles, "readSystemdServiceExecStart").mockImplementation(mocks.command);
      vi.spyOn(systemdSystem, "assertNoSystemSystemdOwnership").mockResolvedValue(undefined);
      const readFile = fs.readFile.bind(fs);
      vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        if (typeof args[0] === "string" && args[0].startsWith("/proc/self/fdinfo/")) {
          return "mnt_id:\t1\n";
        }
        if (args[0] === "/proc/self/mountinfo") {
          return "1 0 0:1 / / rw - tmpfs tmpfs rw\n";
        }
        return readFile(...args);
      });
    }
    // Keep real schema/config comparisons without starting a package worker in this service fixture.
    vi.spyOn(candidateState, "readUpdateStateSchemaVersions").mockImplementation(
      candidateState.readUpdateStateSchemaVersionsInProcess,
    );
    const configSnapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
    const schemaVersions = await candidateState.readUpdateStateSchemaVersions({
      stateDir: resolveStateDir(run.env),
      config: configSnapshot.sourceConfig,
      env: run.env,
    });
    const installTarget: ResolvedGlobalInstallTarget = {
      manager: "pnpm",
      command: "pnpm",
      globalRoot,
      packageRoot: previousRoot,
      pnpmIsolated: { layoutVersion: 11 },
    };
    const native = await prepareNativePackageStage({
      installTarget,
      packageName: "openclaw",
      installSpec: "openclaw@9999.1.1",
      globalBinDir: binDir,
      env: {},
    });
    if (!native) {
      throw new Error("native stage missing");
    }
    const stagedOwner = path.join(native.globalRoot, "candidate");
    const stagedRoot = packageRoot(stagedOwner);
    await writePackageOwner(stagedOwner, "9999.1.1");
    await fs.unlink(path.join(native.globalRoot, "active-openclaw"));
    await fs.symlink("candidate", path.join(native.globalRoot, "active-openclaw"));
    await fs.rm(path.join(native.globalRoot, "previous"), { recursive: true });
    await fs.symlink(
      path.relative(native.binDir, path.join(stagedRoot, "dist", "index.js")),
      path.join(native.binDir, "openclaw"),
    );
    let before: PreManagedServiceStop | undefined;
    let transaction: PackageUpdateTransaction | undefined;
    await swapStagedPackageInstall({
      stage: {
        prefix: native.projectRoot,
        layout: {
          prefix: native.projectRoot,
          globalRoot: native.globalRoot,
          binDir: native.binDir,
        },
        packageRoot: stagedRoot,
        installTarget: { ...installTarget, globalRoot: native.globalRoot, packageRoot: stagedRoot },
        native,
      },
      installTarget,
      packageName: "openclaw",
      beforeActivate: async () => {
        before = await maybeStopManagedServiceBeforeMutableUpdate({
          ...maintenanceDefaults,
          root: previousRoot,
          updateRun: run,
          recordPhase,
        });
      },
      onTransaction: (retained) => {
        transaction = retained;
      },
    });
    if (!before || !transaction) {
      throw new Error("retained package and service ownership missing");
    }
    if (installationDrift) {
      before.serviceIdentity = { version: VERSION };
    }
    mocks.running =
      backupScenario ||
      changesAfterRestore ||
      ["running original", "changed command", "changed manager"].includes(scenario);
    const currentCommand = backupScenario
      ? {
          ...command,
          programArguments: gatewayArgs(candidateRoot, "--port", "19305"),
        }
      : command;
    const foreignRoot = path.join(root, "foreign");
    const foreignCommand = { ...command, programArguments: gatewayArgs(foreignRoot) };
    if (scenario === "foreign command" || scenario === "foreign command after restore") {
      await writePackageRoot(foreignRoot, VERSION);
    }
    let reads = 0;
    let changedDuringStop = false;
    mocks.command.mockImplementation(async () => {
      reads++;
      if (backupScenario) {
        return (await readDefinition()).includes(candidateRoot) ? currentCommand : command;
      }
      if (reads === 2 && (scenario === "changed command" || scenario === "changed manager")) {
        changedDuringStop = true;
      }
      if (scenario === "changed manager" && reads === 2) {
        mocks.managerUid = 3002;
      }
      if (scenario === "foreign command") {
        return foreignCommand;
      }
      return scenario === "changed command" && reads >= 2
        ? { ...currentCommand, programArguments: [...currentCommand.programArguments, "--verbose"] }
        : currentCommand;
    });
    const definitionRecovery: UpdateServiceDefinitionRecovery = {};
    if (backupScenario) {
      await withGatewayServiceOperationLock(run.env, async (assertCurrent) => {
        const backup = await captureGatewayServiceDefinitionBackup({
          env: run.env,
          command,
          assertCurrent,
        });
        await withSystemdDefinitionMutation(
          run.env,
          command.environment,
          (mutation) => mutation.publish(definitionPath, buildSystemdUnit(currentCommand), 0o600),
          { definitionTransaction: backup.hooks },
        );
        definitionRecovery.backup = await backup.finish();
      });
      if (scenario === "backup edited") {
        await fs.appendFile(definitionPath, "Nice=7\n");
      }
      if (scenario === "backup unverified") {
        definitionRecovery.unverified = true;
      }
    }
    const definitionBeforeRollback = backupScenario ? await fs.readFile(definitionPath) : undefined;
    if (scenario === "unavailable manager") {
      mocks.managerUid = undefined;
    } else if (scenario === "sealed definition") {
      mocks.capability.mockResolvedValue({ kind: "sealed", reason: "foreign-owner" });
    }
    mocks.configSnapshot.mockResolvedValue(undefined);
    if (changesAfterRestore) {
      const rollback = transaction.rollback.bind(transaction);
      vi.spyOn(transaction, "rollback").mockImplementation(async (assertCurrent) => {
        const restored = await rollback(assertCurrent);
        if (scenario === "changed manager after restore") {
          mocks.managerUid = 3002;
        } else {
          await fs.writeFile(definitionPath, buildSystemdUnit(foreignCommand));
          mocks.command.mockResolvedValue(foreignCommand);
        }
        return restored;
      });
    }
    mocks.child.mockImplementation(async (argv) => {
      expect(argv[1]).toBe(path.join(previousRoot, "dist", "index.js"));
      await expectPackageVersion(previousRoot, previousPackageVersion);
      expect(argv).not.toContain("install");
      expect(argv).toEqual(expect.arrayContaining(["restart", "--preserve-definition"]));
      expect(await readDefinition()).toBe(previousDefinition);
      mocks.running = true;
      return commandResult({
        stdout: JSON.stringify({ action: "restart", ok: true, result: "restarted" }),
      });
    });
    if (scenario === "backup restore failed") {
      vi.spyOn(systemdExec, "reloadSystemdUserManager").mockRejectedValueOnce(
        new Error("Retained service definition reload failed"),
      );
    }
    const { result, rolledBack } = await rollbackFailedUpdate({
      result: updateResult({
        status: "error",
        reason: "doctor-failed",
        mode: "pnpm",
        root: candidateRoot,
        before: { version: previousPackageVersion },
        after: { version: "9999.1.1" },
        steps: [
          updateStep("openclaw doctor", {
            command: "doctor",
            cwd: candidateRoot,
            exitCode: 73,
          }),
        ],
      }),
      previousRoot,
      packageTransaction: transaction,
      schemaVersions,
      previousVerified: true,
      configSnapshot,
      opts: { json: true, run },
      preManagedServiceStop: before,
      timeoutMs: 1000,
      nodeRunner: process.execPath,
      definitionRecovery,
    });
    const expectEvents = (event: string, count: number) =>
      expect(mocks.events.filter((entry) => entry === event)).toHaveLength(count);
    expectEvents("native daemon-reload", backupRestored ? 1 : 0);
    const refused = [
      "changed command",
      "changed manager",
      "unavailable manager",
      "sealed definition",
      "foreign command",
    ].includes(scenario);
    const restored =
      scenario === "backup restore failed" ||
      changesAfterRestore ||
      (!refused && (!backupScenario || backupRestored));
    const succeeded = restored && scenario !== "backup restore failed" && !changesAfterRestore;
    expect(rolledBack).toBe(succeeded);
    await expectPackageVersion(
      restored ? previousRoot : candidateRoot,
      restored ? previousPackageVersion : "9999.1.1",
    );
    expect(result.reason).toBe(
      refused || changesAfterRestore ? "service-revalidation-failed" : "doctor-failed",
    );
    if (!succeeded) {
      expect(mocks.child).not.toHaveBeenCalled();
    }
    if (restored) {
      expect(result).toMatchObject({
        root: previousRoot,
        recovery: { packageRollbackVerified: true },
      });
    }
    if (!refused) {
      expect(mocks.running).toBe(
        succeeded ||
          (backupScenario && scenario !== "backup restore failed" && !changesAfterRestore),
      );
    }
    if (scenario === "backup restore failed") {
      expect(await readDefinition()).toBe(previousDefinition);
    }
    if (succeeded || changesAfterRestore) {
      expect(await readText(path.join(binDir, "openclaw"))).toBe("previous launcher\n");
    }
    if (scenario === "backup restore failed") {
      expect(result).toMatchObject({
        recovery: { serviceRestartSafe: false },
        rollbackOutcome: { status: "failed" },
      });
      expect(result).not.toHaveProperty("recovery.dataAtRisk");
    } else if (backupScenario && !backupRestored) {
      expect(await fs.readFile(definitionPath)).toEqual(definitionBeforeRollback);
      expect(result).not.toHaveProperty("recovery.dataAtRisk");
      expect(result.rollbackOutcome).toEqual({
        status: "not-attempted",
        reason: "service-definition-rollback-unverified",
      });
      if (scenario === "backup edited") {
        const warning = `SERVICE_DEFINITION_UNKNOWN: Service definition changed: ${definitionPath}`;
        expect(result.steps).toContainEqual(expect.objectContaining({ warnings: [warning] }));
        expect(getUpdateRun(run.runId, { env: run.env })?.steps).toContainEqual(
          expect.objectContaining({
            step: "warning:package rollback",
            status: "completed",
            detail: warning.replace(root, "~"),
          }),
        );
      }
      expectEvents("native stop", 1);
    } else if (changesAfterRestore) {
      await expect(fs.stat(candidateRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expectEvents("native stop", 2);
    } else if (refused) {
      if (scenario === "changed command" || scenario === "changed manager") {
        expect(changedDuringStop).toBe(true);
      }
      await expectPackageVersion(
        packageRoot(path.join(transaction.backupRoot, "v11", "previous")),
        previousPackageVersion,
      );
      expectEvents("native stop", 1);
    } else {
      expect(result).toMatchObject({
        status: "error",
        after: { version: previousPackageVersion },
        recovery: { service: "healthy", version: VERSION },
        rollbackOutcome: { status: "succeeded" },
      });
      expectEvents("native stop", scenario === "running original" || backupScenario ? 2 : 1);
      if (installationDrift) {
        await expectPackageVersion(serviceRoot, VERSION);
        expect(mocks.health).toHaveBeenCalledWith(
          expect.objectContaining({ port: 19305, expectedVersion: VERSION }),
        );
        expect(await readDefinition()).toContain(serviceRoot);
        await expect(fs.stat(candidateRoot)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(mocks.health).toHaveBeenCalledWith(
        expect.objectContaining({ expectedVersion: VERSION }),
      );
      await transaction.complete({ activationVerified: false }, () => {});
    }
  });
}
