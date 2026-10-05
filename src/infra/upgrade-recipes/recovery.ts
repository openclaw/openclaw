import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { UPDATE_RUN_PHASES } from "../../../packages/gateway-protocol/src/update-run-vocabulary.js";
import type { ManagedUpdateLeaseAuthority } from "../../cli/update-cli/update-command-executor-state.js";
import {
  captureUpdateCommandExecutorAuthority,
  withUpdateCommandExecutor,
} from "../../cli/update-cli/update-command-executor.js";
import type { UpdateRecoveryFence } from "../update-run-recovery.js";
import { upgradeRecipeMaintenanceReceiptSchema } from "./maintenance-contract.js";
import {
  parseUpgradeRecipeStepBinding,
  upgradeRecipeStepReceiptSchema,
} from "./receipts-contract.js";
import {
  retainedUpgradeRecipeRunSchema,
  originalRunSchema,
  type RetainedUpgradeRecipeRun,
  type OriginalUpgradeRecipeRun,
  type UpgradeRecipeRecoveryPorts,
} from "./recovery-contract.js";
export {
  retainedUpgradeRecipeRunSchema,
  type RetainedUpgradeRecipeRun,
} from "./recovery-contract.js";

export type UpgradeRecipeRecoverySelection = {
  phase:
    | "resume-preparation"
    | "reconcile-pre-admission"
    | "reconcile-post-admission"
    | "verify-committed-current-state";
  /** False unconditionally: coordinated compensation is a separate existing owner operation. */
  automaticSnapshotRestoreAllowed: false;
  externalWorkPossible: boolean;
  pendingStepIds: string[];
};
export type { UpgradeRecipeRecoveryPorts } from "./recovery-contract.js";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function requireBinding(retained: RetainedUpgradeRecipeRun): void {
  if (retained.binding.installationKey !== retained.nativeAuthority.installKey) {
    throw new Error("Recovery installation differs from its original native authority.");
  }
  const runnerRelative = path.relative(retained.binding.installationKey, retained.runner.root);
  if (
    runnerRelative === "" ||
    (!path.isAbsolute(runnerRelative) &&
      runnerRelative !== ".." &&
      !runnerRelative.startsWith(`..${path.sep}`))
  ) {
    throw new Error("Recovery runner must survive outside the installation being replaced.");
  }
  const ids = new Set<string>();
  for (const step of retained.stepBindings) {
    if (
      step.runId !== retained.binding.runId ||
      step.planDigest !== retained.binding.planDigest ||
      ids.has(step.stepId)
    ) {
      throw new Error("Recovery step has a different run/plan or duplicate identity.");
    }
    ids.add(step.stepId);
  }
}

function selectRecoveryPhase(
  retained: RetainedUpgradeRecipeRun,
  run: OriginalUpgradeRecipeRun,
  raw: Awaited<ReturnType<UpgradeRecipeRecoveryPorts["readReceipts"]>>,
): UpgradeRecipeRecoverySelection {
  const maintenance =
    raw.maintenance === null ? null : upgradeRecipeMaintenanceReceiptSchema.parse(raw.maintenance);
  if (maintenance && !isDeepStrictEqual(maintenance.binding, retained.binding)) {
    throw new Error("Recovery maintenance belongs to another run, plan, target, or state family.");
  }
  const seen = new Set<string>();
  const pendingStepIds: string[] = [];
  for (const value of raw.steps) {
    const receipt = upgradeRecipeStepReceiptSchema.parse(value);
    const expected = retained.stepBindings.find((step) => step.stepId === receipt.binding.stepId);
    if (
      !expected ||
      seen.has(receipt.binding.stepId) ||
      !isDeepStrictEqual(
        parseUpgradeRecipeStepBinding(receipt.binding),
        parseUpgradeRecipeStepBinding(expected),
      )
    ) {
      throw new Error("Recovery step receipt differs from the exact retained run/plan/resources.");
    }
    seen.add(receipt.binding.stepId);
    if (receipt.phase !== "verified") {
      pendingStepIds.push(receipt.binding.stepId);
    }
    if (!maintenance && receipt.binding.phase !== "prepare") {
      throw new Error(
        "A mutating recipe intent has lost its original maintenance owner; preserve current state.",
      );
    }
  }
  if (!maintenance && ["activating", "restarting", "verifying", "finished"].includes(run.phase)) {
    throw new Error(
      "Activation occurred without retained maintenance evidence; external work may be possible.",
    );
  }
  return {
    phase:
      maintenance?.phase === "committed"
        ? "verify-committed-current-state"
        : maintenance?.phase === "commit-intent"
          ? "reconcile-post-admission"
          : maintenance || pendingStepIds.length > 0
            ? "reconcile-pre-admission"
            : "resume-preparation",
    automaticSnapshotRestoreAllowed: false,
    externalWorkPossible:
      maintenance?.phase === "commit-intent" || maintenance?.phase === "committed",
    pendingStepIds: pendingStepIds.toSorted(),
  };
}

