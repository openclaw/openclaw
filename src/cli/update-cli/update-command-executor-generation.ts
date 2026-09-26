import { randomUUID } from "node:crypto";
import {
  publishUpdateInitialPackageGeneration,
  publishUpdateInitialStoreGeneration,
} from "../../infra/update-initial-store-invocation.js";
import type { UpdateInitialStoreTransport } from "../../infra/update-initial-store-transport.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import {
  admittedAuthorities,
  admittedRunIds,
  preflightReleases,
  type ManagedUpdateLeaseAuthority,
} from "./update-command-executor-state.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";

type GenerationInput = Omit<
  Parameters<typeof publishUpdateInitialStoreGeneration>[0],
  "initialStores" | "authority"
> &
  Pick<
    Parameters<typeof publishUpdateInitialStoreGeneration>[0]["authority"],
    "assertWritersSettled" | "validateTarget" | "assertCapturedSource"
  >;
type GenerationResult = Awaited<
  ReturnType<typeof publishUpdateInitialStoreGeneration>
>["completion"];
type PackageGenerationResult = Awaited<
  ReturnType<typeof publishUpdateInitialPackageGeneration>
>["completion"];
type Admission = Parameters<typeof publishUpdateInitialPackageGeneration>[0]["initialStores"];

// Original-only operations. Admission identity itself stays in the receiver's
// shared state module, including the exact registry used by delegated executors.
const originalGenerations = new WeakMap<
  UpdateRecoveryFence,
  (runId: string, input: GenerationInput) => Promise<GenerationResult>
>();
const originalPackageGenerations = new WeakMap<
  UpdateRecoveryFence,
  (runId: string, operationId: string) => Promise<PackageGenerationResult>
>();

export function captureUpdateCommandExecutorCurrentStores(
  fence: UpdateRecoveryFence,
  runId: string,
): UpdateInitialStoreTransport | undefined {
  fence.assertCurrent();
  const admitted = admittedAuthorities.get(fence);
  if (!admitted || admittedRunIds.get(fence) !== runId) {
    throw new UpdateCommandRecoveryPendingError("Package recovery requires its admitted executor.");
  }
  return admitted.currentStores?.();
}

/** Capture before awaits; the reader fence may be suspended while its exact
 * original native owner still authorizes an already admitted publication. */
export function captureUpdateCommandRecoveryGenerationAuthority(
  fence: UpdateRecoveryFence,
  runId: string,
): () => void {
  fence.assertCurrent();
  const admitted = admittedAuthorities.get(fence);
  if (!admitted || admittedRunIds.get(fence) !== runId || !originalGenerations.has(fence)) {
    throw new UpdateCommandRecoveryPendingError("Recovery requires its direct original executor.");
  }
  const assertOriginal = admitted.assertPublicationCurrent;
  if (!assertOriginal) {
    throw new UpdateCommandRecoveryPendingError("Recovery requires native publication authority.");
  }
  return () => {
    if (admittedAuthorities.get(fence) !== admitted || admittedRunIds.get(fence) !== runId) {
      throw new UpdateCommandRecoveryPendingError("Recovery outlived its original executor.");
    }
    assertOriginal();
  };
}

export function publishUpdateCommandPackageGeneration(
  fence: UpdateRecoveryFence,
  runId: string,
  operationId: string,
): Promise<PackageGenerationResult> {
  const publish = originalPackageGenerations.get(fence);
  if (!publish) {
    throw new UpdateCommandRecoveryPendingError(
      "Publication requires its direct original executor.",
    );
  }
  return publish(runId, operationId);
}

export function publishUpdateCommandRecoveryGeneration(
  fence: UpdateRecoveryFence,
  runId: string,
  input: GenerationInput,
): Promise<GenerationResult> {
  const publish = originalGenerations.get(fence);
  if (!publish) {
    throw new UpdateCommandRecoveryPendingError(
      "Publication requires its direct original executor.",
    );
  }
  return publish(runId, input);
}

/** Internal part of the original native executor, not a replacement admission.
 * Only that executor selects/rebinds its store and releases its existing lease. */
