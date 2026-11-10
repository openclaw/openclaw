import { resolveGlobalMap } from "../shared/global-singleton.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../shared/store-writer-queue.js";
import { DuplicateAgentError } from "./agent-create-error.js";
import { captureWorkspaceStateFilesystemGuard } from "./workspace-state-guard.js";
import { resolveCanonicalWorkspacePath } from "./workspace-state-identity.js";
import {
  mergeWorkspaceSetupState,
  replaceWorkspaceAttestation,
  type WorkspaceAttestation,
} from "./workspace-state-store.js";
import type { WorkspaceStateGuard } from "./workspace-state-store.worker-contract.js";

const preparationQueues = resolveGlobalMap<string, StoreWriterQueue>(
  Symbol.for("openclaw.workspacePreparationQueues"),
);

// The initializer owns seeding even when ordinary turns use this workspace.
// Persist that custody with setup state so a restart cannot seed defaults.
export async function deferWorkspaceBootstrap(
  dir: string,
  options: Parameters<typeof mergeWorkspaceSetupState>[3] = {},
): Promise<() => Promise<void>> {
  await mergeWorkspaceSetupState(dir, { bootstrapDeferred: true }, undefined, options);
  return () => settleWorkspaceBootstrapDeferral(dir, options);
}

export async function settleWorkspaceBootstrapDeferral(
  dir: string,
  options: Parameters<typeof mergeWorkspaceSetupState>[3] = {},
): Promise<void> {
  await mergeWorkspaceSetupState(dir, { bootstrapDeferred: false }, undefined, options);
}

/** Keep host filesystem preparation and its worker writes in one directory's FIFO interval. */
export function runWorkspacePreparation<T>(
  dir: string,
  prepare: (assertFilesystem: () => void) => Promise<T>,
): Promise<T> {
  const assertFilesystem = captureWorkspaceStateFilesystemGuard(dir, false);
  const canonicalDir = resolveCanonicalWorkspacePath(dir);
  assertFilesystem();
  return runQueuedStoreWrite({
    queues: preparationQueues,
    storePath: canonicalDir,
    label: "Workspace preparation",
    fn: async () => {
      assertFilesystem();
      return await prepare(assertFilesystem);
    },
  });
}

export async function maybeWriteWorkspaceAttestation(
  dir: string,
  previous: WorkspaceAttestation | undefined,
  collectGeneratedHashes: (
    dir: string,
    previousHashes?: ReadonlyMap<string, string>,
  ) => Promise<Map<string, string>>,
  guard?: WorkspaceStateGuard,
): Promise<void> {
  const assertHost = guard?.assertHost;
  // Order snapshots by when their filesystem observation starts. The store
  // compares against a separate lock-time clock, so a newer committed scan
  // wins when this async collection finishes later.
  const attestedAtMs = Date.now();
  const generatedHashes = await collectGeneratedHashes(dir, previous?.generatedHashes);
  assertHost?.();
  // Coalesce unchanged evidence while retaining at least 23 hours of durable
  // disappearance protection. Future-dated evidence still needs clock repair.
  if (
    previous &&
    attestedAtMs >= previous.attestedAtMs &&
    attestedAtMs - previous.attestedAtMs <= 60 * 60 * 1000 &&
    generatedHashes.size === previous.generatedHashes.size &&
    [...generatedHashes].every(([name, hash]) => previous.generatedHashes.get(name) === hash)
  ) {
    return;
  }
  try {
    await replaceWorkspaceAttestation({
      workspaceDir: dir,
      attestedAtMs,
      generatedHashes,
      assertCurrent: assertHost,
      recoveryHoldPredicate: guard?.recoveryHoldPredicate,
      beforeLegacyApply: guard?.beforeLegacyApply,
    });
  } catch (error) {
    if (error instanceof DuplicateAgentError) {
      throw error;
    }
    // Attestation is a lifecycle guard; setup should not fail solely because
    // the auxiliary disappearance evidence could not be refreshed.
  }
  assertHost?.();
}

export function captureWorkspacePreparationGuard(guard?: WorkspaceStateGuard) {
  return (
    guard && {
      ...guard,
      recoveryHoldPredicate: structuredClone(guard.recoveryHoldPredicate),
    }
  );
}
