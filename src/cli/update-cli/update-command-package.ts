import path from "node:path";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV,
  UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION_ENV,
  UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR_ENV,
  UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV,
  UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART_ENV,
} from "../../commands/doctor/shared/update-phase.js";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import {
  GATEWAY_STARTUP_VERIFY_PROTOCOL,
  GATEWAY_STARTUP_VERIFY_PROTOCOL_VERSION,
} from "../../gateway/startup-verify.js";
import { createLowDiskSpaceWarning } from "../../infra/disk-space.js";
import {
  markPackagePostInstallDoctorAdvisory,
  type PackageUpdateStepResult,
  runGlobalPackageUpdateSteps,
} from "../../infra/package-update-steps.js";
import {
  consumeUpdatePostInstallDoctorResult,
  createUpdatePostInstallDoctorResultPath,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
} from "../../infra/update-doctor-result.js";
import {
  createGlobalInstallEnv,
  cleanupGlobalRenameDirs,
  resolveGlobalInstallSpec,
  resolveGlobalInstallTarget,
  type ResolvedGlobalInstallTarget,
} from "../../infra/update-global.js";
import { resolveUpdateRecoveryJournalPathFromSnapshot } from "../../infra/update-recovery-journal.js";
import {
  resolveUpdateDoctorExecutionPolicy,
  type UpdateRunResult,
} from "../../infra/update-runner.js";
import {
  createUpdateStateSnapshot,
  type UpdateStateSnapshot,
} from "../../infra/update-state-snapshot.js";
import {
  formatUpdateSwapCoverageWarning,
  resolveUpdateSwapCoverage,
} from "../../infra/update-swap-coverage.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveCliName } from "../cli-name.js";
import { createUpdateProgress } from "./progress.js";
import {
  DEFAULT_PACKAGE_NAME,
  createGlobalCommandRunner,
  readPackageName,
  readPackageVersion,
  resolveGlobalManager,
  resolveNodeRunner,
  runUpdateStep,
} from "./shared.js";
import { createUpdateConfigSnapshot } from "./update-command-config.js";
import { resolvePostInstallDoctorEnv } from "./update-command-service.js";

const CLI_NAME = resolveCliName();

export function validateGatewayStartupVerifyProof(
  stdout: string | null | undefined,
): string | null {
  if (!stdout?.trim()) {
    return "gateway startup verify returned no machine proof";
  }
  try {
    const proof: unknown = JSON.parse(stdout);
    if (
      typeof proof !== "object" ||
      proof === null ||
      !("ok" in proof) ||
      proof.ok !== true ||
      !("protocol" in proof) ||
      proof.protocol !== GATEWAY_STARTUP_VERIFY_PROTOCOL ||
      !("protocolVersion" in proof) ||
      proof.protocolVersion !== GATEWAY_STARTUP_VERIFY_PROTOCOL_VERSION
    ) {
      return "gateway startup verify returned an incompatible machine proof";
    }
    return null;
  } catch {
    return "gateway startup verify returned invalid JSON";
  }
}

export type PreparedPackageUpdateRollback = {
  packageRoot: string;
  retainedPackageRoot: string;
  stateSnapshot: UpdateStateSnapshot;
  recoveryJournalPath: string;
  nodePath: string;
  swapped: boolean;
};

