import { isDeepStrictEqual } from "node:util";
import { captureWorktreeRegistryReadGuard } from "../agents/worktrees/registry-read.js";
import { captureWorktreeRunEndContext } from "../agents/worktrees/run-end-lifecycle.js";
import type { managedWorktrees } from "../agents/worktrees/service.js";
import type { ManagedWorktreeRecord } from "../agents/worktrees/types.js";
import { retainPreparedSessionEntryPredicate } from "../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import {
  captureSessionActorStorageOwner,
  readCapturedSessionActorEntry,
} from "../config/sessions/session-actor-storage-binding.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import { captureSessionTranscriptTargetBinding } from "../config/sessions/transcript-target-binding.js";
import { withSessionTranscriptWriteAssertion } from "../config/sessions/transcript-write-context.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runExclusiveSessionLifecycleMutation } from "../sessions/session-lifecycle-admission.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../state/openclaw-agent-db-resources.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { DEVICE_FOLDER_MANIFEST_REF } from "../worker/device-folder.js";
import { captureSessionMutationRouting } from "./session-sharing-preparation.js";
import { findCanonicalStoreMatch } from "./session-utils-store-selection.js";
import type { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";
import type * as sessionUtils from "./session-utils.js";
import type { WithPreparedWorkerWorkspaceRecovery } from "./worker-environments/placement-reclaim-contract.js";
import type {
  WorkerPlacementExecutionMode,
  WorkerSessionPlacementIdentity,
} from "./worker-environments/placement-record.js";
import type * as placementSessionRuntimePreparation from "./worker-environments/placement-session-runtime-preparation.js";
import type * as placementSessionRuntime from "./worker-environments/placement-session-runtime.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import type { WorkerSessionWorkspace } from "./worker-environments/session-workspace.js";
import { prepareWorkerTurnTranscriptSource } from "./worker-environments/worker-turn-transcript-target.js";
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
  resolveGatewaySessionStoreTargetInWorker: typeof resolveGatewaySessionStoreTargetInWorker;
};

