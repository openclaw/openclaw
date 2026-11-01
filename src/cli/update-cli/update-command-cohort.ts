import { isDeepStrictEqual } from "node:util";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { z } from "zod";
import { ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV } from "../../config/future-version-guard.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-swap-contract.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import type { PluginCohortRecoveryPair } from "../../infra/update-plugin-cohort-schema.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import { assertUpdateRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import type { PluginCohortRecoveryContinuation } from "../../infra/update-run-recovery-types.js";
import { pluginCohortRecoveryMatchesSource } from "../../infra/update-run-recovery.js";
import { isUpdateGatewayReadinessPending } from "../../infra/update-run-step.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import {
  beginUpdatePluginCohort,
  settleUpdatePluginCohort,
} from "../../plugins/update-cohort-recovery.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { resolveNodeRunner, type UpdateCommandOptions } from "./shared.js";
import {
  readUpdateConfigSnapshot,
  type UpdateConfigSnapshot,
} from "./update-command-config-snapshot.js";
import { captureUpdateDatabases } from "./update-command-database-backup.js";
import type { MutableUpdateExecutionParams } from "./update-command-execution.types.js";
import {
  captureUpdateCommandExecutorAuthority,
  requiresRetainedUpdateCommandOwner,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import type { OwnedManagedUpdateContext } from "./update-command-managed-context.js";
import type { UpdatePluginCohortSettlementInput } from "./update-command-migrated-types.js";
import { readPackageUpdateIdentity } from "./update-command-package-identity.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import { withUpdateStateRead } from "./update-command-result.js";
import {
  resolveUpdatedInstallCommandEnv,
  stripGatewayServiceMarkerEnv,
} from "./update-command-service-env.js";

const resultSchema = z.strictObject({
  runId: z.uuid(),
  transactionId: z.uuid(),
  configPaths: z.array(z.string()).max(4096),
});

/** Retain the observed core identities and capture data before plugin reservation. */
export async function createUpdateCommandRollbackCapture(
  execution: MutableUpdateExecutionParams,
  run: UpdateCommandOptions["run"],
  assertCurrent: () => void,
) {
  const previous = await readPackageUpdateIdentity(execution.root);
  assertCurrent();
  let candidate: Awaited<ReturnType<typeof readPackageUpdateIdentity>> | undefined;
  let targetVersion = execution.packageTargetVersion;
  return {
    selectTargetVersion(version: string | undefined) {
      targetVersion = version;
    },
    async observeCandidate(root: string) {
      candidate = await readPackageUpdateIdentity(root);
      assertCurrent();
    },
    async capture(
      transaction: PackageUpdateTransaction,
      context: OwnedManagedUpdateContext | undefined,
    ) {
      if (!run) {
        return undefined;
      }
      const capture = await captureUpdateDatabases({
        transaction,
        execution,
        context,
        assertCurrent,
      });
      const fence = run.executorFence;
      const version = candidate?.version ?? targetVersion;
      if (!fence || !previous.version || !version) {
        throw new Error("Plugin cohort rollback requires the admitted core runtime identities.");
      }
      const authority = captureUpdateCommandExecutorAuthority(fence, run.runId);
      const runtime = {
        root: execution.root,
        nodePath:
          execution.packageActivationRuntime?.path ??
          execution.packageUpdateNodeRunner ??
          process.execPath,
      };
      await beginUpdatePluginCohort({
        runId: run.runId,
        env: context?.env ?? run.env,
        fence,
        installKey: authority.installKey,
        from: { ...runtime, version: previous.version, buildId: previous.buildId ?? null },
        to: { ...runtime, version, buildId: candidate?.buildId ?? null },
      });
      assertCurrent();
      return capture;
    },
  };
}

/** Foreground handoffs retain their cohort until the successor verifies activation. */
export async function commitVerifiedUpdatePluginCohort(
  params: Pick<FinishUpdateParams, "opts" | "ownedManagedUpdateEnv">,
  result: UpdateRunResult,
  activationVerified: boolean,
  assertCurrent: () => void,
): Promise<void> {
  const run = params.opts.run;
  if (
    result.status === "ok" &&
    !isUpdateGatewayReadinessPending(result) &&
    (activationVerified || run?.gatewayRestartRequired !== true) &&
    run?.executorFence
  ) {
    await settleUpdatePluginCohort({
      runId: run.runId,
      env: params.ownedManagedUpdateEnv ?? run.env,
      fence: run.executorFence,
      action: "commit",
    });
    assertCurrent();
  }
}

/** A reporting continuation belongs only to the invocation's original live run. */
export function assertUpdatePluginCohortReportingContinuation(
  opts: Pick<UpdateCommandOptions, "run" | "recovery">,
  continuation: PluginCohortRecoveryContinuation | undefined,
): void {
  const run = opts.run;
  if (
    continuation &&
    (!run ||
      run.runId !== continuation.runId ||
      run.executorFence !== continuation.fence ||
      opts.recovery)
  ) {
    throw new Error("Update reporting lost its original live plugin cohort executor");
  }
}

/** Keep reporting's selected state source bound across asynchronous recovery admission. */
export async function assertUpdatePluginCohortReportingAdmission(
  params: Pick<FinishUpdateParams, "opts" | "ownedManagedUpdateEnv">,
  pluginCohort: PluginCohortRecoveryContinuation | undefined,
  settlementFailed: boolean,
): Promise<void> {
  const env = params.ownedManagedUpdateEnv ?? params.opts.run?.env;
  // Keep the first target stable if selectors change during admission.
  const targetPath = resolveOpenClawStateSqlitePath(env);
  await withUpdateStateRead(
    async () => {
      await assertUpdateRecoveryAdmission({ env, path: targetPath, pluginCohort });
      if (params.opts.run) {
        if (resolveOpenClawStateSqlitePath(params.opts.run.env) !== targetPath) {
          await assertUpdateRecoveryAdmission({ env: params.opts.run.env, pluginCohort });
        }
        const prior = getUpdateRun(params.opts.run.runId, { env: params.opts.run.env });
        if (prior && prior.status !== "running" && settlementFailed) {
          throw new Error("Update history was already finalized by another owner.");
        }
      }
    },
    params.opts.run?.deadline?.remainingMs() ?? params.opts.run?.defaultStepTimeoutMs ?? 0,
  );
}

/** The candidate can preserve later candidate-written config without granting an older writer access. */
export async function settleUpdatePluginCohortInCandidate(params: {
  root: string;
  run: NonNullable<UpdateCommandOptions["run"]>;
  env: NodeJS.ProcessEnv;
  nodeRunner?: string;
  timeoutMs: number;
  expectedPair: PluginCohortRecoveryPair;
  configRestoration: {
    files: readonly UpdateConfigSnapshot[];
    expectedHashes: Map<string, string>;
    assertCurrent: () => void;
  };
}): Promise<{ configPaths: string[] }> {
  const { run, expectedPair, root } = params;
  const runId = run.runId;
  const transactionId = expectedPair.cohort.transactionId;
  const fence = run.executorFence;
  if (!fence || runId !== expectedPair.cohort.runId) {
    throw new UpdateCommandRecoveryPendingError(
      "Plugin cohort rollback requires its original executor.",
    );
  }
  const candidateRoot = resolveUpdateInstallRoot(root);
  const deadlineAt = performance.now() + params.timeoutMs;
  const remaining = () => {
    const milliseconds = Math.ceil(deadlineAt - performance.now());
    if (milliseconds <= 0) {
      throw new UpdateCommandRecoveryPendingError(
        "Candidate plugin cohort rollback timed out; package rollback remains pending.",
      );
    }
    return milliseconds;
  };
  const expectedPaths = expectedPair.cohort.publications.flatMap((publication) =>
    publication.kind === "config" ? [publication.file.filePath] : [],
  );
  const assertCurrent = () => {
    if (
      params.run !== run ||
      run.runId !== runId ||
      run.executorFence !== fence ||
      resolveUpdateInstallRoot(root) !== candidateRoot ||
      captureUpdateCommandExecutorAuthority(fence, runId).installKey !==
        expectedPair.cohort.installKey ||
      !pluginCohortRecoveryMatchesSource(expectedPair, { env: params.env })
    ) {
      throw new UpdateCommandRecoveryPendingError(
        "Plugin cohort rollback lost its original installation or source.",
      );
    }
  };
  assertCurrent();
  const nodeRunner = params.nodeRunner ?? resolveNodeRunner();
  const worker = [
    nodeRunner,
    ...resolveRuntimeWorkerArgv(
      resolveRuntimeWorkerUrl({ ...runtimeProcessEntrypoints.updateMigratedFinalize, root }),
      nodeRunner,
    ),
  ];
  const env: NodeJS.ProcessEnv = {
    ...stripGatewayServiceMarkerEnv(resolveUpdatedInstallCommandEnv({ processEnv: params.env })),
    OPENCLAW_UPDATE_IN_PROGRESS: "1",
    [UPDATE_RUN_ID_ENV]: runId,
  };
  // The candidate uses its own version checks, never an allowance retained by an old stop owner.
  delete env[ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV];
  const options = {
    cwd: root,
    baseEnv: {},
    env,
    killProcessTree: true,
    requireProcessTreeExtinction: true,
    terminateOnOutputLimit: true,
    onOutputChunk(chunk: Buffer, stream: "stdout" | "stderr") {
      if (stream === "stderr") {
        process.stderr.write(chunk);
      }
    },
  };
  const requiresRetainedOwner = requiresRetainedUpdateCommandOwner(fence);
  const check = await runUtf8CommandWithTimeout([...worker, "--check"], {
    ...options,
    timeoutMs: remaining(),
    maxOutputBytes: 64 * 1024,
  });
  assertCurrent();
  const contract = safeParseJsonRecord(check.stdout);
  if (
    check.code !== 0 ||
    check.termination !== "exit" ||
    check.cleanup !== "normal" ||
    check.outputLimitExceeded ||
    check.outputErrorStream ||
    contract?.executorDelegation !== "pid-start-v1" ||
    contract.pluginCohortSettlement !== true ||
    (requiresRetainedOwner && contract.retainedOwnerBinding !== true)
  ) {
    throw new UpdateCommandRecoveryPendingError(
      "Candidate runtime cannot settle plugin cohort rollback; package rollback remains pending.",
    );
  }
  const child = await withUpdateCommandExecutorChild(fence, root, async (executor, bindChild) => {
    const input: UpdatePluginCohortSettlementInput = { executor, runId, transactionId };
    const result = await runUtf8CommandWithTimeout([...worker, "--settle-plugin-cohort"], {
      ...options,
      timeoutMs: remaining(),
      input: JSON.stringify(input),
      beforeInput: bindChild,
      maxOutputBytes: { stdout: 1024 * 1024, stderr: 64 * 1024 },
    });
    if (result.cleanup === "forced" || result.cleanup === "uncertain") {
      throw new CommandProcessCleanupError();
    }
    return result;
  });
  assertCurrent();
  if (
    child.code !== 0 ||
    child.termination !== "exit" ||
    child.cleanup !== "normal" ||
    child.outputLimitExceeded ||
    child.outputErrorStream
  ) {
    throw new UpdateCommandRecoveryPendingError(
      "Candidate did not confirm plugin cohort rollback; package rollback remains pending.",
    );
  }
  let result: z.infer<typeof resultSchema>;
  try {
    result = resultSchema.parse(JSON.parse(child.stdout));
  } catch (cause) {
    throw new UpdateCommandRecoveryPendingError(
      "Candidate plugin cohort rollback result is invalid; package rollback remains pending.",
      { cause },
    );
  }
  if (
    result.runId !== runId ||
    result.transactionId !== transactionId ||
    !isDeepStrictEqual(result.configPaths, expectedPaths)
  ) {
    throw new UpdateCommandRecoveryPendingError(
      "Candidate plugin cohort rollback result does not match its retained intent.",
    );
  }
  const restoration = params.configRestoration;
  restoration.assertCurrent();
  for (const file of restoration.files) {
    if (expectedPaths.includes(file.path)) {
      restoration.expectedHashes.set(file.path, (await readUpdateConfigSnapshot(file.path)).hash);
      restoration.assertCurrent();
    }
  }
  return { configPaths: result.configPaths };
}
