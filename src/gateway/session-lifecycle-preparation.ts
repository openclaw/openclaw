import { expectDefined } from "@openclaw/normalization-core/expect";
import type { Result } from "@openclaw/normalization-core/result";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import { prepareSessionEntryMutationDatabases } from "../config/sessions/session-accessor.entry-mutation.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { getSessionActorStorageBinding } from "../config/sessions/session-actor-storage-binding.js";
import {
  composeSessionSourceAssertion,
  sessionEntryCommitGuardOptions,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { runExclusiveSessionLifecycleMutation } from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { ADMIN_SCOPE } from "./operator-scopes.js";
import {
  loadWorkerPlacementSessionRuntimeModule,
  resolveWorkerPlacementSessionTarget,
} from "./server-worker-placement-session-target.js";
import type {
  CreateGatewaySessionParams,
  PreparedGatewaySessionLifecycle,
} from "./session-create-service.types.js";
import {
  captureSessionMutationRouting,
  prepareSessionMutationFacts,
} from "./session-sharing-preparation.js";
import type { GatewaySessionStoreTarget } from "./session-utils-store.types.js";
import { prepareSessionWorktree } from "./session-worktree-preparation.js";

/** Retain the canonical targets across asynchronous authority preparation and mutation. */
export function prepareGatewaySessionLifecycleTargets(params: {
  cfg: OpenClawConfig;
  getCurrentConfig?: () => OpenClawConfig;
  creation?: {
    ready: Promise<void>;
    assertCurrent: () => void;
    selectTargetInLifecycle?: boolean;
  };
  targets: readonly {
    target: Pick<GatewaySessionStoreTarget, "agentId" | "canonicalKey" | "storePath">;
    entry?: Pick<SessionEntry, "sessionId" | "lifecycleRevision">;
    storageReady?: Promise<{ assertCurrent(): void }>;
  }[];
}) {
  const cfg = params.cfg;
  const creationSelection = params.creation?.selectTargetInLifecycle
    ? createDeferredCore()
    : undefined;
  const assertRoutingCurrent = captureSessionMutationRouting(cfg);
  let preparedDatabase: { assertCurrent(): void } | undefined;
  const scopes = params.targets.map(({ target }) => ({
    agentId: target.agentId,
    sessionKey: target.canonicalKey,
    storePath: target.storePath,
  }));
  const creationScope = scopes[0];
  if (params.creation && !creationScope) {
    throw new Error("Session creation preparation requires its original target");
  }
  const databaseCustody =
    params.creation && creationScope
      ? prepareSessionEntryMutationDatabases(
          [
            {
              scope: creationScope,
              assertCurrent: params.creation.assertCurrent,
              relatedScopes: scopes.slice(1),
            },
          ],
          params.creation.ready,
        )
      : undefined;
  const databasePreparation = databaseCustody?.preparations[0]!.then((prepared) => {
    preparedDatabase = prepared;
  });
  const preparations = params.targets.map(async ({ target, entry, storageReady }, index) => {
    const memory = isIncognitoSessionKey(target.canonicalKey)
      ? getSessionActorStorageBinding({})
      : undefined;
    if (memory) {
      return {
        matchesCurrent() {
          memory.actor.assertCurrent();
          memory.authority.assertCurrent();
          return true;
        },
        bindCreation() {},
        release() {},
      };
    }
    let preparedStorage: { assertCurrent(): void } | undefined;
    const targetStorageReady = storageReady?.then((prepared) => {
      preparedStorage = prepared;
    });
    const selected = { ...target };
    const originalIdentity = {
      sessionId: entry?.sessionId,
      lifecycleRevision: entry?.lifecycleRevision,
    };
    const selectOnEntry = index === 0 ? creationSelection : undefined;
    if (selectOnEntry) {
      await selectOnEntry.promise;
      preparedDatabase?.assertCurrent();
    }
    const facts = await prepareSessionMutationFacts({
      cfg,
      sessionKey: selected.canonicalKey,
      agentId: selected.agentId,
      allowMissing: true,
      storageReady: targetStorageReady ?? databasePreparation,
    });
    let sessionId = originalIdentity.sessionId;
    let lifecycleRevision = originalIdentity.lifecycleRevision;
    if (selectOnEntry) {
      try {
        preparedDatabase?.assertCurrent();
        const selectedEntry = facts.readCurrent(cfg).target?.entry;
        sessionId = selectedEntry?.sessionId;
        lifecycleRevision = selectedEntry?.lifecycleRevision;
      } catch (error) {
        facts.release();
        throw error;
      }
    }
    return {
      matchesCurrent(currentConfig: OpenClawConfig) {
        preparedStorage?.assertCurrent();
        const current = facts.readCurrent(currentConfig).target;
        return (
          facts.storageTarget.agentId === selected.agentId &&
          facts.storageTarget.storePath === selected.storePath &&
          facts.storageTarget.canonicalKey === selected.canonicalKey &&
          current?.entry.sessionId === sessionId &&
          current?.entry.lifecycleRevision === lifecycleRevision &&
          (!current ||
            (current.agentId === selected.agentId &&
              current.storePath === selected.storePath &&
              current.canonicalKey === selected.canonicalKey))
        );
      },
      bindCreation: facts.bindCreation,
      release: facts.release,
    };
  });
  for (const preparation of preparations) {
    void preparation.catch(() => {});
  }
  const assertCurrent = () => {
    assertRoutingCurrent(params.getCurrentConfig?.() ?? cfg);
    preparedDatabase?.assertCurrent();
  };
  return {
    preparations,
    assertCurrent,
    async prepareCreationTargets(isCommitted: () => boolean) {
      type PreparedTarget = Awaited<(typeof preparations)[number]>;
      let child: PreparedTarget | undefined;
      if (creationSelection) {
        await databasePreparation;
      } else {
        child = await expectDefined(preparations[0], "creation target preparation");
      }
      const parents = await Promise.all(preparations.slice(1));
      const assertTargetsCurrent = () => {
        assertCurrent();
        const currentConfig = params.getCurrentConfig?.() ?? cfg;
        if (!isCommitted() && child && !child.matchesCurrent(currentConfig)) {
          throw new Error("Session changed before creation; retry.");
        }
        for (const parent of parents) {
          if (!parent.matchesCurrent(currentConfig)) {
            throw new Error("Session changed before creation; retry.");
          }
        }
      };
      const bindCreation: PreparedTarget["bindCreation"] = (operation) => {
        expectDefined(child, "selected creation target").bindCreation(operation);
      };
      return {
        assertCurrent: assertTargetsCurrent,
        bindCreation,
        async enterCreationLifecycle() {
          params.creation?.assertCurrent();
          assertTargetsCurrent();
          if (creationSelection) {
            if (!preparedDatabase) {
              throw new Error("Session creation database preparation has not completed");
            }
            preparedDatabase.assertCurrent();
            creationSelection.resolve();
            child = await expectDefined(preparations[0], "creation target preparation");
          }
          assertTargetsCurrent();
        },
      };
    },
    async [Symbol.asyncDispose]() {
      creationSelection?.reject(new Error("Session creation ended before target selection"));
      for (const result of await Promise.allSettled(preparations)) {
        if (result.status === "fulfilled") {
          result.value.release();
        }
      }
      await databasePreparation?.catch(() => {});
      await databaseCustody?.[Symbol.asyncDispose]();
    },
  };
}

export function resolveSessionCreateIncognitoIntentError(params: {
  incognito: boolean;
  parentIncognito: boolean;
  parentSessionKey: string | undefined;
  targetKey: string | undefined;
  requestingOperatorScopes: readonly string[] | undefined;
}): ErrorShape | undefined {
  if (
    params.incognito &&
    params.requestingOperatorScopes !== undefined &&
    !params.requestingOperatorScopes.includes(ADMIN_SCOPE)
  ) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      `incognito sessions require gateway scope: ${ADMIN_SCOPE}`,
    );
  }
  if (params.incognito && params.parentSessionKey && !params.parentIncognito) {
    return errorShape(ErrorCodes.INVALID_REQUEST, "incognito sessions cannot have durable parents");
  }
  if (params.parentIncognito && params.targetKey) {
    return errorShape(ErrorCodes.INVALID_REQUEST, "incognito sessions are web-only");
  }
  return undefined;
}

