import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  readPackageActivationRecordStatus,
  resolvePackageActivationAnchor,
  resolvePackageActivationHelper,
  type PackageActivationJournal,
  type PackageActivationRecord,
  type PackageActivationPhase,
  type PackageActivationIntent,
} from "./package-update-activation-journal.js";
import {
  assertPackageReverseBinding,
  readPackageReverseGenerations,
} from "./package-update-activation-reverse-binding.js";
import {
  assertReverseParents,
  syncPackageReverseInputs,
} from "./package-update-activation-reverse-files.js";
import {
  assertPackageReverseProgress,
  inspectPackageReverseTargetAndLaunchers,
  observePackageReverseResources,
  syncPackageReverseParents,
} from "./package-update-activation-reverse-observation.js";
import {
  assertPackageReversePreparation,
  materializePackageReversePreparation,
} from "./package-update-activation-reverse-preparation.js";
import { readPackageReverseResourceCustody } from "./package-update-activation-reverse-resources.js";
import {
  packageActivationReverseBindingSchema,
  packageActivationReversePreparationSchema,
  type PackageActivationReverseBinding,
  type PackageActivationReverseIntent,
  type PackageActivationReversePreparation,
  type PackageActivationReverseResource,
} from "./package-update-activation-reverse-schema.js";
import { renamePackageReverseResource } from "./package-update-activation-symlink.js";
import {
  capturePackageReverseExecutor,
  assertPackageReverseExecutor,
} from "./package-update-reverse-authority.js";
import type { PackageReverseAuthority } from "./package-update-reverse-types.js";
import type { UpdateRecoveryPublicationCompletion } from "./package-update-swap-contract.js";
import {
  assertUpdateRecoverySourceAttestationCurrent,
  assertUpdateRecoverySourceAttestationAdmission,
  readUpdateRecoverySourceAttestation,
} from "./update-recovery-source-attestation.js";
import type { UpdateRecoveryFence } from "./update-run-recovery.js";

