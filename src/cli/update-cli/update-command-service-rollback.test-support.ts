import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import { readConfigFileSnapshot } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { writePackageRoot } from "../../infra/package-update-steps.test-support.js";
import {
  swapStagedPackageInstall,
  type PackageUpdateTransaction,
} from "../../infra/package-update-swap.js";
import * as candidateState from "../../infra/update-candidate-state.js";
import type { ResolvedGlobalInstallTarget } from "../../infra/update-global.js";
import { prepareNativePackageStage } from "../../infra/update-native-package-stage.js";
import { VERSION } from "../../version.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";
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
    "refreshed",
    "running original",
    "changed command",
    "changed manager",
    "unavailable manager",
    "sealed definition",
    "foreign command",
    "changed manager during install",
    "foreign command during install",
  ] as const)("rolls back a pnpm generation with %s service ownership", async (scenario) => {
    const { root, run, mocks } = getFixture();
    const changesDuringInstall =
      scenario === "changed manager during install" ||
      scenario === "foreign command during install";
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
    };
    mocks.command.mockResolvedValue(command);
    mocks.capability.mockResolvedValue({ kind: "writable" });
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
    const refreshed = scenario === "refreshed" || changesDuringInstall;
    mocks.running =
      refreshed || ["running original", "changed command", "changed manager"].includes(scenario);
    const currentCommand = refreshed
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
    if (scenario === "foreign command" || scenario === "foreign command during install") {
      await writePackageRoot(foreignRoot, VERSION);
    }
    let reads = 0;
    let changedDuringStop = false;
    mocks.command.mockImplementation(async () => {
      reads++;
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
    if (scenario === "unavailable manager") {
      mocks.managerUid = undefined;
    } else if (scenario === "sealed definition") {
      mocks.capability.mockResolvedValue({ kind: "sealed", reason: "foreign-owner" });
    }
    mocks.configSnapshot.mockResolvedValue(undefined);
    mocks.child.mockImplementation(async (argv) => {
      expect(argv[1]).toBe(path.join(previousRoot, "dist", "index.js"));
      expect(await fs.readFile(path.join(previousRoot, "package.json"), "utf8")).toContain(VERSION);
      if (argv.includes("install")) {
        mocks.command.mockResolvedValue(command);
        if (scenario === "changed manager during install") {
          mocks.managerUid = 3002;
        } else if (scenario === "foreign command during install") {
          mocks.command.mockResolvedValue({
            ...command,
            programArguments: [
              process.execPath,
              path.join(foreignRoot, "dist", "index.js"),
              "gateway",
            ],
          });
        }
      } else if (argv.includes("restart")) {
        mocks.running = true;
      } else {
        throw new Error("unexpected rollback subprocess");
      }
      return {
        code: 0,
        stdout: JSON.stringify({ action: "restart", ok: true, result: "restarted" }),
        stderr: "",
        signal: null,
        killed: false,
        termination: "exit",
      };
    });
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
    });
    const refused = [
      "changed command",
      "changed manager",
      "unavailable manager",
      "sealed definition",
      "foreign command",
    ].includes(scenario);
    if (changesDuringInstall) {
      expect(outcome.rolledBack).toBe(false);
      expect(outcome.result).toMatchObject({
        reason: "service-revalidation-failed",
        root: previousRoot,
        recovery: { packageRollbackVerified: true },
      });
      expect(await fs.readFile(path.join(previousRoot, "package.json"), "utf8")).toContain(VERSION);
      expect(await fs.readFile(path.join(binDir, "openclaw"), "utf8")).toBe("previous launcher\n");
      await expect(fs.stat(candidateRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(mocks.child).toHaveBeenCalledOnce();
      expect(mocks.child.mock.calls[0]?.[0]).toContain("install");
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
      });
      expect(await fs.readFile(path.join(previousRoot, "package.json"), "utf8")).toContain(VERSION);
      expect(await fs.readFile(path.join(binDir, "openclaw"), "utf8")).toBe("previous launcher\n");
      expect(mocks.running).toBe(true);
      expect(mocks.events.filter((event) => event === "native stop")).toHaveLength(
        scenario === "refreshed" || scenario === "running original" ? 2 : 1,
      );
      await transaction.complete({ activationVerified: false }, () => {});
    }
  });
}