export function registerUpdateCommandGenerationOwner(params: {
  fence: UpdateRecoveryFence;
  runId: string;
  authority: ManagedUpdateLeaseAuthority;
  assertCurrent: () => void;
  assertPublicationCurrent: () => void;
  initial: () => Admission;
  beforeRetire?: (transition: string, current: UpdateInitialStoreTransport) => Promise<void>;
  retired: () => void;
  selected: (admission: Admission, transition: string) => void | Promise<void>;
}) {
  const { fence, runId, authority, assertCurrent, assertPublicationCurrent } = params;
  let state: "ready" | "publishing" | "failed" = "ready";
  let admissionOpen = true;
  let task: Promise<unknown> | undefined;
  const beforeRetire = params.beforeRetire?.bind(params);
  const selected = params.selected.bind(params);
  const retired = params.retired.bind(params);
  function retire(initial: Admission, transition: string) {
    return beforeRetire?.(
      transition,
      Object.freeze({
        protocol: "initial-pair-v1" as const,
        selection: initial.selection,
      }),
    );
  }
  function admit(requestedRunId: string) {
    if (!admissionOpen || state !== "ready") {
      throw new UpdateCommandRecoveryPendingError("Publication admission is closed.");
    }
    assertCurrent();
    if (requestedRunId !== runId) {
      throw new UpdateCommandRecoveryPendingError("Publication changed its original run.");
    }
    const initial = params.initial();
    initial.assertCurrent();
    return initial;
  }
  function retain<T>(work: Promise<T>): Promise<T> {
    task = work;
    void work.catch(() => {});
    return work;
  }
  originalPackageGenerations.set(fence, (requestedRunId, operationId) => {
    const initial = admit(requestedRunId);
    const transition = randomUUID();
    state = "publishing";
    preflightReleases.delete(fence);
    return retain(
      (async () => {
        try {
          const result = await publishUpdateInitialPackageGeneration({
            initialStores: initial,
            authority,
            runId,
            operationId,
            assertCurrent: assertPublicationCurrent,
            beforeRetire: async () => {
              await retire(initial, transition);
            },
            onRetired: retired,
          });
          await selected(result.admission, transition);
          assertPublicationCurrent();
          result.commitInvocation();
          state = "ready";
          return result.completion;
        } catch (error) {
          // Do not close the selected guard: native lease cleanup still needs it.
          state = "failed";
          throw error;
        }
      })(),
    );
  });
  originalGenerations.set(fence, (requestedRunId, input) => {
    const initial = admit(requestedRunId);
    if (input.binding.runId !== runId) {
      throw new UpdateCommandRecoveryPendingError("Publication changed its original run.");
    }
    const transition = randomUUID();
    const binding = structuredClone(input.binding);
    const assertWritersSettled = input.assertWritersSettled.bind(input);
    const validateTarget = input.validateTarget.bind(input);
    const assertCapturedSource = input.assertCapturedSource?.bind(input);
    assertWritersSettled();
    state = "publishing";
    preflightReleases.delete(fence);
    return retain(
      (async () => {
        try {
          const result = await publishUpdateInitialStoreGeneration(
            {
              ...input,
              binding,
              initialStores: initial,
              authority: {
                assertCurrent: assertPublicationCurrent,
                assertWritersSettled: () => {
                  assertPublicationCurrent();
                  assertWritersSettled();
                },
                validateTarget,
                assertCapturedSource,
              },
            },
            {
              beforeRetire: async () => {
                await retire(initial, transition);
              },
              onRetired: retired,
            },
          );
          await selected(result.admission, transition);
          assertPublicationCurrent();
          state = "ready";
          return result.completion;
        } catch (error) {
          state = "failed";
          throw error;
        }
      })(),
    );
  });
  return {
    assertPublicationCurrent() {
      if (state === "failed") {
        throw new UpdateCommandRecoveryPendingError("State generation publication is unresolved.");
      }
    },
    assertReady() {
      if (state !== "ready") {
        throw new UpdateCommandRecoveryPendingError("State generation publication is unresolved.");
      }
    },
    closeAdmission() {
      admissionOpen = false;
      originalGenerations.delete(fence);
      originalPackageGenerations.delete(fence);
    },
    async settle() {
      await task;
    },
  };
}
