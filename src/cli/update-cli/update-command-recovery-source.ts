import { lstat } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readPackageReverseImage } from "../../infra/package-update-activation-reverse-files.js";
import type {
  PackageActivationReverseImage,
  PackageActivationReversePreparation,
} from "../../infra/package-update-activation-reverse-schema.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-swap-contract.js";
import type { UpdateRecoveryBackupRef } from "../../infra/update-recovery-backup-contract.js";
import { prepareVerifiedBackup } from "../../infra/update-recovery-backup-verify.js";
import { preserveUpdateRecoveryCandidateWithSource } from "../../infra/update-recovery-candidate.js";
import { prepareUpdateRecoveryGeneration } from "../../infra/update-recovery-preparation.js";
import type { UpdateRecoverySourceImage } from "../../infra/update-recovery-source-image.js";
import {
  bindUpdateRecoverySourceAssertions,
  capturedUpdateRecoverySource,
  type UpdateRecoverySourceAttestationRef,
} from "../../infra/update-recovery-source-publication.js";
import { admitSelectedRuntimeUpdateRecoveryPublication } from "../../infra/update-recovery-startup-admission.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { mutateRun } from "../../infra/update-run-write.js";
import {
  captureOpenClawDatabaseMaintenanceAdmission,
  getOpenClawDatabaseMaintenanceScope,
  type OpenClawDatabaseMaintenanceScope,
} from "../../state/openclaw-state-db-async-lifecycle.js";
import type { UpdateCommandOptions } from "./shared.js";
import {
  captureUpdateCommandExecutorCurrentStores,
  captureUpdateCommandRecoveryGenerationAuthority,
} from "./update-command-executor.js";
import { persistOriginalUpdateConfigWrites } from "./update-command-recovery-config.js";
import { withUpdateRecoverySourceCustody } from "./update-command-recovery-custody.js";
import type { UpdateCommandRecoveryGenerationInput } from "./update-command-recovery-generation.js";

/** Original source proof remains live authority; only the ref enters the binding. */
type UpdateCommandCapturedRecoveryGeneration = UpdateCommandRecoveryGenerationInput & {
  binding: UpdateCommandRecoveryGenerationInput["binding"] & {
    sourceAttestation: UpdateRecoverySourceAttestationRef;
  };
};
function contains(root: string, file: string) {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}
function beforeImage(image: UpdateRecoverySourceImage): PackageActivationReverseImage {
  if (image.kind === "missing") {
    return { kind: "missing" };
  }
  const metadata = { identity: image.identity, mode: image.mode, uid: image.uid, gid: image.gid };
  if (image.kind === "file") {
    return { kind: "file", ...metadata, sha256: image.sha256, size: image.size };
  }
  if (image.kind === "symlink") {
    return { kind: "symlink", ...metadata, target: image.target };
  }
  return { kind: "directory", ...metadata };
}

/** Consume the already-held original publication scope. No owner is acquired,
 * restatted, released or replaced here. Caller retains it through durable lower
 * binding/publication, completion verification and next-reader admission. */