export async function resolveWorkerPlacementSessionStoreTarget(
  runtime: WorkerPlacementSessionRuntime,
  cfg: OpenClawConfig,
  identity: Pick<WorkerSessionPlacementIdentity, "sessionKey" | "agentId">,
  onSelected?: Parameters<typeof resolveGatewaySessionStoreTargetInWorker>[0]["onSelected"],
): ReturnType<typeof resolveGatewaySessionStoreTargetInWorker> {
  const memory = captureSessionActorStorageOwner(identity, { assertCurrent() {}, authorize() {} });
  if (memory) {
    const entry = readCapturedSessionActorEntry(memory, identity.sessionKey);
    return {
      agentId: memory.agentId,
      storePath: memory.path,
      canonicalKey: identity.sessionKey,
      storeKeys: [identity.sessionKey],
      store: entry ? { [identity.sessionKey]: entry } : {},
    };
  }
  return runtime.resolveGatewaySessionStoreTargetInWorker({
    cfg,
    key: identity.sessionKey,
    agentId: identity.agentId,
    projection: "full",
    preserveQualifiedAddress: true,
    onSelected,
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
    using resolved = await resolveWorkerPlacementSessionTarget({
      sessionRuntime,
      config: options.getConfig(),
      ...identity,
      errorMessage: `Session ${identity.sessionKey} changed before workspace recovery`,
    });
    assertOwnerCurrent();
    resolved.assertCurrent(options.getConfig());
    const { target, entry, workspace } = resolved;
    const memory = captureSessionActorStorageOwner(
      { ...identity, storePath: target.storePath },
      { assertCurrent: assertOwnerCurrent, authorize: assertOwnerCurrent },
    );
    if (memory) {
      const transcriptTarget = {
        ...captureSessionTranscriptTargetBinding({ ...identity, storePath: memory.path }),
        expectedLifecycleRevision: entry.lifecycleRevision,
        expectedWriterRunId: entry.activeWriterRunId,
      };
      const assertCurrent = () => {
        assertOwnerCurrent();
        resolved.assertCurrent(options.getConfig());
        if (
          readCapturedSessionActorEntry(memory, identity.sessionKey)?.activeWriterRunId !==
          entry.activeWriterRunId
        ) {
          throw new WorkerDispatchTargetChangedError("Workspace recovery writer changed");
        }
      };
      return await withSessionTranscriptWriteAssertion(transcriptTarget, assertCurrent, () =>
        run({
          workspace,
          assertCurrent,
          ...createWorkerWorkspaceConflictTranscriptHandlers(transcriptTarget, assertCurrent),
        }),
      );
    }
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
    const transcriptTarget = {
      ...binding,
      expectedLifecycleRevision: entry.lifecycleRevision,
      expectedWriterRunId: entry.activeWriterRunId,
    };
    await using source = await prepareWorkerTurnTranscriptSource(
      {
        ...identity,
        storePath: target.readSource.path,
        expectedLifecycleRevision: entry.lifecycleRevision,
        expectedWriterRunId: entry.activeWriterRunId,
      },
      {
        fields: ["sessionId", "lifecycleRevision", "activeWriterRunId"],
        expected: entry,
        refuse: () => {
          throw new WorkerDispatchTargetChangedError("Workspace recovery session owner changed");
        },
      },
    );
    const assertCurrent = composeSessionSourceAssertion([source], (assertSources) => {
      assertOwnerCurrent();
      // Recovery may commit its own repository-to-worktree binding while retaining this session writer.
      assertSources();
    });
    assertCurrent();
    return await withSessionTranscriptWriteAssertion(transcriptTarget, assertCurrent, () =>
      run({
        workspace,
        assertCurrent,
        ...createWorkerWorkspaceConflictTranscriptHandlers(transcriptTarget, assertCurrent),
      }),
    );
  };
}

const runtimeEntryFields = [
  "sessionId",
  "lifecycleRevision",
  "providerOverride",
  "modelOverride",
  "modelOverrideSource",
  "modelOverrideRouteResolution",
  "modelOverrideFallbackOriginProvider",
  "modelOverrideFallbackOriginModel",
  "parentSessionKey",
  "previousSessionId",
  "agentHarnessId",
  "modelSelectionLocked",
  "pluginOwnerId",
  "agentRuntimeOverride",
  "authProfileOverride",
] as const satisfies readonly (keyof InternalSessionEntry)[];

export async function runWorkerPlacementSessionBarrier<T>(params: {
  sessionRuntime: WorkerPlacementSessionRuntime &
    Pick<typeof placementSessionRuntime, "resolveWorkerPlacementExecutionMode"> &
    Pick<typeof placementSessionRuntimePreparation, "prepareWorkerPlacementSessionRuntime">;
  getConfig: () => OpenClawConfig;
  sessionId: string;
  sessionKey: string;
  agentId: string;
  executionMode: WorkerPlacementExecutionMode;
  action: "activation" | "recovery";
  signal?: AbortSignal;
  run: (workspace: WorkerSessionWorkspace, assertCurrent: () => void) => T | Promise<T>;
}): Promise<T> {
  const target = await resolveWorkerPlacementSessionStoreTarget(
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
      using resolved = await resolveWorkerPlacementSessionTarget({
        sessionRuntime: params.sessionRuntime,
        config: params.getConfig(),
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        expectedTarget: target,
        entryMatches: (before, after) =>
          before && after
            ? runtimeEntryFields.every((field) => isDeepStrictEqual(before[field], after[field]))
            : before === after,
        errorMessage: `Session ${params.sessionKey} changed before cloud worker ${params.action}. Retry.`,
      });
      const { target: currentTarget, entry, workspace, assertCurrent } = resolved;
      params.signal?.throwIfAborted();
      assertCurrent(params.getConfig());
      if (entry.archivedAt !== undefined) {
        throw new WorkerDispatchTargetChangedError(
          `Session ${params.sessionKey} was archived before cloud worker ${params.action}. Retry.`,
        );
      }
      using runtime = await params.sessionRuntime.prepareWorkerPlacementSessionRuntime({
        cfg: params.getConfig(),
        entry,
        agentId: currentTarget.agentId,
        sessionKey: currentTarget.canonicalKey,
        initialTarget: currentTarget,
      });
      const assertPlacementCurrent = () => {
        params.signal?.throwIfAborted();
        const config = params.getConfig();
        assertCurrent(config);
        const currentRuntime = runtime.read(config, entry);
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
  expectedTarget?: Awaited<ReturnType<typeof resolveGatewaySessionStoreTargetInWorker>>;
  expectedEntry?: Pick<
    InternalSessionEntry,
    "lifecycleRevision" | "worktree" | "repositoryWorkspaceId" | "deviceFolder"
  >;
  entryMatches?: (
    before: InternalSessionEntry | undefined,
    after: InternalSessionEntry | undefined,
  ) => boolean;
  errorMessage: string;
  readTarget?: (
    cfg: OpenClawConfig,
  ) => Awaited<ReturnType<typeof resolveGatewaySessionStoreTargetInWorker>>;
}) {
  const memory = captureSessionActorStorageOwner(params, { assertCurrent() {}, authorize() {} });
  const worktreeContext = captureWorktreeRunEndContext(process.env);
  const targetChangedError = () =>
    params.expectedTarget
      ? new WorkerDispatchTargetChangedError(params.errorMessage)
      : new Error(params.errorMessage);
  const assertRoutingCurrent = captureSessionMutationRouting(params.config, targetChangedError, [
    { ...params, preserveQualifiedAddress: true },
  ]);
  let active = true;
  let retained: ReturnType<typeof retainPreparedSessionEntryPredicate> | undefined;
  let unregister = () => {};
  const release = () => {
    if (!active) {
      return;
    }
    active = false;
    retained?.release();
    unregister();
  };
  const retainTarget = (
    target: Awaited<ReturnType<typeof resolveGatewaySessionStoreTargetInWorker>>,
  ) => {
    const selected = findCanonicalStoreMatch(target.store, target.storeKeys);
    if (!selected || !target.capturedReadSource) {
      return;
    }
    const source = target.capturedReadSource;
    if (typeof source.databaseIdentity !== "string") {
      throw targetChangedError();
    }
    retained = retainPreparedSessionEntryPredicate({
      databaseIdentity: `file:${source.databaseIdentity}`,
      sessionKey: selected.key,
      entry: selected.entry,
      matches: (before, after) =>
        before?.sessionId === after?.sessionId &&
        before?.lifecycleRevision === after?.lifecycleRevision &&
        before?.archivedAt === after?.archivedAt &&
        before?.worktree?.id === after?.worktree?.id &&
        before?.repositoryWorkspaceId === after?.repositoryWorkspaceId &&
        before?.deviceFolder?.deviceId === after?.deviceFolder?.deviceId &&
        before?.deviceFolder?.path === after?.deviceFolder?.path &&
        (params.entryMatches?.(before, after) ?? true),
    });
    unregister = registerOpenClawAgentDatabaseAsyncResource({
      agentId: source.agentId,
      path: source.path,
      revoke: release,
      close: async () => release(),
    });
  };
  try {
    const resolveTarget = (cfg: OpenClawConfig) =>
      params.readTarget?.(cfg) ??
      resolveWorkerPlacementSessionStoreTarget(params.sessionRuntime, cfg, params, retainTarget);
    const initialTarget = await resolveTarget(params.config);
    const initialEntry: InternalSessionEntry | undefined = memory
      ? readCapturedSessionActorEntry(memory, params.sessionKey)
      : params.sessionRuntime.resolveCanonicalSessionEntryFromStoreKeys(
          initialTarget.store,
          initialTarget.storeKeys,
        );
    const expected = params.expectedTarget ?? initialTarget;
    if (
      initialTarget.storePath !== expected.storePath ||
      initialTarget.canonicalKey !== expected.canonicalKey ||
      initialTarget.agentId !== expected.agentId ||
      !initialEntry ||
      initialEntry.sessionId !== params.sessionId ||
      (params.expectedEntry !== undefined &&
        (initialEntry.lifecycleRevision !== params.expectedEntry.lifecycleRevision ||
          initialEntry.worktree?.id !== params.expectedEntry.worktree?.id ||
          initialEntry.repositoryWorkspaceId !== params.expectedEntry.repositoryWorkspaceId ||
          initialEntry.deviceFolder?.deviceId !== params.expectedEntry.deviceFolder?.deviceId ||
          initialEntry.deviceFolder?.path !== params.expectedEntry.deviceFolder?.path))
    ) {
      throw targetChangedError();
    }
    if (!memory && !params.readTarget && !retained) {
      throw targetChangedError();
    }
    const initialIdentity = {
      lifecycleRevision: initialEntry.lifecycleRevision,
      archivedAt: initialEntry.archivedAt,
      worktreeId: initialEntry.worktree?.id,
      repositoryWorkspaceId: initialEntry.repositoryWorkspaceId,
      deviceFolder: initialEntry.deviceFolder,
    };
    const acceptWorktree = captureWorktreeRegistryReadGuard(worktreeContext, "source-owner");
    const worktree =
      initialIdentity.repositoryWorkspaceId || initialIdentity.deviceFolder
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
      assertRoutingCurrent(config);
      if (!active || retained?.isCurrent() === false) {
        throw targetChangedError();
      }
      const target = memory ? initialTarget : (params.readTarget?.(config) ?? initialTarget);
      const entry: InternalSessionEntry | undefined = memory
        ? readCapturedSessionActorEntry(memory, params.sessionKey)
        : params.sessionRuntime.resolveCanonicalSessionEntryFromStoreKeys(
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
        entry.repositoryWorkspaceId !== initialIdentity.repositoryWorkspaceId ||
        entry.deviceFolder?.deviceId !== initialIdentity.deviceFolder?.deviceId ||
        entry.deviceFolder?.path !== initialIdentity.deviceFolder?.path
      ) {
        throw targetChangedError();
      }
      if (entry.deviceFolder) {
        if (entry.worktree || entry.repositoryWorkspaceId) {
          throw targetChangedError();
        }
        return {
          config,
          target,
          entry,
          worktree: undefined,
          workspace: {
            kind: "device-folder",
            ...entry.deviceFolder,
          } satisfies WorkerSessionWorkspace,
        };
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
      [Symbol.dispose]: release,
    };
  } catch (error) {
    release();
    throw error;
  }
}

export const loadWorkerPlacementSessionRuntimeModule = createLazyRuntimeModule(async () => {
  const [placementSessionRuntime, runtimePreparation, { managedWorktrees }, sessionUtils] =
    await Promise.all([
      import("./worker-environments/placement-session-runtime.js"),
      import("./worker-environments/placement-session-runtime-preparation.js"),
      import("../agents/worktrees/service.js"),
      import("./session-utils.js"),
    ]);
  return {
    resolveWorkerPlacementExecutionMode:
      placementSessionRuntime.resolveWorkerPlacementExecutionMode,
    resolveWorkerPlacementCapabilities: placementSessionRuntime.resolveWorkerPlacementCapabilities,
    managedWorktrees,
    prepareWorkerPlacementSessionRuntime: runtimePreparation.prepareWorkerPlacementSessionRuntime,
    resolveWorkerPlacementSessionRuntimeAsync:
      placementSessionRuntime.resolveWorkerPlacementSessionRuntimeAsync,
    resolveCanonicalSessionEntryFromStoreKeys:
      sessionUtils.resolveCanonicalSessionEntryFromStoreKeys,
    resolveGatewaySessionStoreTargetInWorker: sessionUtils.resolveGatewaySessionStoreTargetInWorker,
  };
});

export function createWorkerPlacementNodeWorkspaceBindingResolver(options: {
  placements: Pick<WorkerSessionPlacementStore, "get" | "getAsync">;
  resolveWorkspace: (identity: WorkerSessionPlacementIdentity) => Promise<WorkerSessionWorkspace>;
}) {
  type Binding = { environmentId: string; ownerEpoch: number; sessionId: string };
  const readPlacement = async (binding: Binding) => {
    const placement = await options.placements.getAsync(binding.sessionId);
    return placement &&
      (placement.state === "active" ||
        placement.state === "draining" ||
        placement.state === "reconciling") &&
      placement.environmentId === binding.environmentId &&
      placement.activeOwnerEpoch === binding.ownerEpoch
      ? placement
      : undefined;
  };
  const resolve = async (binding: Binding) => {
    const placement = await readPlacement(binding);
    if (!placement) {
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
    if (
      (workspace.kind === "device-folder") !==
      (placement.workspaceBaseManifestRef === DEVICE_FOLDER_MANIFEST_REF)
    ) {
      throw new Error("Placement workspace kind does not match the durable session folder binding");
    }
    return {
      source:
        workspace.kind === "device-folder"
          ? { kind: "device-folder" as const, deviceId: workspace.deviceId, path: workspace.path }
          : workspace.kind === "local"
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
  return Object.assign(resolve, {
    async durableDeviceFolder(binding: Binding) {
      const placement = await readPlacement(binding);
      return placement?.workspaceBaseManifestRef === DEVICE_FOLDER_MANIFEST_REF
        ? placement.remoteWorkspaceDir
        : undefined;
    },
  });
}
