import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  captureUpdateCommandExecutorAuthority,
  captureUpdateCommandExecutorCurrentStores,
  publishUpdateCommandPackageGeneration,
  withUpdateCommandExecutor,
} from "../cli/update-cli/update-command-executor.js";
import {
  openPackageActivationJournal,
  assertPackageActivationOperation,
  assertPackageActivationLayout,
  resolvePackageActivationControl,
  resolvePackageActivationJournalPath,
  isPackageActivationComplete,
  resolvePackageActivationAnchor,
  type PackageActivationJournal,
  type PackageActivationRecord,
} from "./package-update-activation-journal.js";
import {
  preparePackageActivationJournal,
  resolvePackageActivationRecoveryCommand as recoveryCommand,
  type PackageActivationPreparation,
} from "./package-update-activation-prepare.js";
import { readPackageReverseGenerations } from "./package-update-activation-reverse-binding.js";
import type { PackageReverseAuthority } from "./package-update-activation-reverse.js";
import {
  createPublicationOwner,
  packageActivationStatus as status,
  type PackageActivationStatus,
} from "./package-update-publication-owner.js";
import { capturePackageReverseExecutor } from "./package-update-reverse-authority.js";
import type { ResolvedGlobalInstallTarget } from "./update-global.js";
import { admitUpdateInitialStores } from "./update-initial-store-admission.js";
import { assertManagedUpdateLeaseDatabaseIdentity } from "./update-managed-service-handoff-database.js";
import { supportsPostCoreExecutor } from "./update-post-core-capability.js";
import { withUpdateRecoveryResumeCustody } from "./update-recovery-resume-custody.js";
import { admitSelectedRuntimeUpdateRecoveryPublication } from "./update-recovery-startup-admission.js";
import type { UpdateRecoveryFence } from "./update-run-recovery.js";

export type { PackageActivationStatus } from "./package-update-publication-owner.js";

/** Read-only correlation; callers still need a privately registered live fence. */
function readPackageActivationContinuation(installKey: string) {
  const anchor = resolvePackageActivationAnchor(installKey);
  assertPackageActivationLayout(anchor);
  const journalPath = resolvePackageActivationJournalPath(anchor);
  if (!fs.lstatSync(journalPath, { throwIfNoEntry: false })) {
    if (
      fs.lstatSync(anchor, { throwIfNoEntry: false }) ||
      fs.lstatSync(resolvePackageActivationControl(anchor), { throwIfNoEntry: false })
    ) {
      throw new Error(
        `Incomplete or legacy recovery artifacts require their original owner: ${anchor}. The next mutable update is blocked.`,
      );
    }
    return undefined;
  }
  const record = openPackageActivationJournal(anchor).read();
  if (isPackageActivationComplete(anchor, record)) {
    return undefined;
  }
  if (record.descriptor.authority.installKey !== installKey) {
    throw new Error("Package publication is incomplete; its original continuation cannot run.");
  }
  assertManagedUpdateLeaseDatabaseIdentity(record.descriptor.authority);
  if (record.phase !== "publication-complete") {
    throw new Error(
      `Package publication is incomplete; its original continuation cannot run. With an external Node, run ${recoveryCommand(record)} status, then repair or retire; keep other package managers stopped.`,
    );
  }
  return record.descriptor.authority;
}

export function assertNoPendingPackageActivation(
  installKey: string,
  options?: { continuation?: UpdateRecoveryFence },
): void {
  const authority = readPackageActivationContinuation(installKey);
  if (!authority) {
    return;
  }
  if (
    options?.continuation &&
    isDeepStrictEqual(authority, captureUpdateCommandExecutorAuthority(options.continuation))
  ) {
    return;
  }
  const anchor = resolvePackageActivationAnchor(installKey);
  const record = openPackageActivationJournal(anchor).read();
  throw new Error(
    `Package publication recovery is pending. With an external Node, run ${recoveryCommand(record)} status, then repair or retire; keep other package managers stopped.`,
  );
}

// Only a prepared inline owner can install a provider, for the lifetime of its
// call into the original executor. The shared invocation cannot replace its
// native assertion or supply a different journal/operation.
const nativeForwardDispatch = new AsyncLocalStorage<object>();
const forwardProviders = new Map<
  string,
  {
    initial: PackageActivationRecord;
    dispatch: object;
    provider: Pick<
      ReturnType<typeof createPublicationOwner>,
      "preflight" | "publish" | "assertCurrent"
    >;
  }
>();

export function createPackageActivationForwardProvider(
  anchor: string,
  journal: PackageActivationJournal,
  _callerAssertion: () => void,
  initial: PackageActivationRecord,
) {
  const admitted = forwardProviders.get(anchor);
  if (
    !admitted ||
    nativeForwardDispatch.getStore() !== admitted.dispatch ||
    !isDeepStrictEqual(initial, admitted.initial)
  ) {
    throw new Error("Forward publication requires its prepared inline owner and native dispatch.");
  }
  admitted.provider.assertCurrent();
  journal.assertCurrent(initial);
  return admitted.provider;
}

