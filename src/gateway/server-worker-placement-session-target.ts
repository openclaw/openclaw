import { captureWorktreeRegistryReadGuard } from "../agents/worktrees/registry-read.js";
import { captureWorktreeRunEndContext } from "../agents/worktrees/run-end-lifecycle.js";
import type { managedWorktrees } from "../agents/worktrees/service.js";
import type { ManagedWorktreeRecord } from "../agents/worktrees/types.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { createSessionEntryRevisionGuard } from "../config/sessions/session-accessor.sqlite-entry-revision.js";
import { createSessionTranscriptOwnerPredicate } from "../config/sessions/session-accessor.sqlite-transcript-write-guard.js";
import { readSessionEntriesFromStoreInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { captureSessionTranscriptTargetBinding } from "../config/sessions/transcript-target-binding.js";
import { withSessionTranscriptWriteAssertion } from "../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runExclusiveSessionLifecycleMutation } from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { isOpenClawAgentDatabasePathCurrent } from "../state/openclaw-agent-db-identity.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../state/openclaw-agent-db-resources.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import type * as sessionUtils from "./session-utils.js";
import type { WithPreparedWorkerWorkspaceRecovery } from "./worker-environments/placement-reclaim-contract.js";
import type {
  WorkerPlacementExecutionMode,
  WorkerSessionPlacementIdentity,
} from "./worker-environments/placement-record.js";
import type * as placementSessionRuntime from "./worker-environments/placement-session-runtime.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import type { WorkerSessionWorkspace } from "./worker-environments/session-workspace.js";
import { createWorkerWorkspaceConflictTranscriptHandlers } from "./worker-workspace-conflict-transcript.js";

export class WorkerDispatchTargetChangedError extends Error {
  readonly code = "invalid_state";
}

export type WorkerPlacementSessionRuntime = {
  managedWorktrees: {
    findLiveByOwner: (
      ...args: Parameters<typeof managedWorktrees.findLiveByOwner>
    ) => Promise<Pick<ManagedWorktreeRecord, "id" | "ownerId" | "path"> | undefined>;
  };
  resolveCanonicalSessionEntryFromStoreKeys: typeof sessionUtils.resolveCanonicalSessionEntryFromStoreKeys;
  resolveGatewaySessionStoreTargetWithStore: typeof sessionUtils.resolveGatewaySessionStoreTargetWithStore;
};

export function resolveWorkerPlacementSessionStoreTarget(
  runtime: WorkerPlacementSessionRuntime,
  cfg: OpenClawConfig,
  identity: Pick<WorkerSessionPlacementIdentity, "sessionKey" | "agentId">,
) {
  return runtime.resolveGatewaySessionStoreTargetWithStore({
    cfg,
    key: identity.sessionKey,
    agentId: identity.agentId,
    preserveQualifiedAddress: true,
    clone: false,
    exactRead: true,
  });
}

export function createWorkerWorkspaceRecoveryPreparer(options: {
  loadSessionRuntime: () => Promise<WorkerPlacementSessionRuntime>;
  getConfig: () => OpenClawConfig;
}): WithPreparedWorkerWorkspaceRecovery {
  return async (identity, assertOwnerCurrent, run) => {
    assertOwnerCurrent();
    const sessionRuntime = await options.loadSessionRuntime();
    assertOwnerCurrent();
    const resolved = await resolveWorkerPlacementSessionTarget({
      sessionRuntime,
      config: options.getConfig(),
      ...identity,
      errorMessage: `Session ${identity.sessionKey} changed before workspace recovery`,
    });
    assertOwnerCurrent();
    resolved.assertCurrent(options.getConfig());
    const { target, entry, workspace } = resolved;
    if (
      target.agentId !== identity.agentId ||
      target.canonicalKey !== identity.sessionKey ||
      !target.readSource
    ) {
      throw new WorkerDispatchTargetChangedError(
        "Workspace recovery lost its exact session target",
      );
    }
    const binding = {
      ...captureSessionTranscriptTargetBinding({ ...identity, storePath: target.readSource.path }),
      defaultAgentId: target.readSource.agentId,
    };
    const retained = retainOpenClawAgentDatabaseReadOnly(target.readSource);
    if (!retained.found) {
      throw new WorkerDispatchTargetChangedError("Workspace recovery session store is unavailable");
    }
    let released = false;
    const completion = createDeferredCore();
    const controller = new AbortController();
    let unregister = () => {};
    const assertSourceCurrent = () => {
      controller.signal.throwIfAborted();
      assertOwnerCurrent();
      if (
        released ||
        !retained.claim.isCurrent() ||
        !isOpenClawAgentDatabasePathCurrent(retained.database)
      ) {
        throw new WorkerDispatchTargetChangedError("Workspace recovery session source changed");
      }
    };
    try {
      unregister = registerOpenClawAgentDatabaseAsyncResource({
        agentId: retained.database.agentId,
        path: retained.database.path,
        revoke: () =>
          controller.abort(new WorkerDispatchTargetChangedError("Workspace recovery was revoked")),
        close: () => completion.promise,
      });
      const prepared = await readSessionEntriesFromStoreInWorker({
        agentId: target.readSource.agentId,
        storePath: target.readSource.path,
        env: binding.env,
        sessionKeys: [identity.sessionKey],
        snapshotFields: [],
      });
      assertSourceCurrent();
      const preparedEntry = prepared.entries.find(
        (candidate) => candidate.sessionKey === identity.sessionKey,
      )?.entry;
      if (
        preparedEntry?.sessionId !== identity.sessionId ||
        preparedEntry.lifecycleRevision !== entry.lifecycleRevision
      ) {
        throw new WorkerDispatchTargetChangedError("Workspace recovery session generation changed");
      }
      const transcriptTarget = {
        ...binding,
        expectedLifecycleRevision: preparedEntry.lifecycleRevision,
        expectedWriterRunId: preparedEntry.activeWriterRunId,
      };
      const assertCurrent = createSessionEntryRevisionGuard(
        retained.database.db,
        assertSourceCurrent,
        createSessionTranscriptOwnerPredicate(retained.database, {
          sessionKey: identity.sessionKey,
          sessionId: identity.sessionId,
          lifecycleRevision: preparedEntry.lifecycleRevision,
          activeWriterRunId: preparedEntry.activeWriterRunId,
        }),
        "read",
      );
      assertCurrent();
      resolved.assertCurrent(options.getConfig());
      // A new recovery owns the current target; callbacks cannot select a later route.
      return await withSessionTranscriptWriteAssertion(transcriptTarget, assertCurrent, () =>
        run({
          workspace,
          assertCurrent,
          ...createWorkerWorkspaceConflictTranscriptHandlers(transcriptTarget, assertCurrent),
        }),
      );
    } finally {
      released = true;
      unregister();
      retained.claim.release();
      completion.resolve();
    }
  };
}

export async function runWorkerPlacementSessionBarrier<T>(params: {
  sessionRuntime: WorkerPlacementSessionRuntime &
    Pick<
      typeof placementSessionRuntime,
      "resolveWorkerPlacementExecutionMode" | "resolveWorkerPlacementSessionRuntime"
    >;
  getConfig: () => OpenClawConfig;
  sessionId: string;
  sessionKey: string;
  agentId: string;
  executionMode: WorkerPlacementExecutionMode;
  action: "activation" | "recovery";
  signal?: AbortSignal;
  run: (workspace: WorkerSessionWorkspace, assertCurrent: () => void) => T | Promise<T>;
}): Promise<T> {
  const target = resolveWorkerPlacementSessionStoreTarget(
    params.sessionRuntime,
    params.getConfig(),
    params,
  );
  const operation = params.action === "activation" ? "placement-activate" : "placement-recover";
  return await runExclusiveSessionLifecycleMutation(operation, {
    scope: target.storePath,
    identities: [params.sessionKey, target.canonicalKey, ...target.storeKeys, params.sessionId],
    signal: params.signal,
    run: async () => {
      const {
        target: currentTarget,
        entry,
        workspace,
        assertCurrent,
      } = await resolveWorkerPlacementSessionTarget({
        sessionRuntime: params.sessionRuntime,
        config: params.getConfig(),
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        expectedTarget: target,
        errorMessage: `Session ${params.sessionKey} changed before cloud worker ${params.action}. Retry.`,
      });
      params.signal?.throwIfAborted();
      assertCurrent(params.getConfig());
      if (entry.archivedAt !== undefined) {
        throw new WorkerDispatchTargetChangedError(
          `Session ${params.sessionKey} was archived before cloud worker ${params.action}. Retry.`,
        );
      }
      const assertPlacementCurrent = () => {
        params.signal?.throwIfAborted();
        const config = params.getConfig();
        assertCurrent(config);
        const currentRuntime = params.sessionRuntime.resolveWorkerPlacementSessionRuntime({
          cfg: config,
          entry,
          agentId: currentTarget.agentId,
          sessionKey: currentTarget.canonicalKey,
        });
        if (
          params.sessionRuntime.resolveWorkerPlacementExecutionMode(currentRuntime) !==
          params.executionMode
        ) {
          throw new WorkerDispatchTargetChangedError(
            `Session ${params.sessionKey} runtime changed to ${currentRuntime} before cloud worker ${params.action}. Retry.`,
          );
        }
      };
      assertPlacementCurrent();
      return await params.run(workspace, assertPlacementCurrent);
    },
  });
}

/** Keep canonical session identity and its durable workspace owner in one lifecycle fence. */
export async function resolveWorkerPlacementSessionTarget(params: {
  sessionRuntime: WorkerPlacementSessionRuntime;
  config: OpenClawConfig;
  sessionId: string;
  sessionKey: string;
  agentId: string;
  expectedTarget?: ReturnType<typeof sessionUtils.resolveGatewaySessionStoreTargetWithStore>;
  errorMessage: string;
}) {
  const worktreeContext = captureWorktreeRunEndContext(process.env);
  const resolveTarget = (cfg: OpenClawConfig) =>
    resolveWorkerPlacementSessionStoreTarget(params.sessionRuntime, cfg, params);
  const initialTarget = resolveTarget(params.config);
  const initialEntry = params.sessionRuntime.resolveCanonicalSessionEntryFromStoreKeys(
    initialTarget.store,
    initialTarget.storeKeys,
  );
  const expected = params.expectedTarget ?? initialTarget;
  const targetChangedError = () =>
    params.expectedTarget
      ? new WorkerDispatchTargetChangedError(params.errorMessage)
      : new Error(params.errorMessage);
  if (
    initialTarget.storePath !== expected.storePath ||
    initialTarget.canonicalKey !== expected.canonicalKey ||
    initialTarget.agentId !== expected.agentId ||
    !initialEntry ||
    initialEntry.sessionId !== params.sessionId
  ) {
    throw targetChangedError();
  }
  const initialIdentity = {
    lifecycleRevision: initialEntry.lifecycleRevision,
    archivedAt: initialEntry.archivedAt,
    worktreeId: initialEntry.worktree?.id,
    repositoryWorkspaceId: initialEntry.repositoryWorkspaceId,
  };
  const acceptWorktree = captureWorktreeRegistryReadGuard(worktreeContext, "source-owner");
  const worktree = initialIdentity.repositoryWorkspaceId
    ? undefined
    : await params.sessionRuntime.managedWorktrees.findLiveByOwner(
        "session",
        initialTarget.canonicalKey,
      );
  const assertWorktreeCurrent = acceptWorktree(
    worktree ? { ...worktree, ownerKind: "session" } : undefined,
  );
  const prepared = initialIdentity.repositoryWorkspaceId
    ? await getSessionRepositoryWorkspaceStore().prepare(initialIdentity.repositoryWorkspaceId)
    : undefined;
  const resolveBinding = (config = params.config) => {
    const target = resolveTarget(config);
    const entry = params.sessionRuntime.resolveCanonicalSessionEntryFromStoreKeys(
      target.store,
      target.storeKeys,
    );
    if (
      target.storePath !== expected.storePath ||
      target.canonicalKey !== expected.canonicalKey ||
      target.agentId !== expected.agentId ||
      !entry ||
      entry.sessionId !== params.sessionId ||
      entry.lifecycleRevision !== initialIdentity.lifecycleRevision ||
      entry.archivedAt !== initialIdentity.archivedAt ||
      entry.worktree?.id !== initialIdentity.worktreeId ||
      entry.repositoryWorkspaceId !== initialIdentity.repositoryWorkspaceId
    ) {
      throw targetChangedError();
    }
    if (entry.repositoryWorkspaceId) {
      prepared?.assertSourceCurrent();
      const repository = prepared?.workspace;
      if (
        !repository ||
        repository.workspaceId !== entry.repositoryWorkspaceId ||
        repository.agentId !== target.agentId ||
        repository.sessionKey !== target.canonicalKey ||
        entry.worktree
      ) {
        throw targetChangedError();
      }
      return {
        config,
        target,
        entry,
        worktree: undefined,
        workspace: { kind: "repository", repository } satisfies WorkerSessionWorkspace,
      };
    }
    assertWorktreeCurrent();
    if (
      !entry.worktree?.id ||
      !worktree ||
      worktree.id !== entry.worktree.id ||
      worktree.ownerId !== target.canonicalKey
    ) {
      throw targetChangedError();
    }
    return {
      config,
      target,
      entry,
      worktree,
      workspace: { kind: "local", path: worktree.path } satisfies WorkerSessionWorkspace,
    };
  };
  const resolveCurrent = (config = params.config) => {
    const selected = resolveBinding(config);
    if (
      selected.workspace.kind === "repository" &&
      prepared?.current()?.revision !== selected.workspace.repository.revision
    ) {
      throw targetChangedError();
    }
    return selected;
  };
  return {
    ...resolveCurrent(),
    assertBindingCurrent: (config?: OpenClawConfig) => {
      resolveBinding(config);
    },
    assertCurrent: (config?: OpenClawConfig) => {
      resolveCurrent(config);
    },
  };
}

export const loadWorkerPlacementSessionRuntimeModule = createLazyRuntimeModule(async () => {
  const [placementSessionRuntime, { managedWorktrees }, sessionUtils] = await Promise.all([
    import("./worker-environments/placement-session-runtime.js"),
    import("../agents/worktrees/service.js"),
    import("./session-utils.js"),
  ]);
  return {
    resolveWorkerPlacementExecutionMode:
      placementSessionRuntime.resolveWorkerPlacementExecutionMode,
    resolveWorkerPlacementCapabilities: placementSessionRuntime.resolveWorkerPlacementCapabilities,
    managedWorktrees,
    resolveWorkerPlacementSessionRuntime:
      placementSessionRuntime.resolveWorkerPlacementSessionRuntime,
    resolveCanonicalSessionEntryFromStoreKeys:
      sessionUtils.resolveCanonicalSessionEntryFromStoreKeys,
    resolveGatewaySessionStoreTargetWithStore:
      sessionUtils.resolveGatewaySessionStoreTargetWithStore,
  };
});

export async function prepareWorkerPlacementRepositoryManifestRefs(
  placement: WorkerSessionPlacementIdentity,
): Promise<() => readonly string[] | null> {
  const readEntry = () =>
    loadSessionEntryReadOnly({
      ...placement,
      storePath: resolveSessionStorePathForScope(placement),
    });
  const entry = readEntry();
  if (entry?.sessionId !== placement.sessionId) {
    return () => null;
  }
  const prepared = entry.repositoryWorkspaceId
    ? await getSessionRepositoryWorkspaceStore().prepare(entry.repositoryWorkspaceId)
    : undefined;
  return () => {
    const current = readEntry();
    if (
      current?.sessionId !== placement.sessionId ||
      current.lifecycleRevision !== entry.lifecycleRevision ||
      current.repositoryWorkspaceId !== entry.repositoryWorkspaceId
    ) {
      return null;
    }
    if (!prepared) {
      return [];
    }
    try {
      const repository = prepared.current();
      // Cumulative exports still need the original checkout manifest after a turn.
      return repository?.agentId === placement.agentId &&
        repository.sessionKey === placement.sessionKey &&
        repository.baseManifestHash
        ? [repository.baseManifestHash]
        : null;
    } catch {
      // Unsettled or retired repository ownership cannot authorize manifest deletion.
      return null;
    }
  };
}

export function createWorkerPlacementNodeWorkspaceBindingResolver(options: {
  placements: Pick<WorkerSessionPlacementStore, "get" | "getAsync">;
  resolveWorkspace: (identity: WorkerSessionPlacementIdentity) => Promise<WorkerSessionWorkspace>;
}) {
  return async (binding: { environmentId: string; ownerEpoch: number; sessionId: string }) => {
    const placement = await options.placements.getAsync(binding.sessionId);
    if (
      !placement ||
      (placement.state !== "active" &&
        placement.state !== "draining" &&
        placement.state !== "reconciling") ||
      placement.environmentId !== binding.environmentId ||
      placement.activeOwnerEpoch !== binding.ownerEpoch
    ) {
      return undefined;
    }
    const workspace = await options.resolveWorkspace({
      sessionId: placement.sessionId,
      sessionKey: placement.sessionKey,
      agentId: placement.agentId,
    });
    const current = options.placements.get(binding.sessionId);
    if (
      current?.state !== placement.state ||
      current.generation !== placement.generation ||
      current.environmentId !== binding.environmentId ||
      current.activeOwnerEpoch !== binding.ownerEpoch ||
      current.sessionKey !== placement.sessionKey ||
      current.agentId !== placement.agentId ||
      current.remoteWorkspaceDir !== placement.remoteWorkspaceDir ||
      current.workspaceBaseManifestRef !== placement.workspaceBaseManifestRef
    ) {
      return undefined;
    }
    if (
      workspace.kind === "repository" &&
      (!workspace.repository.baseCommit || !workspace.repository.baseManifestHash)
    ) {
      throw new Error("Attached repository workspace has no pinned baseline");
    }
    return {
      source:
        workspace.kind === "local"
          ? { kind: "local" as const, path: workspace.path }
          : {
              kind: "repository" as const,
              baseCommit: workspace.repository.baseCommit!,
              baseManifestRef: workspace.repository.baseManifestHash!,
            },
      manifestRef: placement.workspaceBaseManifestRef,
      remoteWorkspaceDir: placement.remoteWorkspaceDir,
      sessionKey: placement.sessionKey,
    };
  };
}
