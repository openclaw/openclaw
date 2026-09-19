import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
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
import {
  swapStagedPackageInstall,
  type PackageUpdateTransaction,
} from "../../infra/package-update-swap.js";
import * as candidateState from "../../infra/update-candidate-state.js";
import type { ResolvedGlobalInstallTarget } from "../../infra/update-global.js";
import { prepareNativePackageStage } from "../../infra/update-native-package-stage.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import { VERSION } from "../../version.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";
import type {
  PreManagedServiceStop,
  UpdateServiceDefinitionRecovery,
} from "./update-command-service-context-types.js";
import type { InstallRootTransitionFixture } from "./update-command-service-transition.test-support.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service.js";

export function registerPackageRootRollbackTests(
  getFixture: () => InstallRootTransitionFixture & {
    mocks: { managerUid: number | undefined; error: Mock };
  },
) {
  it.each([
    "removed",
    "retained",
    "running original",
    "changed command",
    "changed manager",
    "unavailable manager",
    "sealed definition",
    "foreign command",
    "changed manager after restore",
    "foreign command after restore",
    "backup restored",
    "backup restore failed",
    "backup edited",
    "backup invalid",
    "backup unverified",
  ] as const)("rolls back a pnpm generation with %s service ownership", async (scenario) => {
    const { root, run, mocks } = getFixture();
    const backupScenario = scenario.startsWith("backup ");
    const changesAfterRestore =
      scenario === "changed manager after restore" || scenario === "foreign command after restore";
    // A removed group must not resolve to the fixture's enclosing package.
    await fs.rm(path.join(root, "package.json"));
    const globalRoot = path.join(root, "pnpm", "global", "v11");
    const previousOwner = path.join(globalRoot, "previous");
    const previousRoot = path.join(previousOwner, "node_modules", "openclaw");
    const candidateRoot = path.join(globalRoot, "candidate", "node_modules", "openclaw");
    const binDir = path.join(root, "bin");
    await writePackageRoot(previousRoot, VERSION);
    await fs.writeFile(
      path.join(previousOwner, "package.json"),
      JSON.stringify({ dependencies: { openclaw: VERSION } }),
    );
    await fs.symlink("previous", path.join(globalRoot, "active-openclaw"));
    await fs.mkdir(binDir);
    await fs.writeFile(path.join(binDir, "openclaw"), "previous launcher\n");
    const command = {
      programArguments: [
        process.execPath,
        path.join(previousRoot, "dist", "index.js"),
        "gateway",
        "--port",
        "19305",
      ],
      environment: { HOME: root },
      sourcePath: systemdFiles.resolveSystemdUnitPath(run.env),
      definitionPaths: [systemdFiles.resolveSystemdUnitPath(run.env)],
    };
    mocks.command.mockResolvedValue(command);
    mocks.capability.mockResolvedValue({ kind: "writable" });
    const previousDefinition = buildSystemdUnit(command).replace("KillMode=mixed\n", "");
    await fs.writeFile(command.sourcePath, previousDefinition);
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
    const stagedRoot = path.join(stagedOwner, "node_modules", "openclaw");
    await writePackageRoot(stagedRoot, "9999.1.1");
    await fs.writeFile(
      path.join(stagedOwner, "package.json"),
      JSON.stringify({ dependencies: { openclaw: "9999.1.1" } }),
    );
    await fs.unlink(path.join(native.globalRoot, "active-openclaw"));
    await fs.symlink("candidate", path.join(native.globalRoot, "active-openclaw"));
    if (scenario !== "retained") {
      await fs.rm(path.join(native.globalRoot, "previous"), { recursive: true });
    }
    await fs.symlink(
      path.relative(native.binDir, path.join(stagedRoot, "dist", "index.js")),
      path.join(native.binDir, "openclaw"),
    );
    let before: PreManagedServiceStop | undefined;
    let transaction: PackageUpdateTransaction | undefined;
    const swap = await swapStagedPackageInstall({
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
          root: previousRoot,
          updateInstallKind: "package",
          shouldRestart: true,
          jsonMode: true,
          updateRun: run,
        });
      },
      onTransaction: (retained) => {
        transaction = retained;
      },
    });
    expect(swap.status).toBe("committed");
    if (!before || !transaction) {
      throw new Error("retained package and service ownership missing");
    }
    expect(before.stopped).toBe(true);
    mocks.running =
      backupScenario ||
      changesAfterRestore ||
      ["running original", "changed command", "changed manager"].includes(scenario);
    const currentCommand = backupScenario
      ? {
          ...command,
          programArguments: [
            process.execPath,
            path.join(candidateRoot, "dist", "index.js"),
            "gateway",
            "--port",
            "19305",
          ],
        }
      : command;
    const foreignRoot = path.join(root, "foreign");
    if (scenario === "foreign command" || scenario === "foreign command after restore") {
      await writePackageRoot(foreignRoot, VERSION);
    }
    let reads = 0;
    let changedDuringStop = false;
    mocks.command.mockImplementation(async () => {
      reads++;
      if (backupScenario) {
        return (await fs.readFile(command.sourcePath!, "utf8")).includes(candidateRoot)
          ? currentCommand
          : command;
      }
      if (reads === 2 && (scenario === "changed command" || scenario === "changed manager")) {
        changedDuringStop = true;
      }
      if (scenario === "changed manager" && reads === 2) {
        mocks.managerUid = 3002;
      }
      if (scenario === "foreign command") {
        return {
          ...currentCommand,
          programArguments: [
            process.execPath,
            path.join(foreignRoot, "dist", "index.js"),
            "gateway",
          ],
        };
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
          (mutation) =>
            mutation.publish(command.sourcePath!, buildSystemdUnit(currentCommand), 0o600),
          { definitionTransaction: backup.hooks },
        );
        definitionRecovery.backup = await backup.finish();
      });
      if (scenario === "backup edited") {
        await fs.appendFile(command.sourcePath!, "Nice=7\n");
      }
      if (scenario === "backup invalid") {
        definitionRecovery.backup!.files[0]!.sourcePath += ".foreign";
      }
      if (scenario === "backup unverified") {
        definitionRecovery.unverified = true;
      }
    }
    const definitionBeforeRollback = backupScenario
      ? await fs.readFile(command.sourcePath!)
      : undefined;
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
          const foreignCommand = {
            ...command,
            programArguments: [
              process.execPath,
              path.join(foreignRoot, "dist", "index.js"),
              "gateway",
            ],
          };
          await fs.writeFile(command.sourcePath, buildSystemdUnit(foreignCommand));
          mocks.command.mockResolvedValue(foreignCommand);
        }
        return restored;
      });
    }
    mocks.child.mockImplementation(async (argv) => {
      expect(argv[1]).toBe(path.join(previousRoot, "dist", "index.js"));
      expect(await fs.readFile(path.join(previousRoot, "package.json"), "utf8")).toContain(VERSION);
      expect(argv).not.toContain("install");
      expect(argv).toContain("restart");
      expect(argv).toContain("--preserve-definition");
      expect(await fs.readFile(command.sourcePath, "utf8")).toBe(previousDefinition);
      mocks.running = true;
      return {
        code: 0,
        stdout: JSON.stringify({ action: "restart", ok: true, result: "restarted" }),
        stderr: "",
        signal: null,
        killed: false,
        termination: "exit",
      };
    });
    if (scenario === "backup restore failed") {
      vi.spyOn(systemdExec, "reloadSystemdUserManager").mockRejectedValueOnce(
        new Error("Retained service definition reload failed"),
      );
    }
    const outcome = await rollbackFailedUpdate({
      result: {
        status: "error",
        reason: "doctor-failed",
        mode: "pnpm",
        root: candidateRoot,
        before: { version: VERSION },
        after: { version: "9999.1.1" },
        steps: [
          {
            name: "openclaw doctor",
            command: "doctor",
            cwd: candidateRoot,
            durationMs: 1,
            exitCode: 73,
          },
        ],
        durationMs: 1,
      },
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
    expect(mocks.events.filter((event) => event === "native daemon-reload")).toHaveLength(
      scenario === "backup restored" ? 1 : 0,
    );
    const refused = [
      "changed command",
      "changed manager",
      "unavailable manager",
      "sealed definition",
      "foreign command",
    ].includes(scenario);
    if (scenario === "backup restore failed") {
      expect(outcome.rolledBack).toBe(false);
      expect(outcome.result).toMatchObject({
        reason: "service-definition-rollback-unverified",
        root: previousRoot,
        recovery: { packageRollbackVerified: true, serviceRestartSafe: false },
        rollbackOutcome: { status: "failed" },
      });
      expect(await fs.readFile(path.join(previousRoot, "package.json"), "utf8")).toContain(VERSION);
      expect(await fs.readFile(command.sourcePath, "utf8")).toBe(previousDefinition);
      expect(mocks.running).toBe(false);
      expect(mocks.child).not.toHaveBeenCalled();
    } else if (backupScenario && scenario !== "backup restored") {
      expect(outcome.rolledBack).toBe(false);
      expect(await fs.readFile(command.sourcePath!)).toEqual(definitionBeforeRollback);
      expect(mocks.child).not.toHaveBeenCalled();
      expect(outcome.result.reason).toBe("service-definition-rollback-unverified");
      expect(outcome.result.rollbackOutcome).toEqual({
        status: "not-attempted",
        reason: "service-definition-rollback-unverified",
      });
      if (scenario === "backup edited" || scenario === "backup invalid") {
        const warning =
          scenario === "backup edited"
            ? `SERVICE_DEFINITION_UNKNOWN: Service definition changed: ${command.sourcePath}`
            : "SERVICE_DEFINITION_UNKNOWN: Service backup selects different managed artifacts.";
        expect(outcome.result.steps).toContainEqual(
          expect.objectContaining({ warnings: [warning] }),
        );
        expect(getUpdateRun(run.runId, { env: run.env })?.steps).toContainEqual(
          expect.objectContaining({
            step: "warning:package rollback",
            status: "completed",
            detail: warning.replace(root, "~"),
          }),
        );
      }
      expect(await fs.readFile(path.join(candidateRoot, "package.json"), "utf8")).toContain(
        "9999.1.1",
      );
      expect(mocks.running).toBe(true);
      expect(mocks.events.filter((event) => event === "native stop")).toHaveLength(1);
    } else if (changesAfterRestore) {
      expect(outcome.rolledBack).toBe(false);
      expect(outcome.result).toMatchObject({
        reason: "service-revalidation-failed",
        root: previousRoot,
        recovery: { packageRollbackVerified: true },
      });
      expect(await fs.readFile(path.join(previousRoot, "package.json"), "utf8")).toContain(VERSION);
      expect(await fs.readFile(path.join(binDir, "openclaw"), "utf8")).toBe("previous launcher\n");
      await expect(fs.stat(candidateRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(mocks.child).not.toHaveBeenCalled();
      expect(mocks.running).toBe(false);
      expect(mocks.events.filter((event) => event === "native stop")).toHaveLength(2);
    } else if (refused) {
      if (scenario === "changed command" || scenario === "changed manager") {
        expect(changedDuringStop).toBe(true);
      }
      expect(outcome.rolledBack).toBe(false);
      expect(outcome.result.reason).toBe("service-revalidation-failed");
      expect(await fs.readFile(path.join(candidateRoot, "package.json"), "utf8")).toContain(
        "9999.1.1",
      );
      expect(
        await fs.readFile(
          path.join(
            transaction.backupRoot,
            "v11",
            "previous",
            "node_modules",
            "openclaw",
            "package.json",
          ),
          "utf8",
        ),
      ).toContain(VERSION);
      expect(mocks.events.filter((event) => event === "native stop")).toHaveLength(1);
      expect(mocks.child).not.toHaveBeenCalled();
    } else {
      expect(
        outcome.rolledBack,
        JSON.stringify({ outcome, errors: mocks.error.mock.calls }, null, 2),
      ).toBe(true);
      expect(outcome.result).toMatchObject({
        status: "error",
        reason: "doctor-failed",
        root: previousRoot,
        after: { version: VERSION },
        recovery: { packageRollbackVerified: true, service: "healthy" },
        rollbackOutcome: { status: "succeeded" },
      });
      expect(await fs.readFile(path.join(previousRoot, "package.json"), "utf8")).toContain(VERSION);
      expect(await fs.readFile(path.join(binDir, "openclaw"), "utf8")).toBe("previous launcher\n");
      expect(mocks.running).toBe(true);
      expect(mocks.events.filter((event) => event === "native stop")).toHaveLength(
        scenario === "running original" || backupScenario ? 2 : 1,
      );
      expect(await fs.readFile(command.sourcePath, "utf8")).toBe(previousDefinition);
      expect(mocks.child).toHaveBeenCalledOnce();
      expect(mocks.child.mock.calls[0]?.[0]).toContain("--preserve-definition");
      expect(mocks.health.mock.calls.some(([request]) => request.expectedVersion === VERSION)).toBe(
        true,
      );
      await transaction.complete({ activationVerified: false }, () => {});
    }
  });
}