export async function preparePackageActivation(
  params: PackageActivationPreparation & { installTarget: ResolvedGlobalInstallTarget },
) {
  const fence = params.options.fence;
  const assertOriginal = fence.assertCurrent.bind(fence);
  const options = { ...params.options, fence };
  // Ordinary forward updates without a selected generation remain supported.
  // They must not gain reverse authority from a replacement callback.
  const reverseExecutor =
    options.runId && captureUpdateCommandExecutorCurrentStores(fence, options.runId)
      ? capturePackageReverseExecutor(fence, options.runId)
      : undefined;
  if (
    process.platform === "win32" ||
    process.versions.bun ||
    params.installTarget.manager !== "npm" ||
    params.installTarget.directNodeModulesRoot ||
    !(await fsp.lstat(params.stageRoot)).isDirectory()
  ) {
    return undefined;
  }
  const capable = await supportsPostCoreExecutor(params.stageRoot, options.nodeRunner);
  assertOriginal();
  if (!capable) {
    // Older/respawning targets keep their shipped update path, without a
    // journal whose post-core receiver cannot prove original ownership.
    options.onUnavailable?.(
      "Standalone package publication repair is unavailable for this target: its preferred CLI entry does not support delegated post-core execution.",
    );
    return undefined;
  }
  const prepared = await preparePackageActivationJournal({ ...params, options }, assertOriginal);
  let publishing = false;
  const assertRetained = () => {
    if (publishing && reverseExecutor) {
      reverseExecutor.assertCurrent();
    } else {
      assertOriginal();
    }
  };
  const initial = prepared.journal.read();
  const owner = createPublicationOwner(
    prepared.anchor,
    prepared.journal,
    assertRetained,
    initial,
    undefined,
    fence,
    false,
    reverseExecutor,
  );
  return {
    ...prepared,
    ...owner,
    async publish(resume: boolean, onDisplaced?: () => void | Promise<void>) {
      if (!reverseExecutor) {
        return owner.publish(resume, onDisplaced);
      }
      assertOriginal();
      if (resume || publishing || forwardProviders.has(prepared.anchor)) {
        throw new Error("Forward publication requires its original prepared invocation.");
      }
      owner.assertCurrent();
      const current = prepared.journal.read();
      if (
        current.phase !== "prepared" ||
        !isDeepStrictEqual(current.descriptor, initial.descriptor)
      ) {
        throw new Error("Forward publication requires its original prepared journal.");
      }
      const dispatch = {};
      let effectDispatched = false;
      const assertNative = () => {
        if (!publishing || nativeForwardDispatch.getStore() !== dispatch) {
          throw new Error("Forward publication outlived its inline owner.");
        }
        reverseExecutor.assertCurrent();
      };
      const native = createPublicationOwner(
        prepared.anchor,
        prepared.journal,
        assertNative,
        current,
      );
      const provider = {
        preflight: native.preflight,
        assertCurrent: native.assertCurrent,
        publish: async (requestedResume: boolean) => {
          assertNative();
          if (requestedResume || effectDispatched) {
            throw new Error("Forward publication requires its single original native dispatch.");
          }
          effectDispatched = true;
          return native.publish(false, async () => {
            owner.synchronize();
            await onDisplaced?.();
            assertNative();
          });
        },
      };
      publishing = true;
      forwardProviders.set(prepared.anchor, { initial: current, dispatch, provider });
      try {
        const completion = await nativeForwardDispatch.run(dispatch, () =>
          publishUpdateCommandPackageGeneration(
            fence,
            reverseExecutor.runId,
            current.descriptor.operationId,
          ),
        );
        // Native publication owns the durable journal during the displacement
        // gap. Rejoin its authenticated current record, never the prepared JS
        // snapshot, before this retained transaction can reverse or retire.
        assertOriginal();
        owner.synchronize();
        return completion;
      } finally {
        publishing = false;
        forwardProviders.delete(prepared.anchor);
      }
    },
  };
}
export function readPackageActivationReceipt(
  installKey: string,
): (PackageActivationStatus & { recoveryCommand?: string }) | undefined {
  const anchor = resolvePackageActivationAnchor(installKey);
  if (!fs.existsSync(resolvePackageActivationJournalPath(anchor))) {
    readPackageActivationContinuation(installKey);
    return undefined;
  }
  const record = openPackageActivationJournal(anchor).read();
  assertManagedUpdateLeaseDatabaseIdentity(record.descriptor.authority);
  const receipt = status(record);
  return receipt.phase === "complete"
    ? receipt
    : { ...receipt, recoveryCommand: `${recoveryCommand(record)} status` };
}
export async function readPackageActivationStatus(
  anchor: string,
  operationId: string,
): Promise<PackageActivationStatus> {
  const record = openPackageActivationJournal(anchor).read();
  assertPackageActivationOperation(record, operationId);
  assertManagedUpdateLeaseDatabaseIdentity(record.descriptor.authority);
  return status(record);
}