export function resolveSessionCreateLifecycleIntentError(
  params: Pick<
    CreateGatewaySessionParams,
    | "succeedsParent"
    | "emitCommandHooks"
    | "fork"
    | "atomicInitialization"
    | "afterCreate"
    | "initialEntry"
  >,
  parentSessionKey: string | undefined,
): ErrorShape | undefined {
  if (params.succeedsParent !== undefined) {
    if (!parentSessionKey) {
      return errorShape(ErrorCodes.INVALID_REQUEST, "succeedsParent requires parentSessionKey");
    }
    if (params.emitCommandHooks !== true) {
      return errorShape(ErrorCodes.INVALID_REQUEST, "succeedsParent requires emitCommandHooks");
    }
    if (params.succeedsParent && params.fork === true) {
      return errorShape(
        ErrorCodes.INVALID_REQUEST,
        "succeedsParent conflicts with fork: a fork runs in parallel to its parent",
      );
    }
  }
  if (params.atomicInitialization === true && (!params.afterCreate || params.initialEntry)) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "atomic initialization requires afterCreate and cannot use trusted initial state",
    );
  }
  return undefined;
}

export function resolveSessionCreateChildIntentError(
  params: Pick<CreateGatewaySessionParams, "fork" | "forkFrom" | "spawnDepth" | "spawnToolPolicy">,
  parentSessionKey: string | undefined,
): ErrorShape | undefined {
  if (params.fork === true && !parentSessionKey) {
    return errorShape(ErrorCodes.INVALID_REQUEST, "fork requires parentSessionKey");
  }
  if (params.forkFrom && params.fork !== true) {
    return errorShape(ErrorCodes.INVALID_REQUEST, "forkFrom requires fork=true");
  }
  if (params.spawnDepth !== undefined) {
    if (!Number.isInteger(params.spawnDepth) || params.spawnDepth < 1) {
      return errorShape(ErrorCodes.INVALID_REQUEST, "spawnDepth must be an integer >= 1");
    }
    if (!parentSessionKey) {
      return errorShape(ErrorCodes.INVALID_REQUEST, "spawnDepth requires parentSessionKey");
    }
  }
  if (params.spawnToolPolicy && params.spawnDepth === undefined) {
    return errorShape(ErrorCodes.INVALID_REQUEST, "spawn tool policy requires spawnDepth");
  }
  return undefined;
}