export async function runPackageInstallUpdate(params: {
  root: string;
  installKind: "git" | "package" | "unknown";
  tag: string;
  installSpec?: string;
  timeoutMs: number;
  startedAt: number;
  progress: ReturnType<typeof createUpdateProgress>["progress"];
  jsonMode: boolean;
  allowGatewayServiceRepair: boolean;
  allowGatewayActivation: boolean;
  managedServiceEnv?: NodeJS.ProcessEnv;
  invocationCwd?: string;
  honorPackageRoot?: boolean;
  nodeRunner?: string;
  installEnv?: NodeJS.ProcessEnv;
  installTarget?: ResolvedGlobalInstallTarget;
  enableTransactionalRollback?: boolean;
  onRollbackPrepared?: (
    rollback: PreparedPackageUpdateRollback,
    phase: "snapshot" | "swap",
  ) => Promise<void> | void;
}): Promise<{ result: UpdateRunResult; rollback: PreparedPackageUpdateRollback | null }> {
  const installEnv = params.installEnv ?? (await createGlobalInstallEnv());
  const runCommand = createGlobalCommandRunner();
  let installTarget = params.installTarget;
  if (!installTarget) {
    const manager = await resolveGlobalManager({
      root: params.root,
      installKind: params.installKind,
      timeoutMs: params.timeoutMs,
    });
    installTarget = await resolveGlobalInstallTarget({
      manager,
      runCommand,
      timeoutMs: params.timeoutMs,
      pkgRoot: params.root,
      honorPackageRoot: params.honorPackageRoot === true,
    });
  }
  const pkgRoot = installTarget.packageRoot;
  const packageName =
    (pkgRoot ? await readPackageName(pkgRoot) : await readPackageName(params.root)) ??
    DEFAULT_PACKAGE_NAME;
  const installSpec =
    params.installSpec ??
    resolveGlobalInstallSpec({
      packageName,
      tag: params.tag,
      env: installEnv,
    });

  const beforeVersion = pkgRoot ? await readPackageVersion(pkgRoot) : null;
  const coverage = pkgRoot
    ? await resolveUpdateSwapCoverage({ packageRoot: pkgRoot, manager: installTarget.manager })
    : await resolveUpdateSwapCoverage({ packageRoot: params.root, manager: "unknown" });
  const rollbackEnv = params.managedServiceEnv ?? installEnv ?? process.env;
  const retainPreviousPackage =
    coverage.protection === "transactional-rollback" &&
    params.allowGatewayServiceRepair &&
    params.allowGatewayActivation &&
    rollbackEnv.OPENCLAW_UPDATE_NO_ROLLBACK !== "1";
  const enableTransactionalRollback =
    retainPreviousPackage && params.enableTransactionalRollback === true;
  let preparedRollback: PreparedPackageUpdateRollback | null = null;
  const coverageWarning = formatUpdateSwapCoverageWarning(coverage);
  if (coverageWarning) {
    defaultRuntime.error(`Warning: ${coverageWarning}`);
  } else if (rollbackEnv.OPENCLAW_UPDATE_NO_ROLLBACK !== "1") {
    if (retainPreviousPackage) {
      defaultRuntime.error(
        "Warning: OpenClaw retained one launchable previous package. Automatic state rollback requires a detached channel-initiated managed update.",
      );
    } else {
      const reason = !params.allowGatewayServiceRepair
        ? "the Gateway service is not owned by this install"
        : "the Gateway service was not stopped for this update";
      defaultRuntime.error(
        `Warning: Previous-package retention is unavailable because ${reason}. If startup fails after migration, restore compatible state before running an older version; otherwise repair or update forward with the current version.`,
      );
    }
  }
  if (pkgRoot) {
    await cleanupGlobalRenameDirs({
      globalRoot: path.dirname(pkgRoot),
      packageName,
    });
  }

  const diskWarning = createLowDiskSpaceWarning({
    targetPath: pkgRoot ? path.dirname(pkgRoot) : params.root,
    purpose: "global package update",
  });
  if (diskWarning) {
    if (params.jsonMode) {
      defaultRuntime.error(`Warning: ${diskWarning}`);
    } else {
      defaultRuntime.log(theme.warn(diskWarning));
    }
  }

  const packageUpdate = await runGlobalPackageUpdateSteps({
    installTarget,
    installSpec,
    packageName,
    packageRoot: pkgRoot,
    runCommand,
    timeoutMs: params.timeoutMs,
    retentionNodePath:
      retainPreviousPackage && coverage.protection === "transactional-rollback"
        ? coverage.nodePath
        : undefined,
    ...(installEnv === undefined ? {} : { env: installEnv }),
    runStep: (stepParams) =>
      runUpdateStep({
        ...stepParams,
        progress: params.progress,
      }),
    postVerifyStep: async (verifiedPackageRoot) => {
      const entryPath = await resolveGatewayInstallEntrypoint(verifiedPackageRoot);
      if (!entryPath) {
        return null;
      }
      await createUpdateConfigSnapshot();
      const candidateHostVersion = await readPackageVersion(verifiedPackageRoot);
      const doctorResultPath = createUpdatePostInstallDoctorResultPath();
      const doctorPolicy = resolveUpdateDoctorExecutionPolicy({
        targetVersion: candidateHostVersion,
        allowGatewayServiceRepair: params.allowGatewayServiceRepair,
      });
      const doctorArgv = [
        params.nodeRunner ?? resolveNodeRunner(),
        entryPath,
        "doctor",
        "--non-interactive",
        ...(doctorPolicy.fix ? ["--fix"] : []),
      ];
      const doctorProgressInfo = {
        name: `${CLI_NAME} doctor`,
        command: doctorArgv.join(" "),
        index: 0,
        total: 0,
      };
      params.progress?.onStepStart?.(doctorProgressInfo);
      const doctorStep = await runUpdateStep({
        name: `${CLI_NAME} doctor`,
        argv: doctorArgv,
        cwd: verifiedPackageRoot,
        env: {
          ...resolvePostInstallDoctorEnv({
            serviceEnv: params.managedServiceEnv,
            invocationCwd: params.invocationCwd,
          }),
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          [UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV]: "1",
          [UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV]: "1",
          [UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART_ENV]: "1",
          [UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR_ENV]: params.allowGatewayServiceRepair
            ? "1"
            : "0",
          [UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION_ENV]: params.allowGatewayActivation ? "1" : "0",
          ...(doctorPolicy.serviceRepairPolicy
            ? { OPENCLAW_SERVICE_REPAIR_POLICY: doctorPolicy.serviceRepairPolicy }
            : {}),
          [UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]: doctorResultPath,
          ...(candidateHostVersion === null
            ? {}
            : { OPENCLAW_COMPATIBILITY_HOST_VERSION: candidateHostVersion }),
        },
        timeoutMs: params.timeoutMs,
      });
      const doctorResult = await consumeUpdatePostInstallDoctorResult(doctorResultPath);
      const completedDoctorStep = markPackagePostInstallDoctorAdvisory(doctorStep, doctorResult);
      params.progress?.onStepComplete?.({
        ...doctorProgressInfo,
        durationMs: completedDoctorStep.durationMs,
        exitCode: completedDoctorStep.exitCode,
        stderrTail: completedDoctorStep.stderrTail,
        signal: completedDoctorStep.signal,
        killed: completedDoctorStep.killed,
        termination: completedDoctorStep.termination,
        advisory: completedDoctorStep.advisory,
      });
      return completedDoctorStep;
    },
    preSwapStep: enableTransactionalRollback
      ? async ({ currentPackageRoot, retainedPackageRoot }) => {
          const steps: PackageUpdateStepResult[] = [];
          const snapshotStartedAt = Date.now();
          try {
            const stateSnapshot = await createUpdateStateSnapshot({
              retainedPackageRoot,
              currentPackageRoot,
              env: rollbackEnv,
              timeoutMs: params.timeoutMs,
              runCommand,
            });
            preparedRollback = {
              packageRoot: currentPackageRoot,
              retainedPackageRoot,
              stateSnapshot,
              recoveryJournalPath: resolveUpdateRecoveryJournalPathFromSnapshot(stateSnapshot.root),
              nodePath:
                coverage.protection === "transactional-rollback"
                  ? coverage.nodePath
                  : (params.nodeRunner ?? resolveNodeRunner()),
              swapped: false,
            };
            await params.onRollbackPrepared?.(preparedRollback, "snapshot");
            steps.push({
              name: "snapshot update state",
              command: `snapshot ${stateSnapshot.stateDir} -> ${stateSnapshot.root}`,
              cwd: path.dirname(stateSnapshot.root),
              durationMs: Date.now() - snapshotStartedAt,
              exitCode: 0,
              stdoutTail: `state snapshot strategy: ${stateSnapshot.strategy}`,
              stderrTail: null,
            });
          } catch (error) {
            const failedStep: PackageUpdateStepResult = {
              name: "snapshot update state",
              command: "snapshot OpenClaw state",
              cwd: path.dirname(retainedPackageRoot),
              durationMs: Date.now() - snapshotStartedAt,
              exitCode: 1,
              stdoutTail: null,
              stderrTail: String(error),
            };
            steps.push(failedStep);
            return { steps, failedStep };
          }

          return { steps, failedStep: null };
        }
      : undefined,
    postLifecyclePreSwapStep: enableTransactionalRollback
      ? async ({ candidatePackageRoot }) => {
          const candidateEntry = await resolveGatewayInstallEntrypoint(candidatePackageRoot);
          const verifyArgv = candidateEntry
            ? [
                coverage.protection === "transactional-rollback"
                  ? coverage.nodePath
                  : resolveNodeRunner(),
                candidateEntry,
                "gateway",
                "verify",
                "--json",
              ]
            : [];
          const verifyStep = candidateEntry
            ? await runUpdateStep({
                name: "gateway startup verify",
                argv: verifyArgv,
                cwd: candidatePackageRoot,
                env: rollbackEnv,
                timeoutMs: params.timeoutMs,
              })
            : {
                name: "gateway startup verify",
                command: `verify ${candidatePackageRoot}`,
                cwd: candidatePackageRoot,
                durationMs: 0,
                exitCode: 1,
                stdoutTail: null,
                stderrTail: "candidate package has no gateway entrypoint",
              };
          const verifyProofError =
            verifyStep.exitCode === 0
              ? validateGatewayStartupVerifyProof(verifyStep.stdoutTail)
              : null;
          const completedVerifyStep = verifyProofError
            ? { ...verifyStep, exitCode: 1, stderrTail: verifyProofError }
            : verifyStep;
          if (completedVerifyStep.exitCode !== 0) {
            return { steps: [completedVerifyStep], failedStep: completedVerifyStep };
          }
          return { steps: [completedVerifyStep], failedStep: null };
        }
      : undefined,
    afterSwap: async ({ packageRoot }) => {
      if (preparedRollback) {
        preparedRollback.packageRoot = packageRoot;
        preparedRollback.swapped = true;
        await params.onRollbackPrepared?.(preparedRollback, "swap");
      }
    },
  });

  return {
    result: {
      status: packageUpdate.failedStep ? "error" : "ok",
      mode: installTarget.manager,
      root: packageUpdate.verifiedPackageRoot ?? params.root,
      reason: packageUpdate.failedStep ? packageUpdate.failedStep.name : undefined,
      before: { version: beforeVersion },
      after: { version: packageUpdate.afterVersion ?? beforeVersion },
      steps: packageUpdate.steps,
      durationMs: Date.now() - params.startedAt,
    },
    rollback: preparedRollback,
  };
}