async function runPackageActivationReverseRecovery(
  anchor: string,
  operationId: string,
): Promise<PackageActivationStatus> {
  const journal = openPackageActivationJournal(anchor);
  const admission = await journal.readForRecovery();
  const initial = admission.record;
  assertPackageActivationOperation(initial, operationId);
  const durable = initial.descriptor.reverse ?? initial.descriptor.reversePreparation;
  if (
    !durable ||
    !["reverse-preparing", "reverse-in-progress", "reverse-complete", "rolled-back"].includes(
      initial.phase,
    )
  ) {
    throw new Error("Reverse repair does not match a durable original operation.");
  }
  const generations = readPackageReverseGenerations(
    durable,
    durable.runId,
    initial.descriptor.authority.installKey,
  );
  assertManagedUpdateLeaseDatabaseIdentity(initial.descriptor.authority);
  return withUpdateCommandExecutor(
    durable.runId,
    async (executor) => {
      const fence = await executor.enter(initial.descriptor.authority.installKey);
      assertManagedUpdateLeaseDatabaseIdentity(initial.descriptor.authority);
      admission.admit(fence.assertCurrent);
      journal.assertCurrent(initial);
      const owner = createPublicationOwner(
        anchor,
        journal,
        fence.assertCurrent,
        initial,
        undefined,
        fence,
        true,
      );
      const selection = () => {
        const descriptor = journal.read().descriptor;
        return {
          anchor,
          operationId: descriptor.operationId,
          originalRunId: descriptor.originalRunId,
          previous: descriptor.previous,
          previousRuntime: descriptor.previousRuntime,
        };
      };
      return withUpdateRecoveryResumeCustody(
        {
          manifest: generations.prepared,
          assertOwned: owner.assertCurrent,
        },
        async ({ assertCurrent }) => {
          const admitted = await admitSelectedRuntimeUpdateRecoveryPublication(
            {
              baseline: durable.baseline,
              candidate: durable.candidate,
              prepared: durable.prepared,
            },
            { assertOwned: assertCurrent },
            { selection, timeoutMs: 10 * 60_000 },
            initial.descriptor.reverse,
          );
          if (!isDeepStrictEqual(admitted.target, durable.target)) {
            throw new Error("Reverse repair changed its selected target runtime.");
          }
          const authority: PackageReverseAuthority = {
            assertCurrent,
            assertWritersSettled: assertCurrent,
            validateTarget: admitted.validateTarget,
            beforeStatePublication: () => assertCurrent(),
          };
          if (journal.read().phase === "reverse-preparing") {
            await owner.resumePreparation(authority);
          } else if (journal.read().phase === "reverse-in-progress") {
            await owner.resumeReverse(authority);
          }
          if (journal.read().phase === "reverse-complete") {
            await owner.settleReverse(authority);
          }
          const binding = journal.read().descriptor.reverse;
          if (!binding) {
            throw new Error("Reverse repair did not seal its durable binding.");
          }
          const completion = await owner.verifyCompletion(binding, authority);
          const packageResource = binding.resources.find((resource) => resource.role === "package");
          if (!packageResource || packageResource.after.kind !== "package") {
            throw new Error("Reverse repair lost its package postimage.");
          }
          const next = admitUpdateInitialStores({
            ...binding.initialStores,
            installation: {
              path: binding.initialStores.installation.path,
              identity: packageResource.after.identity,
            },
            state: completion.publishedState.state,
          });
          try {
            assertCurrent();
            next.assertCurrent();
            const final = await owner.commitCompletion(binding, authority);
            assertCurrent();
            next.assertCurrent();
            return final;
          } finally {
            next.close();
          }
        },
      );
    },
    { existingAuthority: initial.descriptor.authority },
  );
}
export async function runPackageActivationRecovery(
  anchor: string,
  action: "repair" | "retire",
  operationId: string,
): Promise<PackageActivationStatus> {
  const journal = openPackageActivationJournal(anchor);
  const admission = await journal.readForRecovery();
  const initial = admission.record;
  assertPackageActivationOperation(initial, operationId);
  if (isPackageActivationComplete(anchor, initial)) {
    assertManagedUpdateLeaseDatabaseIdentity(initial.descriptor.authority);
    return status(initial);
  }
  if (
    action === "repair" &&
    (initial.descriptor.reversePreparation || initial.descriptor.reverse)
  ) {
    return runPackageActivationReverseRecovery(anchor, operationId);
  }
  // Reject malformed/foreign/disarmed recovery before acquiring a new writer.
  // Admission is still followed by the same observations under the fresh fence.
  await createPublicationOwner(
    anchor,
    journal,
    () => {
      assertManagedUpdateLeaseDatabaseIdentity(initial.descriptor.authority);
    },
    initial,
    admission.assertUnchanged,
  ).preflight(action);
  return withUpdateCommandExecutor(
    randomUUID(),
    async (executor) => {
      const fence = await executor.enter(initial.descriptor.authority.installKey);
      assertManagedUpdateLeaseDatabaseIdentity(initial.descriptor.authority);
      admission.admit(fence.assertCurrent);
      journal.assertCurrent(initial);
      const owner = createPublicationOwner(anchor, journal, fence.assertCurrent, initial);
      return action === "repair" ? owner.publish(true) : owner.retire();
    },
    { existingAuthority: initial.descriptor.authority },
  );
}