/** Bind prepared workspace facts and consume setup intent only after successful preparation. */
export function projectPreparedSessionWorkspace(
  existingEntry: SessionEntry | undefined,
  params: {
    projectId?: string;
    pendingProjectGitUrl?: string;
    pendingWorktree?: SessionEntry["pendingWorktree"];
    spawnedCwd?: string;
    preparedLifecycle?: PreparedGatewaySessionLifecycle;
  },
): Partial<SessionEntry> {
  const { projectId, pendingProjectGitUrl, pendingWorktree, spawnedCwd, preparedLifecycle } =
    params;
  const createdNewEntry = existingEntry === undefined;
  const recovered =
    preparedLifecycle?.worktree &&
    (existingEntry?.pendingWorktree || existingEntry?.pendingProjectGitUrl);
  return {
    ...(createdNewEntry && projectId ? { projectId } : {}),
    ...(createdNewEntry && pendingProjectGitUrl ? { pendingProjectGitUrl } : {}),
    ...(createdNewEntry && pendingWorktree ? { pendingWorktree } : {}),
    // Creation owns cwd adoption; public patching does not grant this authority.
    ...(spawnedCwd ? { spawnedCwd } : {}),
    ...(preparedLifecycle?.worktree ? { worktree: preparedLifecycle.worktree } : {}),
    ...(preparedLifecycle?.repositoryWorkspaceId
      ? { repositoryWorkspaceId: preparedLifecycle.repositoryWorkspaceId }
      : {}),
    ...(recovered
      ? { projectId, pendingWorktree: undefined, pendingProjectGitUrl: undefined }
      : {}),
  };
}

/** Join recorded commit actions even when the enclosing source scope fails during cleanup. */
export async function settleGatewaySessionLifecycleCommit<T>(
  commit: Promise<T>,
  afterCommit: readonly (() => void | Promise<void>)[],
): Promise<T> {
  const result: Result<T, unknown> = await commit.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
  const failures: unknown[] = result.ok ? [] : [result.error];
  for (const action of afterCommit) {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Session reset commit and post-commit actions failed", {
      cause: failures.at(-1),
    });
  }
  if (!result.ok) {
    throw result.error;
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  return result.value;
}

export async function rollbackGatewaySessionPreparation(params: {
  onError?: (error: unknown) => void;
  prepared?: PreparedGatewaySessionLifecycle;
}): Promise<void> {
  try {
    await params.prepared?.rollback?.();
  } catch (error) {
    params.onError?.(error);
  }
}

