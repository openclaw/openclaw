import os from "node:os";
import path from "node:path";
import { tryReadJson } from "../../infra/json-files.js";
import {
  runUpdateCandidateAdmission,
  type UpdateCandidateAdmissionResult,
} from "../../infra/update-candidate-admission.js";
import { canResolveRegistryVersionForPackageTarget } from "../../infra/update-global.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import { recordUpdateRunPhase, recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { defaultRuntime } from "../../runtime.js";
import { parsePackageOpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { VERSION } from "../../version.js";
import type { createUpdateProgress } from "./progress.js";
import {
  readPackageVersion,
  resolveNodeRunner,
  UpdatePreMutationError,
  usesCandidateUpdateAdmission,
  type UpdateCommandOptions,
} from "./shared.js";
import { withPrivateStagedPackageInstall } from "./update-command-artifact.js";
import { inspectUpdateManagedServices } from "./update-command-database-context.js";
import { handoffUpdateFromGateway } from "./update-command-handoff.js";
import type { StagedPackageInstallUpdate } from "./update-command-package.js";
import type { UpdateAdmissionReportParams } from "./update-command-result.js";
import type { prepareUpdateCommand } from "./update-command-run.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";
import type { resolveUpdateCommandTarget } from "./update-command-target.js";
import { reportPreMutationUpdateResult } from "./update-command-terminal.js";
import { UpdateCommandAbort } from "./update-command-windows-task.js";

type Target = NonNullable<Awaited<ReturnType<typeof resolveUpdateCommandTarget>>>;
type CandidateAdmissionParams = {
  target: Target;
  prepared: Awaited<ReturnType<typeof prepareUpdateCommand>>;
  opts: UpdateCommandOptions;
  timeoutMs: number;
  invocationCwd?: string;
  presentation: ReturnType<typeof createUpdateProgress>;
};

export function createUpdateCandidateAdmissionReport(
  { target, opts, prepared }: Pick<CandidateAdmissionParams, "target" | "opts" | "prepared">,
  error: UpdatePreMutationError,
): UpdateAdmissionReportParams {
  return {
    root: target.root,
    mode: target.mode,
    installKind: target.updateInstallKind,
    opts,
    controlPlaneUpdateSentinelMeta: prepared.controlPlaneUpdateSentinelMeta,
    reason: error.reason,
    message: error.message,
    nextAction: error.nextAction,
    failureFacts: error.failureFacts,
    stepResult: error.stepResult,
    recoverySteps: error.recoverySteps,
  };
}

/** Inspect before lifecycle scripts, including when fresh state cannot yet host update history. */
export async function inspectStagedUpdateCandidateAdmission(
  params: CandidateAdmissionParams & {
    candidateRoot: string;
    runId: string;
    env?: NodeJS.ProcessEnv;
    assertCurrent?: () => void;
  },
): Promise<UpdateCandidateAdmissionResult> {
  return await withOwnedManagedUpdateEnv(params.env, async () => {
    const { target, opts, prepared } = params;
    const installTarget = target.packageInstallTarget;
    if (!installTarget) {
      throw new Error("Candidate admission requires the resolved package installation.");
    }
    // The child cannot attest the installed supervisor's ancestry or handoff exception.
    await inspectUpdateManagedServices({
      ...target,
      roots: [target.root],
      updateInstallKind: "package",
      shouldRestart: prepared.shouldRestart,
      jsonMode: Boolean(opts.json),
      timeoutMs: params.timeoutMs,
      invocationCwd: params.invocationCwd,
      expectedForeground:
        opts.run?.completionOwner === "gateway-restart" ||
        prepared.controlPlaneUpdateSentinelMeta?.completionOwner === "gateway-restart" ||
        undefined,
      handoffFromGateway: (state) =>
        handoffUpdateFromGateway({
          state,
          root: target.root,
          opts,
          tag:
            target.channel === "extended-stable"
              ? undefined
              : (target.packageInstallSpec ?? target.tag),
          mode: target.mode,
          timeoutMs: params.timeoutMs,
          nodeRunner: target.packageUpdateNodeRunner,
          invocationCwd: params.invocationCwd,
          stopProgress: params.presentation.stop,
        }),
    });
    params.assertCurrent?.();
    const nodeRunner = target.packageUpdateNodeRunner ?? resolveNodeRunner();
    const candidateVersion = await readPackageVersion(params.candidateRoot);
    const result = await runUpdateCandidateAdmission({
      candidateRoot: params.candidateRoot,
      nodeRunner,
      env: process.env,
      timeoutMs: prepared.timeoutMs,
      admission: opts.admission,
      context: {
        protocol: 1,
        installation: {
          root: target.root,
          canonicalRoot: resolveUpdateInstallRoot(target.root),
          version: target.currentVersion,
          installKind: prepared.installKind,
          packageManager: installTarget.manager,
          ...(installTarget.globalRoot ? { globalRoot: installTarget.globalRoot } : {}),
        },
        target: {
          spec: target.packageInstallSpec ?? target.tag,
          version: candidateVersion ?? target.targetVersion,
          source: canResolveRegistryVersionForPackageTarget(target.packageInstallSpec ?? target.tag)
            ? "registry"
            : "artifact",
          channel: target.channel,
          tag: target.tag,
        },
        request: {
          yes: Boolean(opts.yes),
          noRestart: !prepared.shouldRestart,
          acceptCapabilities: Boolean(opts.acceptCapabilities),
          json: Boolean(opts.json),
          timeoutMs: prepared.timeoutMs,
          requestedChannel: prepared.requestedChannel,
        },
        run: { id: params.runId },
        supervisor: { version: VERSION, host: os.hostname(), pid: process.pid },
      },
    });
    params.assertCurrent?.();
    if (result.verdict?.verdict === "admit") {
      target.packageUpdateNodeRunner = nodeRunner;
      target.packageTargetSchemaVersions = parsePackageOpenClawSchemaVersions(
        await tryReadJson<unknown>(path.join(params.candidateRoot, "package.json")),
      );
      target.targetVersion ??= candidateVersion;
    }
    return result;
  });
}

/** Publish a buffered decision only after the installed process admits its history owner. */
export function applyUpdateCandidateAdmission(params: {
  target: Target;
  opts: UpdateCommandOptions;
  result: UpdateCandidateAdmissionResult;
}): void {
  const { result, opts, target } = params;
  const run = opts.run;
  const verdict = result.verdict;
  if (run) {
    recordUpdateRunPhase(
      run.runId,
      "staging",
      {
        origin: {
          admission: {
            owner: result.owner,
            ...(verdict
              ? {
                  protocol: verdict.protocol,
                  candidateVersion: verdict.facts.candidateVersion,
                  checks: verdict.facts.checks,
                }
              : {}),
            ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
          },
          ...(verdict ? { candidateAdmission: verdict } : {}),
        },
        ...(verdict
          ? {
              step: {
                step: "candidate-admission",
                status: verdict.verdict === "admit" ? "completed" : "failed",
                detail: JSON.stringify(verdict.facts.checks),
                endedAtMs: Date.now(),
              },
            }
          : {}),
      },
      { env: run.env },
    );
    for (const warning of [
      ...(result.warning ? [result.warning] : []),
      ...(verdict?.warnings ?? []),
    ]) {
      recordUpdateRunStep(
        run.runId,
        { step: `warning:${warning.code}`, status: "completed", detail: warning.message },
        { env: run.env },
      );
      defaultRuntime.error(`Warning: ${warning.message}`);
    }
    if (verdict?.verdict === "admit") {
      run.candidateAdmissionChecks = verdict.facts.checks.map((check) => check.name);
    }
  }
  if (verdict?.verdict === "refuse") {
    const reason = verdict.reasons[0]!;
    throw new UpdatePreMutationError(reason.code, reason.message, {
      origin: "candidate-admission",
      nextAction: reason.nextAction,
      failureFacts: verdict.reasons.map((entry) => ({
        check: "candidate-admission",
        code: entry.code,
        message: entry.message,
      })),
    });
  }
  if (!verdict?.facts.checks.some((check) => check.name === "config") && target.configReadFailure) {
    throw target.configReadFailure;
  }
}

/** Stage once; the installed process retains service and execution authority. */
export async function withUpdateCandidateAdmission<T>(
  params: CandidateAdmissionParams & {
    stagedPackage?: StagedPackageInstallUpdate;
    candidateAdmission?: Awaited<ReturnType<typeof inspectStagedUpdateCandidateAdmission>>;
  },
  execute: (stagedPackage?: StagedPackageInstallUpdate) => Promise<T>,
): Promise<T | void> {
  const { target, opts, prepared } = params;
  const run = opts.run!;
  try {
    const inspect = async (stage: StagedPackageInstallUpdate): Promise<T> => {
      const result = await inspectStagedUpdateCandidateAdmission({
        ...params,
        candidateRoot: stage.root,
        runId: run.runId,
        assertCurrent: () => run.executorFence?.assertCurrent(),
      });
      applyUpdateCandidateAdmission({ target, opts, result });
      return await execute(stage);
    };
    if (params.candidateAdmission) {
      // A command keeps its admitted candidate; concurrent config edits are best effort.
      applyUpdateCandidateAdmission({ target, opts, result: params.candidateAdmission });
      return await execute(params.stagedPackage);
    }
    if (
      target.packageAlreadyCurrent ||
      !usesCandidateUpdateAdmission(opts, prepared.installKind) ||
      target.updateInstallKind !== "package"
    ) {
      applyUpdateCandidateAdmission({
        target,
        opts,
        result: {
          owner: "installed",
          ...(opts.admission === "installed" ? { fallbackReason: "forced-installed" } : {}),
        },
      });
      return await execute(params.stagedPackage);
    }
    if (params.stagedPackage) {
      return await inspect(params.stagedPackage);
    }
    return await withPrivateStagedPackageInstall(
      {
        root: target.root,
        installKind: prepared.installKind,
        tag: target.tag,
        installSpec: target.packageInstallSpec ?? undefined,
        timeoutMs: params.timeoutMs,
        workTimeoutMs: prepared.timeoutMs ?? null,
        startedAt: prepared.startedAt,
        progress: params.presentation.progress,
        invocationCwd: params.invocationCwd,
        nodeRunner: target.packageUpdateNodeRunner,
        installEnv: target.packageInstallEnv,
        installTarget: target.packageInstallTarget,
        pauseBeforeVerification: true,
        assertCurrent: () => run.executorFence?.assertCurrent(),
      },
      ({ stage }) => inspect(stage),
    );
  } catch (error) {
    if (error instanceof UpdateCommandAbort && !hasCommandProcessCleanupError(error)) {
      return;
    }
    if (!(error instanceof UpdatePreMutationError)) {
      throw error;
    }
    return await reportPreMutationUpdateResult(createUpdateCandidateAdmissionReport(params, error));
  }
}