/** Resume exactly one retained run inside native custody; returned receipts never authorize effects. */
export async function resumeUpgradeRecipeOriginalRun<T>(options: {
  runId: string;
  ports: UpgradeRecipeRecoveryPorts;
  /** Live delegated target custody only; never serialize or derive this fence from receipts. */
  admittedFence?: UpdateRecoveryFence;
  continueRun: (input: {
    retained: RetainedUpgradeRecipeRun;
    selection: UpgradeRecipeRecoverySelection;
    fence: UpdateRecoveryFence;
  }) => Promise<T>;
}): Promise<T> {
  const runId = z.uuid().parse(options.runId);
  const original = originalRunSchema.parse(await options.ports.readOriginalRun(runId));
  if (original.runId !== runId || original.status !== "running") {
    throw new Error(
      "Recovery requires the exact original running update; it cannot create or reopen a run.",
    );
  }
  const bytes = await options.ports.readRetainedEnvelope(runId);
  if (bytes.byteLength > 1024 * 1024 || sha256(bytes) !== original.retainedEvidenceSha256) {
    throw new Error("Retained recovery evidence differs from the original durable reference.");
  }
  const retained = retainedUpgradeRecipeRunSchema.parse(
    JSON.parse(Buffer.from(bytes).toString("utf8")),
  );
  if (retained.binding.runId !== runId) {
    throw new Error("Retained recovery evidence selects another update run.");
  }
  requireBinding(retained);
  const verify = async (fence?: UpdateRecoveryFence) => {
    for (const item of [
      retained.planArtifact,
      retained.configArtifact,
      retained.authorizationArtifact,
    ]) {
      if (item.length > 16 * 1024 * 1024) {
        throw new Error("Retained recovery artifact exceeds its private evidence bound.");
      }
    }
    const read = async (item: RetainedUpgradeRecipeRun["planArtifact"]) => {
      const artifactBytes = await options.ports.readArtifact(structuredClone(item));
      fence?.assertCurrent();
      if (artifactBytes.byteLength !== item.length || sha256(artifactBytes) !== item.sha256) {
        throw new Error("Retained plan, config, or authorization artifact identity changed.");
      }
      return Buffer.from(artifactBytes);
    };
    const [plan, config, authorization] = await Promise.allSettled([
      read(retained.planArtifact),
      read(retained.configArtifact),
      read(retained.authorizationArtifact),
    ]);
    if (
      plan.status !== "fulfilled" ||
      config.status !== "fulfilled" ||
      authorization.status !== "fulfilled"
    ) {
      throw new AggregateError(
        [plan, config, authorization].flatMap((item) =>
          item.status === "rejected" ? [item.reason] : [],
        ),
        "Retained recovery artifact verification failed.",
      );
    }
    // These verifier ports are the existing trust owners. This coordinator cannot manufacture admission.
    await options.ports.verifyRetainedAuthorization(structuredClone(retained), authorization.value);
    fence?.assertCurrent();
    await options.ports.verifyRetainedPlanAndConfig(
      structuredClone(retained),
      plan.value,
      config.value,
    );
    fence?.assertCurrent();
    const runner = await options.ports.verifyRetainedRunner(structuredClone(retained));
    fence?.assertCurrent();
    const actualRunner = {
      root: runner.root,
      manifestDigest: runner.manifestDigest,
      closureDigest: runner.closureDigest,
      runtimePath: runner.runtimePath,
      entrypointPath: runner.entrypointPath,
    };
    if (!isDeepStrictEqual(actualRunner, retained.runner)) {
      throw new Error("Retained runner closure/runtime identity changed.");
    }
    await options.ports.assertOriginalRecoveryOwner(structuredClone(retained));
    fence?.assertCurrent();
  };
  await verify();
  // Preflight reads explain/refuse only. Native admission independently refuses a still-live owner.
  const beforeReceipts = structuredClone(
    await options.ports.readReceipts(structuredClone(retained)),
  );
  const beforeSelection = selectRecoveryPhase(retained, original, beforeReceipts);
  const continueAdmitted = async (fence: UpdateRecoveryFence) => {
    fence.assertCurrent();
    const currentAuthority = captureUpdateCommandExecutorAuthority(fence, runId);
    const { owner: _owner, ...identity } = currentAuthority;
    if (
      currentAuthority.owner !== retained.originalNativeOwner ||
      !isDeepStrictEqual(identity, retained.nativeAuthority)
    ) {
      throw new Error("Native recovery authority differs from its original pinned control store.");
    }
    const current = originalRunSchema.parse(await options.ports.readOriginalRun(runId));
    fence.assertCurrent();
    if (
      current.runId !== runId ||
      current.status !== "running" ||
      UPDATE_RUN_PHASES.indexOf(current.phase) < UPDATE_RUN_PHASES.indexOf(original.phase) ||
      current.retainedEvidenceSha256 !== original.retainedEvidenceSha256
    ) {
      throw new Error("Original recovery run changed during native admission.");
    }
    await verify(fence);
    const receipts = await options.ports.readReceipts(structuredClone(retained));
    fence.assertCurrent();
    const selection = selectRecoveryPhase(retained, current, receipts);
    if (
      (beforeSelection.externalWorkPossible && !selection.externalWorkPossible) ||
      (beforeReceipts.maintenance &&
        (!receipts.maintenance ||
          receipts.maintenance.revision < beforeReceipts.maintenance.revision)) ||
      (beforeSelection.phase === "verify-committed-current-state" &&
        selection.phase !== beforeSelection.phase) ||
      beforeReceipts.steps.some((previous) => {
        const observed = receipts.steps.find(
          (item) => item.binding.stepId === previous.binding.stepId,
        );
        return (
          !observed ||
          observed.revision < previous.revision ||
          (previous.phase === "verified" && observed.phase !== "verified")
        );
      })
    ) {
      throw new Error(
        "Retained recovery receipts regressed or disappeared during admission; never replay or rewind.",
      );
    }
    const result = await options.continueRun({
      retained: structuredClone(retained),
      selection,
      fence,
    });
    fence.assertCurrent();
    return result;
  };
  if (options.admittedFence) {
    return await continueAdmitted(options.admittedFence);
  }
  return await withUpdateCommandExecutor(
    runId,
    async (executor) => continueAdmitted(await executor.enter(retained.nativeAuthority.installKey)),
    {
      existingAuthority: retained.nativeAuthority satisfies Omit<
        ManagedUpdateLeaseAuthority,
        "owner"
      >,
      originalRecipeOwner: { runId, owner: retained.originalNativeOwner },
    },
  );
}
