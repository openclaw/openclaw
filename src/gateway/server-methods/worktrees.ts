import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  buildMissingScopeErrorDetails,
  errorShape,
  missingScopeErrorShape,
  validateWorktreesBranchesParams,
  validateWorktreesCreateParams,
  validateWorktreesGcParams,
  validateWorktreesListParams,
  validateWorktreesRecoverRemovalParams,
  validateWorktreesRemoveParams,
  validateWorktreesRestoreParams,
  validateWorktreesRetireSnapshotParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { managedWorktrees, WorktreeSnapshotError } from "../../agents/worktrees/service.js";
import type { ManagedWorktreeService } from "../../agents/worktrees/service.js";
import type { ManagedWorktreeRecord } from "../../agents/worktrees/types.js";
import { resolveRecordedProjectRoot } from "../../projects/project-registry.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { requestGatewayWorktreeMaintenance } from "../worktree-maintenance.js";
import { captureLocalStateMutationGuard } from "./local-state-owner.js";
import type { GatewayRequestHandlers } from "./types.js";
import { resolveWorkspacePathContainment } from "./workspace-path-containment.js";

type WorktreeService = Pick<
  ManagedWorktreeService,
  | "create"
  | "list"
  | "listRegistryRecords"
  | "listRepositoryBranches"
  | "recoverRemoval"
  | "remove"
  | "removeIfLossless"
  | "restore"
  | "retireSnapshot"
>;

function publicWorktreeRecord(
  { gcRetry: _gcRetry, ...record }: ManagedWorktreeRecord,
  qualified = false,
) {
  if (!qualified) {
    delete record.gcProtection;
  }
  return record;
}

function invalidParams(respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"]): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, "invalid worktrees parameters", {
      details: { mutationAccepted: false },
    }),
  );
}

function captureWorktreeMutationGuard(
  expectedOwnerId: string | undefined,
  opts: Parameters<GatewayRequestHandlers[string]>[0],
  target?: { path: string; identity: string },
): (() => void) | undefined | null {
  if (!expectedOwnerId) {
    return undefined;
  }
  if (!opts.client?.connect.scopes?.includes(ADMIN_SCOPE)) {
    opts.respond(
      false,
      undefined,
      errorShape(ErrorCodes.FORBIDDEN, `missing scope: ${ADMIN_SCOPE}`, {
        details: {
          ...buildMissingScopeErrorDetails({
            missingScope: ADMIN_SCOPE,
            requiredScopes: [ADMIN_SCOPE],
          }),
          mutationAccepted: false,
        },
      }),
    );
    return null;
  }
  try {
    return captureLocalStateMutationGuard(expectedOwnerId, opts, target);
  } catch (error) {
    opts.respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, String(error), {
        details: { reason: "STATE_OWNER_CHANGED", mutationAccepted: false },
        retryable: false,
      }),
    );
    return null;
  }
}

async function resolveAuthorizedRepoRoot(
  repoRoot: string,
  opts: Parameters<GatewayRequestHandlers[string]>[0],
): Promise<string | undefined> {
  const scopes = Array.isArray(opts.client?.connect.scopes) ? opts.client.connect.scopes : [];
  if (scopes.includes(ADMIN_SCOPE)) {
    return repoRoot;
  }
  const containment = await resolveWorkspacePathContainment(
    repoRoot,
    opts.context.getRuntimeConfig(),
  );
  // A stored project row authorizes its canonical repo root for write-scoped clients.
  const authorizedRoot = containment?.path ?? (await resolveRecordedProjectRoot(repoRoot));
  if (authorizedRoot) {
    return authorizedRoot;
  }
  // Shared structured missing-scope contract (same shape as fs.listDir and
  // sessions.groups.update) so clients can distinguish an authorization denial
  // from a repository inspection failure instead of parsing prose.
  opts.respond(
    false,
    undefined,
    missingScopeErrorShape({ missingScope: ADMIN_SCOPE, requiredScopes: [ADMIN_SCOPE] }),
  );
  return undefined;
}