async function prepareOriginalUpdateRecoveryGeneration(params: {
  baseline: UpdateRecoveryBackupRef;
  executor: UpdateRecoveryFence;
  runId: string;
  transaction: PackageUpdateTransaction;
  maintenance: OpenClawDatabaseMaintenanceScope;
  assertCallerBindings: () => void;
  assertWritersSettled: () => void;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  initialStores: NonNullable<
    ReturnType<typeof captureUpdateCommandExecutorCurrentStores>
  >["selection"];
}): Promise<UpdateCommandCapturedRecoveryGeneration> {
  const { executor, runId, transaction, maintenance } = params;
  const env = { ...params.env };
  const baseline = structuredClone(params.baseline);
  const assertMaintenance = captureOpenClawDatabaseMaintenanceAdmission(maintenance);
  const assertOriginal = captureUpdateCommandRecoveryGenerationAuthority(executor, runId);
  const assertWritersSettled = params.assertWritersSettled.bind(params);
  const assertCallerBindings = params.assertCallerBindings.bind(params);
  const publication = transaction.reversePublication;
  if (!publication) {
    throw new Error("Original recovery requires its retained package transaction.");
  }
  const selection = publication.selection.bind(publication);
  const resourceCustody = publication.resourceCustody.bind(publication);
  const selected = structuredClone(selection());
  const assertCurrent = bindUpdateRecoverySourceAssertions(
    {
      assertOwned() {
        assertCallerBindings();
        if (
          getOpenClawDatabaseMaintenanceScope() !== maintenance ||
          transaction.reversePublication !== publication ||
          selected.originalRunId !== runId ||
          !isDeepStrictEqual(selected, selection())
        ) {
          throw new Error("Recovery source lost its original publication lifetime.");
        }
      },
    },
    {
      assertCurrent() {
        // Check native custody after the caller-owned selection callback.
        assertMaintenance();
        assertOriginal();
        assertWritersSettled();
      },
    },
  );
  assertCurrent();
  const { candidate, sourceAttestationRef } = await preserveUpdateRecoveryCandidateWithSource(
    baseline,
    { assertOwned: assertCurrent, env },
    { operationId: selected.operationId, assertCurrent },
  );
  const source = capturedUpdateRecoverySource(sourceAttestationRef);
  const prepared = await prepareUpdateRecoveryGeneration(baseline, candidate, {
    assertOwned: assertCurrent,
    env,
  });
  const verified = await prepareVerifiedBackup(prepared, { env });
  try {
    const custody = await resourceCustody({ assertCurrent, assertWritersSettled });
    const admitted = await admitSelectedRuntimeUpdateRecoveryPublication(
      { baseline, candidate, prepared },
      { assertOwned: assertCurrent },
      {
        selection,
        timeoutMs: params.timeoutMs,
      },
    );
    const resources: PackageActivationReversePreparation["state"] = [];
    const images = new Map(source.inventory.resources.map((r) => [r.sourcePath, r]));
    if (images.size !== verified.manifest.entries.length) {
      throw new Error("Prepared source inventory changed.");
    }
    for (const [index, entry] of verified.manifest.entries.entries()) {
      assertCurrent();
      const captured = images.get(entry.sourcePath);
      if (
        !captured ||
        (captured.ancestor.path !== path.dirname(entry.sourcePath) &&
          !(captured.image.kind === "missing" && entry.kind === "missing"))
      ) {
        throw new Error("Recovery resource lacks its original publication parent.");
      }
      const before = beforeImage(captured.image);
      if (!isDeepStrictEqual(await readPackageReverseImage(entry.sourcePath), before)) {
        throw new Error("Recovery live preimage changed after stopped-C capture.");
      }
      const unchanged =
        entry.kind === before.kind &&
        ((entry.kind === "missing" && before.kind === "missing") ||
          (entry.kind === "directory" &&
            before.kind === "directory" &&
            entry.mode === before.mode) ||
          (entry.kind === "symlink" &&
            before.kind === "symlink" &&
            entry.target === before.target) ||
          (entry.kind === "file" &&
            before.kind === "file" &&
            entry.sha256 === before.sha256 &&
            entry.size === before.size &&
            entry.mode === before.mode));
      const fileRestoration =
        entry.kind === "file" && (before.kind === "file" || before.kind === "missing");
      if (!unchanged && !fileRestoration && !(before.kind === "file" && entry.kind === "missing")) {
        throw new Error(
          "Recovery resource transformation needs its migration owner's staging contract.",
        );
      }
      let restoredOwner: { uid: string; gid: string } | undefined;
      if (entry.kind === "file" && before.kind === "missing") {
        assertCurrent();
        const ancestor = await lstat(captured.ancestor.path, { bigint: true });
        if (
          !ancestor.isDirectory() ||
          `${ancestor.dev}:${ancestor.ino}` !== captured.ancestor.identity
        ) {
          throw new Error("Recovery resource ancestor changed before file restoration.");
        }
        restoredOwner = { uid: String(ancestor.uid), gid: String(ancestor.gid) };
      }
      const fileOwner =
        before.kind === "file" ? { uid: before.uid, gid: before.gid } : restoredOwner;
      const desired = unchanged
        ? before
        : entry.kind === "missing"
          ? ({ kind: "missing" } as const)
          : entry.kind === "file" && fileOwner
            ? ({
                kind: "file" as const,
                uid: fileOwner.uid,
                gid: fileOwner.gid,
                mode: entry.mode,
                sha256: entry.sha256,
                size: entry.size,
              } as const)
            : ({ kind: "missing" } as const);
      let move: PackageActivationReversePreparation["state"][number]["move"] = null;
      if (!unchanged) {
        const parent = custody.stagingParent(entry.sourcePath);
        const directory = path.join(parent, `.openclaw-reverse-state-${selected.operationId}`);
        if (
          verified.manifest.roots.some((root) => contains(root, directory)) ||
          [baseline, candidate, prepared].some(
            (ref) => contains(ref.directory, directory) || contains(directory, ref.directory),
          )
        ) {
          throw new Error("Recovery staging overlaps captured state or retained evidence.");
        }
        const parentStat = await lstat(parent, { bigint: true });
        move = {
          directory,
          parentIdentity: `${parentStat.dev}:${parentStat.ino}`,
          staged: path.join(directory, `${index}.next`),
          displaced: path.join(directory, `${index}.previous`),
        };
      }
      resources.push({
        role: "state",
        live: entry.sourcePath,
        parentIdentity: captured.ancestor.identity,
        before,
        desired,
        move,
      });
    }
    await verified.assertCurrent();
    await source.assertUnchanged();
    assertCurrent();
    return {
      maintenance,
      assertWritersSettled,
      assertCapturedSource: source.assertCapturedSource,
      validateTarget: admitted.validateTarget,
      binding: {
        protocol: "package-state-reverse-preparation-v1",
        runId,
        operationId: selected.operationId,
        baseline,
        candidate,
        prepared,
        sourceAttestation: sourceAttestationRef,
        target: admitted.target,
        initialStores: params.initialStores,
        state: resources,
        packageResources: [...custody.packageResources],
      },
    };
  } finally {
    await verified.close();
  }
}