export type { PackageReverseAuthority } from "./package-update-reverse-types.js";
export function capturePackageReverseAuthority(
  authority: PackageReverseAuthority,
): PackageReverseAuthority {
  return {
    assertCurrent: authority.assertCurrent.bind(authority),
    assertWritersSettled: authority.assertWritersSettled.bind(authority),
    assertCapturedSource: authority.assertCapturedSource?.bind(authority),
    validateTarget: authority.validateTarget.bind(authority),
    beforeStatePublication: authority.beforeStatePublication.bind(authority),
  };
}
function packageReverseBindingDigest(binding: PackageActivationReverseBinding) {
  return createHash("sha256")
    .update(JSON.stringify(packageActivationReverseBindingSchema.parse(binding)))
    .digest("hex");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export function createPackageActivationReverseOwner(params: {
  journal: PackageActivationJournal;
  current: () => PackageActivationRecord;
  transition: (
    phase: PackageActivationPhase,
    intent: PackageActivationIntent,
    publications?: PackageActivationRecord["publications"],
    reverse?: PackageActivationReverseBinding,
    assertExecutor?: () => void,
  ) => void;
  prepareReverse: (
    preparation: PackageActivationReversePreparation,
    assertExecutor: () => void,
  ) => void;
  sealReverse: (binding: PackageActivationReverseBinding, assertExecutor: () => void) => void;
  assertCurrent: (assertExecutor?: () => void) => void;
  verifyClosure: (assertExecutor?: () => void) => Promise<void>;
  verifyForward: (assertExecutor?: () => void) => Promise<void>;
  executor?: ReturnType<typeof capturePackageReverseExecutor>;
  fence?: UpdateRecoveryFence;
  resuming?: boolean;
}) {
  const originalRunId = params.current().descriptor.originalRunId;
  const executor = Object.hasOwn(params, "executor")
    ? params.executor
    : params.fence && originalRunId
      ? capturePackageReverseExecutor(params.fence, originalRunId, params.resuming === true)
      : undefined;
  const assertExecutor = () => {
    if (!executor || !originalRunId) {
      throw new Error("Reverse publication requires a live registered executor.");
    }
    return assertPackageReverseExecutor(executor, originalRunId, params.resuming === true);
  };
  const assertReverseCurrent = () => {
    assertExecutor();
    params.assertCurrent(assertExecutor);
  };
  const transition: typeof params.transition = (phase, intent, publications, reverse) =>
    params.transition(phase, intent, publications, reverse, assertExecutor);
  const assertAuthority = (
    binding: Pick<PackageActivationReverseBinding, "runId">,
    guard: Pick<PackageReverseAuthority, "assertCurrent" | "assertWritersSettled">,
  ) => {
    const authority = assertExecutor();
    if (binding.runId !== originalRunId) {
      throw new Error("Reverse publication changed its captured original run.");
    }
    const original = params.current().descriptor.authority;
    if (params.resuming) {
      const { owner: _owner, ...current } = authority;
      const { owner: _originalOwner, ...expected } = original;
      if (
        !isDeepStrictEqual(current, expected) ||
        (!params.current().descriptor.reverse && !params.current().descriptor.reversePreparation)
      ) {
        throw new Error("Reverse continuation changed original authority.");
      }
    } else if (!isDeepStrictEqual(authority, original)) {
      throw new Error("Reverse admission requires the original operation owner.");
    }
    guard.assertCurrent();
    guard.assertWritersSettled();
    assertReverseCurrent();
  };
  const verifyCapturedSource = async (
    binding: PackageActivationReverseBinding,
    guard: PackageReverseAuthority,
  ) => {
    assertAuthority(binding, guard);
    const { candidate, sourceAttestation } = assertPackageReverseBinding(
      binding,
      params.current().descriptor,
    );
    const assertCurrent = () => assertAuthority(binding, guard);
    let assertOriginalCapture: (() => void) | undefined;
    if (params.resuming) {
      await assertUpdateRecoverySourceAttestationCurrent(
        sourceAttestation,
        candidate.entries,
        assertCurrent,
      );
    } else {
      assertOriginalCapture = await assertUpdateRecoverySourceAttestationAdmission(
        sourceAttestation,
        candidate.entries,
        {
          assertCurrent,
          assertCapturedSource: guard.assertCapturedSource,
          sourceAttestation: binding.sourceAttestation,
        },
      );
    }
    assertAuthority(binding, guard);
    return assertOriginalCapture;
  };
  const inspect = async (guard: PackageReverseAuthority) => {
    const record = params.current();
    const binding = record.descriptor.reverse;
    if (!binding) {
      throw new Error("Reverse binding is missing.");
    }
    assertAuthority(binding, guard);
    await params.verifyClosure(assertExecutor);
    const rows = await observePackageReverseResources(record);
    assertPackageReverseProgress(record, rows);
    await inspectPackageReverseTargetAndLaunchers(record, rows);
    assertAuthority(binding, guard);
    return rows;
  };
  const publish = async (guard: PackageReverseAuthority) => {
    const binding = params.current().descriptor.reverse!;
    if (!["reverse-in-progress", "reverse-complete"].includes(params.current().phase)) {
      throw new Error("Operation is not a restartable reverse publication.");
    }
    assertAuthority(binding, guard);
    await guard.validateTarget(freeze(packageActivationReverseBindingSchema.parse(binding)));
    const initialRows = await inspect(guard);
    let assertOriginalCapture: (() => void) | undefined;
    if (initialRows.every((row) => row === "initial" || row === "unchanged")) {
      assertOriginalCapture = await verifyCapturedSource(binding, guard);
    }
    // A resumed partial publication has already retired the prior selection. Its
    // recorded images, not a fresh admission of the old live inode, govern resume.
    let statePublicationStarted = binding.resources.some(
      (resource, index) =>
        resource.role === "state" && resource.move && initialRows[index] !== "initial",
    );
    const beforeEffect = (resource: PackageActivationReverseResource) => {
      assertAuthority(binding, guard);
      // The last inspection awaited closure and image reads. Proof can be
      // independently revoked there; check the retained admission at the effect.
      assertOriginalCapture?.();
      if (resource.role === "state" && !statePublicationStarted) {
        guard.beforeStatePublication(binding);
        statePublicationStarted = true;
        assertAuthority(binding, guard);
      }
      assertOriginalCapture?.();
      // Once an effect is issued, durable intent/images govern partial resume.
      // Never demand a fresh capture of the now-displaced C source.
      assertOriginalCapture = undefined;
    };
    while (params.current().phase !== "reverse-complete") {
      // SAFETY: inspect validated reverse intent; exclusive transitions preserve its kind.
      const progress = params.current().intent as PackageActivationReverseIntent;
      const resource = binding.resources[progress.completed];
      if (!resource) {
        transition("reverse-complete", { ...progress, effect: null });
        break;
      }
      if (resource.move) {
        if (progress.effect === null) {
          transition("reverse-in-progress", { ...progress, effect: "displace" });
        }
        let rows = await inspect(guard);
        if (rows[progress.completed] === "initial" && resource.before.kind !== "missing") {
          beforeEffect(resource);
          await renamePackageReverseResource(resource.live, resource.move.displaced, {
            sourceIdentity: resource.before.identity,
            assertBeforeRename: () => {
              assertAuthority(binding, guard);
              assertReverseParents(resource);
            },
          });
          await syncPackageReverseParents(resource);
        }
        await inspect(guard);
        await syncPackageReverseParents(resource);
        assertAuthority(binding, guard);
        transition("reverse-in-progress", { ...progress, effect: "publish" });
        rows = await inspect(guard);
        if (rows[progress.completed] !== "published" && resource.after.kind !== "missing") {
          beforeEffect(resource);
          await renamePackageReverseResource(resource.move.staged, resource.live, {
            sourceIdentity: resource.after.identity,
            assertBeforeRename: () => {
              assertAuthority(binding, guard);
              assertReverseParents(resource);
            },
          });
        }
        // Also sync observed lost acknowledgements before advancing the journal.
        await syncPackageReverseParents(resource);
        rows = await inspect(guard);
        if (rows[progress.completed] !== "published") {
          throw new Error("Reverse publication postimage is incomplete.");
        }
      }
      assertAuthority(binding, guard);
      transition("reverse-in-progress", {
        kind: "reverse",
        direction: "reverse",
        completed: progress.completed + 1,
        effect: null,
      });
    }
    await inspect(guard);
    return readPackageActivationRecordStatus(params.current());
  };
  const materializePreparation = (guard: PackageReverseAuthority) =>
    materializePackageReversePreparation(
      {
        current: params.current,
        resuming: params.resuming,
        assertAuthority,
        assertExecutor,
        transition: (phase, intent) => transition(phase, intent),
        sealReverse: params.sealReverse,
        publish,
      },
      guard,
    );
  let active = false;
  const exclusively = async <T>(run: () => Promise<T>) => {
    if (active) {
      throw new Error("Reverse publication is already in flight.");
    }
    active = true;
    try {
      return await run();
    } finally {
      active = false;
    }
  };
  return {
    assertReverseCurrent,
    resourceCustody: (
      authority: Pick<PackageReverseAuthority, "assertCurrent" | "assertWritersSettled">,
    ) => {
      // Capture callbacks before the first await; this is resource inspection,
      // not startup admission and never calls validateTarget.
      const guard = {
        assertCurrent: authority.assertCurrent.bind(authority),
        assertWritersSettled: authority.assertWritersSettled.bind(authority),
      };
      return exclusively(async () => {
        const record = params.current();
        const runId = record.descriptor.originalRunId;
        if (
          !runId ||
          params.resuming ||
          record.phase !== "publication-complete" ||
          record.descriptor.reverse
        ) {
          throw new Error("Resource custody requires the untouched original publication.");
        }
        const assertCurrent = () => {
          assertAuthority({ runId }, guard);
          params.journal.assertCurrent(record);
        };
        assertCurrent();
        await params.verifyForward(assertExecutor);
        assertCurrent();
        const result = await readPackageReverseResourceCustody(record, assertCurrent);
        assertCurrent();
        return freeze(result);
      });
    },
    prepareReverse: (
      preparationInput: PackageActivationReversePreparation,
      authority: PackageReverseAuthority,
    ) =>
      exclusively(async () => {
        const guard = capturePackageReverseAuthority(authority);
        const preparation = freeze(
          packageActivationReversePreparationSchema.parse(preparationInput),
        );
        const record = params.current();
        if (
          record.phase !== "publication-complete" ||
          record.descriptor.reverse ||
          record.descriptor.reversePreparation ||
          params.resuming
        ) {
          throw new Error("Reverse preparation requires untouched original publication.");
        }
        assertAuthority(preparation, guard);
        const { generations } = assertPackageReversePreparation(preparation, record);
        const sourceAttestation = readUpdateRecoverySourceAttestation(
          preparation.sourceAttestation,
          {
            runId: preparation.runId,
            operationId: preparation.operationId,
            candidateManifestSha256: preparation.candidate.manifestSha256,
            entries: generations.candidate.entries,
          },
        );
        await assertUpdateRecoverySourceAttestationAdmission(
          sourceAttestation,
          generations.candidate.entries,
          {
            assertCurrent: () => assertAuthority(preparation, guard),
            assertCapturedSource: guard.assertCapturedSource,
            sourceAttestation: preparation.sourceAttestation,
          },
        );
        await params.verifyForward(assertExecutor);
        await guard.validateTarget(
          packageActivationReverseBindingSchema.parse({
            protocol: "package-state-reverse-v1",
            operationId: preparation.operationId,
            runId: preparation.runId,
            baseline: preparation.baseline,
            candidate: preparation.candidate,
            prepared: preparation.prepared,
            sourceAttestation: preparation.sourceAttestation,
            target: preparation.target,
            initialStores: preparation.initialStores,
            resources: [
              ...preparation.state.map((resource) => ({
                role: "state" as const,
                live: resource.live,
                parentIdentity: resource.parentIdentity,
                before: resource.before,
                after: resource.before,
                move: null,
              })),
              ...preparation.packageResources,
            ],
          }),
        );
        assertAuthority(preparation, guard);
        params.prepareReverse(preparation, assertExecutor);
        return materializePreparation(guard);
      }),
    resumePreparation: (authority: PackageReverseAuthority) =>
      exclusively(() => materializePreparation(capturePackageReverseAuthority(authority))),
    reverse: (bindingInput: PackageActivationReverseBinding, authority: PackageReverseAuthority) =>
      exclusively(async () => {
        const guard = capturePackageReverseAuthority(authority);
        const binding = freeze(packageActivationReverseBindingSchema.parse(bindingInput));
        const record = params.current();
        if (
          record.phase !== "publication-complete" ||
          record.descriptor.reverse ||
          params.resuming
        ) {
          throw new Error(
            "Reverse admission requires an untouched original completed publication.",
          );
        }
        assertAuthority(binding, guard);
        const generations = assertPackageReverseBinding(binding, record.descriptor);
        await verifyCapturedSource(binding, guard);
        await params.verifyForward(assertExecutor);
        const provisional = {
          ...record,
          phase: "reverse-in-progress" as const,
          descriptor: { ...record.descriptor, reverse: binding },
          intent: {
            kind: "reverse" as const,
            direction: "reverse" as const,
            completed: 0,
            effect: null,
          },
        };
        const rows = await observePackageReverseResources(provisional);
        assertPackageReverseProgress(provisional, rows);
        await inspectPackageReverseTargetAndLaunchers(provisional, rows);
        await guard.validateTarget(binding);
        await syncPackageReverseInputs(
          binding.resources,
          () => assertAuthority(binding, guard),
          (["baseline", "candidate", "prepared"] as const).map((kind) => ({
            directory: binding[kind].directory,
            files: [
              binding[kind].manifestPath,
              ...generations[kind].entries.flatMap((entry) =>
                entry.kind === "file"
                  ? [path.join(binding[kind].directory, entry.archivePath)]
                  : [],
              ),
            ],
          })),
          [
            resolvePackageActivationHelper(
              resolvePackageActivationAnchor(record.descriptor.authority.installKey),
            ),
            binding.sourceAttestation.path,
            binding.target.nodePath,
            record.descriptor.authority.databasePath,
          ],
        );
        await params.verifyClosure(assertExecutor);
        assertPackageReverseProgress(
          provisional,
          await observePackageReverseResources(provisional),
        );
        await inspectPackageReverseTargetAndLaunchers(provisional, rows);
        assertAuthority(binding, guard);
        const assertPinCapture = await verifyCapturedSource(binding, guard);
        assertPinCapture?.();
        // The immutable binding and reverse direction commit in the SAME journal
        // transaction before any live package, launcher or state effect.
        transition("reverse-in-progress", provisional.intent, undefined, binding);
        return publish(guard);
      }),
    // Completion proof belongs to the still-held, pre-first-writer maintenance
    // scope. It is not a permanent assertion that serving state must equal T.
    verifyCompletion: (
      bindingInput: Readonly<PackageActivationReverseBinding>,
      authority: PackageReverseAuthority,
    ) =>
      exclusively(async () => {
        const guard = capturePackageReverseAuthority(authority);
        const binding = freeze(packageActivationReverseBindingSchema.parse(bindingInput));
        const record = params.current();
        if (
          !["reverse-complete", "rolled-back"].includes(record.phase) ||
          record.intent?.kind !== "reverse" ||
          record.intent.completed !== binding.resources.length ||
          record.intent.effect !== null ||
          !isDeepStrictEqual(record.descriptor.reverse, binding)
        ) {
          throw new Error("Reverse completion requires the exact settled original binding.");
        }
        assertAuthority(binding, guard);
        params.journal.assertCurrent(record);
        await guard.validateTarget(binding);
        const rows = await inspect(guard);
        if (rows.some((row) => row !== "published" && row !== "unchanged")) {
          throw new Error("Reverse completion is not exhaustively published.");
        }
        assertAuthority(binding, guard);
        // Another owner operation may have advanced the record during an await.
        // Checking only the owner's latest record would accept that revision.
        params.journal.assertCurrent(record);
        const { prepared } = readPackageReverseGenerations(
          binding,
          binding.runId,
          record.descriptor.authority.installKey,
        );
        const globalOwners =
          prepared.databases?.filter((database) => database.role === "global") ?? [];
        const states = binding.resources.filter(
          (resource) => resource.role === "state" && resource.live === globalOwners[0]?.path,
        );
        const state = states[0];
        if (
          globalOwners.length !== 1 ||
          states.length !== 1 ||
          !state ||
          state.after.kind !== "file"
        ) {
          throw new Error(
            "Reverse completion requires exactly one recorded global state database.",
          );
        }
        return freeze({
          ...readPackageActivationRecordStatus(record),
          publishedState: {
            operationId: binding.operationId,
            runId: binding.runId,
            baseline: binding.baseline,
            candidate: binding.candidate,
            prepared: binding.prepared,
            target: binding.target,
            bindingDigest: packageReverseBindingDigest(binding),
            state: {
              databasePath: state.live,
              databaseIdentity: state.after.identity,
              parentIdentity: state.parentIdentity,
            },
          },
        }) satisfies UpdateRecoveryPublicationCompletion;
      }),
    commitCompletion: (
      bindingInput: Readonly<PackageActivationReverseBinding>,
      authority: PackageReverseAuthority,
    ) =>
      exclusively(async () => {
        const guard = capturePackageReverseAuthority(authority);
        const binding = freeze(packageActivationReverseBindingSchema.parse(bindingInput));
        const record = params.current();
        if (
          !["reverse-complete", "rolled-back"].includes(record.phase) ||
          record.intent?.kind !== "reverse" ||
          record.intent.completed !== binding.resources.length ||
          record.intent.effect !== null ||
          !isDeepStrictEqual(record.descriptor.reverse, binding)
        ) {
          throw new Error("Reverse terminal commit requires the verified complete binding.");
        }
        assertAuthority(binding, guard);
        await guard.validateTarget(binding);
        const rows = await inspect(guard);
        if (rows.some((row) => row !== "published" && row !== "unchanged")) {
          throw new Error("Reverse terminal commit found incomplete publication.");
        }
        assertAuthority(binding, guard);
        params.journal.assertCurrent(record);
        if (record.phase === "rolled-back") {
          return readPackageActivationRecordStatus(record);
        }
        const publications = binding.resources.flatMap((resource) =>
          resource.role === "launcher" && resource.after.kind !== "missing"
            ? [{ name: path.basename(resource.live), identity: resource.after.identity }]
            : [],
        );
        transition("rolled-back", record.intent, publications);
        return readPackageActivationRecordStatus(params.current());
      }),
    resumeReverse: (authority: PackageReverseAuthority) =>
      exclusively(() => publish(capturePackageReverseAuthority(authority))),
    settleReverse: (authority: PackageReverseAuthority) =>
      exclusively(async () => {
        const guard = capturePackageReverseAuthority(authority);
        if (params.current().phase !== "reverse-complete") {
          throw new Error("Incomplete reverse publication cannot settle or release evidence.");
        }
        await inspect(guard);
        const binding = params.current().descriptor.reverse!;
        const publications = binding.resources.flatMap((resource) =>
          resource.role === "launcher" && resource.after.kind !== "missing"
            ? [{ name: path.basename(resource.live), identity: resource.after.identity }]
            : [],
        );
        assertAuthority(binding, guard);
        transition("reverse-complete", params.current().intent, publications);
        return readPackageActivationRecordStatus(params.current());
      }),
  };
}