/** Publish accepted workspace ownership before releasing preparation; roll back only unbound work. */
export async function commitPreparedSessionWorkspace(params: {
  prepared: PreparedGatewaySessionLifecycle;
  target: { agentId: string; sessionKey: string; storePath: string };
  assertCurrent: SessionSourceAssertion;
  assertEntry: (entry: SessionEntry) => void;
  projectId?: string;
  clearPendingIntent?: boolean;
  onCommitted?: () => void;
  missingSessionMessage: string;
}): Promise<SessionEntry> {
  const { prepared } = params;
  const bind = async (assertSourceCurrent: SessionSourceAssertion) => {
    const assertCurrent = composeSessionSourceAssertion([
      params.assertCurrent,
      assertSourceCurrent,
    ]);
    return await patchSessionEntryCore(
      params.target,
      (entry) => {
        assertCurrent();
        params.assertEntry(entry);
        return {
          ...(params.projectId ? { projectId: params.projectId } : {}),
          sessionRoot: prepared.sessionRoot,
          spawnedCwd: prepared.spawnedCwd,
          ...(prepared.worktree ? { worktree: prepared.worktree } : {}),
          ...(params.clearPendingIntent
            ? { pendingProjectGitUrl: undefined, pendingWorktree: undefined }
            : {}),
        };
      },
      {
        ...sessionEntryCommitGuardOptions(assertCurrent),
        requireWriteSuccess: true,
        skipMaintenance: true,
        onCommitted: params.onCommitted,
      },
    );
  };
  try {
    const entry = prepared.withCommit ? await prepared.withCommit(bind) : await bind(() => {});
    if (!entry) {
      throw new Error(params.missingSessionMessage);
    }
    return entry;
  } catch (error) {
    await prepared.rollback?.();
    throw error;
  }
}

/** Adopt only a session-owned workspace; never replace an accepted external source. */
export async function ensureSessionWorkspaceForPlacement(params: {
  cfg: OpenClawConfig;
  target: { agentId: string; canonicalKey: string; storePath: string; storeKeys: string[] };
  entry: SessionEntry;
  assertCurrent: SessionSourceAssertion;
  signal?: AbortSignal;
  onCommitted?: () => void;
  canPrepare: () => boolean;
}): Promise<void> {
  const { target, entry } = params;
  await runExclusiveSessionLifecycleMutation("placement-dispatch", {
    scope: target.storePath,
    identities: [target.canonicalKey, entry.sessionId, ...target.storeKeys],
    signal: params.signal,
    run: async () => {
      params.assertCurrent();
      if (!params.canPrepare()) {
        return;
      }
      if (entry.worktree || entry.repositoryWorkspaceId) {
        await resolveWorkerPlacementSessionTarget({
          sessionRuntime: await loadWorkerPlacementSessionRuntimeModule(),
          config: params.cfg,
          sessionId: entry.sessionId,
          sessionKey: target.canonicalKey,
          agentId: target.agentId,
          readTarget: () => {
            params.assertCurrent();
            return { ...target, store: { [target.canonicalKey]: entry } };
          },
          errorMessage: "The session workspace owner is unavailable; repair it before retrying.",
        });
        params.assertCurrent();
        return;
      }
      if (entry.pendingWorktree || entry.pendingProjectGitUrl) {
        throw new Error("The session workspace must finish preparation before worker setup.");
      }
      if (entry.spawnedCwd || entry.projectId || entry.sessionRoot) {
        throw new Error(
          "Worker execution needs a session-owned workspace; create a managed-workspace session rather than dropping the current workspace.",
        );
      }
      const prepared = await prepareSessionWorktree({
        cfg: params.cfg,
        target: { ...target, key: target.canonicalKey, entry },
        workspace: { kind: "empty" },
        runSetupScript: false,
        signal: params.signal,
        commitGuard: params.assertCurrent,
      });
      if (!prepared.ok) {
        throw new Error(prepared.error.message);
      }
      const bound = await commitPreparedSessionWorkspace({
        prepared: prepared.value,
        onCommitted: params.onCommitted,
        target: { ...target, sessionKey: target.canonicalKey },
        assertCurrent: params.assertCurrent,
        assertEntry: (saved) => {
          if (
            saved.sessionId !== entry.sessionId ||
            saved.worktree ||
            saved.repositoryWorkspaceId ||
            saved.sessionRoot ||
            saved.spawnedCwd ||
            saved.pendingWorktree ||
            saved.pendingProjectGitUrl
          ) {
            throw new Error("Session workspace changed during worker setup.");
          }
        },
        missingSessionMessage: "Session disappeared during worker setup.",
      });
      Object.assign(entry, bound);
    },
  });
}