export function createWorktreesHandlers(service: WorktreeService): GatewayRequestHandlers {
  return {
    "worktrees.list": async ({ params, respond }) => {
      if (!validateWorktreesListParams(params)) {
        invalidParams(respond);
        return;
      }
      respond(
        true,
        { worktrees: (await service.list()).map((record) => publicWorktreeRecord(record)) },
        undefined,
      );
    },
    "worktrees.create": async (opts) => {
      const { params, respond } = opts;
      if (!validateWorktreesCreateParams(params)) {
        invalidParams(respond);
        return;
      }
      if (params.expectedRepoIdentity && !params.expectedOwnerId) {
        invalidParams(respond);
        return;
      }
      const scopes = Array.isArray(opts.client?.connect.scopes) ? opts.client.connect.scopes : [];
      const commitGuard = captureWorktreeMutationGuard(
        params.expectedOwnerId,
        opts,
        params.expectedRepoIdentity
          ? { path: params.repoRoot, identity: params.expectedRepoIdentity }
          : undefined,
      );
      if (commitGuard === null) {
        return;
      }
      let repoRoot: string | undefined;
      try {
        repoRoot = await resolveAuthorizedRepoRoot(params.repoRoot, opts);
        if (!repoRoot) {
          return;
        }
        commitGuard?.();
      } catch (error) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, String(error), {
            details: { reason: "STATE_OWNER_CHANGED", mutationAccepted: false },
            retryable: false,
          }),
        );
        return;
      }
      const record = await service.create({
        repoRoot,
        name: params.name,
        baseRef: params.baseRef,
        ...(params.profiles?.length ? { profiles: params.profiles } : {}),
        ...(commitGuard ? { commitGuard, signal: opts.signal } : {}),
        ownerKind: "manual",
        // Repository hooks and .openclaw/worktree-setup.sh execute repo code.
        runSetupScript: scopes.includes(ADMIN_SCOPE),
      });
      commitGuard?.();
      respond(true, publicWorktreeRecord(record, Boolean(params.expectedOwnerId)), undefined);
    },
    "worktrees.remove": async (opts) => {
      const { params, respond } = opts;
      if (
        !validateWorktreesRemoveParams(params) ||
        [params.force, params.ifLossless, params.exactState].filter(Boolean).length > 1
      ) {
        invalidParams(respond);
        return;
      }
      const commitGuard = captureWorktreeMutationGuard(params.expectedOwnerId, opts);
      if (commitGuard === null) {
        return;
      }
      const id = normalizeOptionalString(params.id) ?? params.id;
      const guard = commitGuard ? { commitGuard, signal: opts.signal } : {};
      try {
        if (params.ifLossless) {
          const removed = await service.removeIfLossless(id, guard);
          const cleanup = (await service.listRegistryRecords()).find(
            (record) => record.id === id,
          )?.runEndCleanup;
          commitGuard?.();
          respond(true, { removed, ...(cleanup ? { cleanup } : {}) }, undefined);
          return;
        }
        const result = await service.remove({
          id,
          reason: "manual-delete",
          allowSnapshotLoss: params.force,
          ...(params.exactState ? { exactState: params.exactState } : {}),
          ...guard,
        });
        commitGuard?.();
        respond(
          true,
          params.expectedOwnerId
            ? result
            : {
                removed: result.removed,
                ...(result.snapshotRef ? { snapshotRef: result.snapshotRef } : {}),
                ...(result.snapshotError ? { snapshotError: result.snapshotError } : {}),
              },
          undefined,
        );
      } catch (error) {
        // Snapshot failures are a structured outcome: clients decide whether
        // to retry with force instead of sniffing error strings.
        if (error instanceof WorktreeSnapshotError && !params.expectedOwnerId) {
          respond(true, { removed: false, snapshotError: error.snapshotError }, undefined);
          return;
        }
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, String(error), {
            ...(error instanceof WorktreeSnapshotError
              ? { details: { snapshotError: error.snapshotError } }
              : {}),
            retryable: false,
          }),
        );
      }
    },
    "worktrees.restore": async (opts) => {
      const { params, respond } = opts;
      if (!validateWorktreesRestoreParams(params)) {
        invalidParams(respond);
        return;
      }
      const commitGuard = captureWorktreeMutationGuard(params.expectedOwnerId, opts);
      if (commitGuard === null) {
        return;
      }
      const id = normalizeOptionalString(params.id) ?? params.id;
      const record = await service.restore({
        id,
        ...(params.recoverExactState ? { recoverExactState: params.recoverExactState } : {}),
        ...(commitGuard ? { commitGuard, signal: opts.signal } : {}),
      });
      commitGuard?.();
      respond(true, publicWorktreeRecord(record, Boolean(params.expectedOwnerId)), undefined);
    },
    "worktrees.branches": async (opts) => {
      const { params, respond } = opts;
      if (!validateWorktreesBranchesParams(params)) {
        invalidParams(respond);
        return;
      }
      const repoRoot = await resolveAuthorizedRepoRoot(params.repoRoot, opts);
      if (!repoRoot) {
        return;
      }
      const result = params.includeRepositoryStatus
        ? await service.listRepositoryBranches(repoRoot, {
            includeRepositoryStatus: true,
          })
        : await service.listRepositoryBranches(repoRoot);
      respond(true, result, undefined);
    },
    "worktrees.gc": async (opts) => {
      const { params, respond, context } = opts;
      if (!validateWorktreesGcParams(params)) {
        invalidParams(respond);
        return;
      }
      const commitGuard = captureWorktreeMutationGuard(params.expectedOwnerId, opts);
      if (commitGuard === null) {
        return;
      }
      commitGuard?.();
      const receipt = requestGatewayWorktreeMaintenance(context.getRuntimeConfig, {
        jobId: params.jobId,
        retryDeferred: params.retryDeferred,
      });
      respond(true, receipt, undefined);
    },
    "worktrees.recoverRemoval": async (opts) => {
      const { params, respond } = opts;
      if (!validateWorktreesRecoverRemovalParams(params)) {
        invalidParams(respond);
        return;
      }
      const commitGuard = captureWorktreeMutationGuard(params.expectedOwnerId, opts);
      if (!commitGuard) {
        return;
      }
      const result = await service.recoverRemoval({
        id: normalizeOptionalString(params.id) ?? params.id,
        snapshot: params.snapshot,
        commitGuard,
        signal: opts.signal,
      });
      commitGuard();
      respond(true, result, undefined);
    },
    "worktrees.retireSnapshot": async (opts) => {
      const { params, respond } = opts;
      if (!validateWorktreesRetireSnapshotParams(params)) {
        invalidParams(respond);
        return;
      }
      const commitGuard = captureWorktreeMutationGuard(params.expectedOwnerId, opts);
      if (!commitGuard) {
        return;
      }
      const { expectedOwnerId: _expectedOwnerId, ...input } = params;
      const result = await service.retireSnapshot({ ...input, commitGuard, signal: opts.signal });
      commitGuard();
      respond(true, result, undefined);
    },
  };
}

export const worktreesHandlers = createWorktreesHandlers(managedWorktrees);
