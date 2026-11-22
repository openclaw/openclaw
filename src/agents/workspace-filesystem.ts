import { getFsSafeNativeConfig, type FsSafeNativeMode } from "@openclaw/fs-safe/config";
import { hasErrnoCode } from "../infra/errno.js";
import { runFsSafeFilesystemTask } from "../infra/fs-safe-filesystem-worker.js";
import { FsSafeError } from "../infra/fs-safe.js";
import { createWorkerMutationAuthority } from "../infra/worker-mutation-authority.js";
import { decodeNativeWorkerFailure } from "../infra/worker-native-error.js";
import { SandboxStateOwnerRequiredError } from "./sandbox/state-owner-path.js";
import { createWorkspaceFileMutationGuard } from "./workspace-file-mutation-guard.js";
import type {
  LegacyWorkspaceResetResult,
  WorkspaceFilesystemMutation,
  WorkspaceFilesystemOperation,
  WorkspaceFilesystemReply,
  WorkspaceLegacyResetOperation,
} from "./workspace-filesystem.types.js";
import {
  captureWorkspaceFilesystemEvidence,
  installWorkspaceFilesystemEvidence,
} from "./workspace-state-guard.js";
import { WorkspaceAliasRepointedError } from "./workspace-state-identity.js";
import type { WorkspaceStateGuard } from "./workspace-state-store.worker-contract.js";

/** One bounded filesystem effect retains its original physical target and live host guard. */
export function runWorkspaceFilesystemOperation(
  operation: WorkspaceLegacyResetOperation,
  guard?: WorkspaceStateGuard,
  nativeMode?: FsSafeNativeMode,
): Promise<LegacyWorkspaceResetResult>;
export function runWorkspaceFilesystemOperation(
  operation: WorkspaceFilesystemMutation,
  guard?: WorkspaceStateGuard,
  nativeMode?: FsSafeNativeMode,
): Promise<boolean>;
export async function runWorkspaceFilesystemOperation(
  operation: WorkspaceFilesystemOperation,
  guard?: WorkspaceStateGuard,
  nativeMode = getFsSafeNativeConfig().mode,
): Promise<boolean | LegacyWorkspaceResetResult> {
  const legacyReset = operation.kind === "legacy-reset";
  const filesystem = legacyReset
    ? []
    : guard?.filesystem?.length
      ? [...guard.filesystem]
      : [await captureWorkspaceFilesystemEvidence(operation.dir)];
  if (!legacyReset) {
    guard?.assertHost?.();
    // Released callbacks run before dispatch, never inside a worker's live grant.
    guard?.beforeLegacyApply?.();
  }
  const assertCurrent = createWorkspaceFileMutationGuard({
    ...guard,
    beforeLegacyApply: undefined,
  })!;
  // Reset inspects missing/foreign files without authority, and reports refused
  // removals per candidate. Early/final throwing would discard that cleanup result.
  if (!legacyReset) {
    assertCurrent();
  }
  const authority = createWorkerMutationAuthority(assertCurrent);
  let reply: WorkspaceFilesystemReply;
  try {
    reply = await runFsSafeFilesystemTask(
      {
        type: "workspace",
        nativeMode,
        operation,
        filesystem,
        stateOwnerPath: guard?.stateOwnerPath,
        decision: authority.buffer,
      },
      { onNotification: authority.onNotification },
    );
    if (!legacyReset) {
      authority.throwIfRefused();
      assertCurrent();
    }
  } catch (error) {
    if (!legacyReset) {
      authority.throwIfRefused();
    }
    throw error;
  } finally {
    authority.dispose();
  }
  if (reply.type === "workspace-legacy-reset") {
    let refusal: { error: unknown } | undefined;
    try {
      authority.throwIfRefused();
    } catch (error) {
      refusal = { error };
    }
    return {
      removedPaths: reply.removedPaths,
      warnings: reply.warnings.map(
        (warning) =>
          `Could not ${warning.action} retired workspace state at ${warning.sourcePath}: ${
            warning.authorityRefused && refusal ? String(refusal.error) : warning.error
          }`,
      ),
    };
  }
  if (reply.type === "workspace-failed") {
    if (reply.alias) {
      throw new WorkspaceAliasRepointedError(reply.alias);
    }
    const error = decodeNativeWorkerFailure(reply.error);
    if (hasErrnoCode(error, "GATEWAY_STATE_OWNER_REQUIRED")) {
      throw new SandboxStateOwnerRequiredError(error instanceof Error ? error.cause : undefined);
    }
    throw reply.fsCode && error instanceof Error
      ? new FsSafeError(reply.fsCode, error.message, { cause: error.cause, details: reply.details })
      : error;
  }
  // First directory creation pins the original preparation's previously absent root.
  installWorkspaceFilesystemEvidence(filesystem, reply.filesystem);
  return reply.created;
}