/** One original stopped-C interval spans capture, preparation and publication.
 * No later-process call can mint this live source attestation. */
export async function withOriginalUpdateRecoveryGeneration<T>(
  params: {
    run: NonNullable<UpdateCommandOptions["run"]>;
    env: NodeJS.ProcessEnv;
    transaction: PackageUpdateTransaction;
    assertCallerBindings: () => void;
    timeoutMs: number;
  },
  publish: (generation: UpdateCommandCapturedRecoveryGeneration) => Promise<T>,
): Promise<T> {
  const { run, transaction } = params;
  const runId = run.runId;
  const executor = run.executorFence;
  const baseline = run.recoveryBaseline && structuredClone(run.recoveryBaseline);
  if (!executor || !baseline) {
    throw new Error("Recovery requires its original baseline and executor.");
  }
  const assertOriginal = captureUpdateCommandRecoveryGenerationAuthority(executor, runId);
  const initial = captureUpdateCommandExecutorCurrentStores(executor, runId);
  if (!initial) {
    throw new Error("Original recovery requires its admitted initial stores.");
  }
  const env = { ...params.env };
  const assertBindings = params.assertCallerBindings.bind(params);
  const assertCurrent = () => {
    assertBindings();
    assertOriginal();
    if (
      run.runId !== runId ||
      run.executorFence !== executor ||
      !isDeepStrictEqual(run.recoveryBaseline, baseline)
    ) {
      throw new Error("Recovery changed its original run, executor or baseline.");
    }
  };
  assertCurrent();
  await persistOriginalUpdateConfigWrites(run);
  assertCurrent();
  const verified = await prepareVerifiedBackup(baseline, { env });
  try {
    await verified.assertCurrent();
    assertCurrent();
    if (
      verified.manifest.runId !== runId ||
      verified.manifest.generation?.kind !== "baseline" ||
      verified.manifest.installRoot !== initial.selection.installation.path ||
      !isDeepStrictEqual(initial, captureUpdateCommandExecutorCurrentStores(executor, runId))
    ) {
      throw new Error("Recovery baseline no longer belongs to its original run.");
    }
    let capturedGeneration: UpdateCommandCapturedRecoveryGeneration["binding"] | undefined;
    const result = await withUpdateRecoverySourceCustody(
      {
        runId,
        installRoot: verified.manifest.installRoot,
        env,
        baseline: { ref: baseline, manifest: verified.manifest },
        assertOwned: assertCurrent,
      },
      async ({ maintenance, assertCurrent: assertHeld }) => {
        const generation = await prepareOriginalUpdateRecoveryGeneration({
          baseline,
          executor,
          runId,
          transaction,
          maintenance,
          assertCallerBindings: assertCurrent,
          assertWritersSettled: assertHeld,
          env,
          timeoutMs: params.timeoutMs,
          initialStores: initial.selection,
        });
        assertHeld();
        capturedGeneration = structuredClone(generation.binding);
        return publish(generation);
      },
    );
    // Publication and next-reader admission have settled. Writing this receipt
    // during stopped-C custody would mutate the very source being attested.
    assertCurrent();
    if (!capturedGeneration) {
      throw new Error("Original generation receipt is missing.");
    }
    const capturedBinding = capturedGeneration;
    const capture = getUpdateRun(runId, { env: run.env })?.origin.updateRecoveryCapture;
    if (
      !capture ||
      capture.manifestSha256 !== baseline.manifestSha256 ||
      capture.generation ||
      capture.retirement
    ) {
      throw new Error("Recovery generation receipt changed before publication.");
    }
    mutateRun(
      runId,
      (record) => {
        assertCurrent();
        if (!isDeepStrictEqual(record.origin.updateRecoveryCapture, capture)) {
          throw new Error("Recovery capture changed before generation receipt publication.");
        }
        record.origin.updateRecoveryCapture = {
          ...capture,
          generation: {
            operationId: capturedBinding.operationId,
            candidateSha256: capturedBinding.candidate.manifestSha256,
            preparedSha256: capturedBinding.prepared.manifestSha256,
            sourceAttestation: { ...capturedBinding.sourceAttestation },
          },
        };
      },
      { env: run.env },
    );
    assertCurrent();
    return result;
  } finally {
    await verified.close();
  }
}
