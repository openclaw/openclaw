import { isDeepStrictEqual } from "node:util";
import type { SessionGitHubReadinessResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import type { ManagedWorktreeRecord } from "../agents/worktrees/types.js";
import { readRuntimeConfig as getRuntimeConfig } from "../config/runtime-snapshot.js";
import { retainPreparedSessionEntryPredicate } from "../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import {
  captureSessionActorStorageOwner,
  readCapturedSessionActorEntry,
} from "../config/sessions/session-actor-storage-binding.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import type { SessionEntrySnapshotField } from "../config/sessions/session-entry-snapshot-values.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createStaleWhileRevalidateCache } from "../infra/stale-while-revalidate-cache.js";
import { isArtifactPreservingStateRead } from "../state/artifact-preserving-state-reads.js";
import { prepareGitHubPublicationSessionLifecycle } from "../state/github-publication-session-lifecycles.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { prepareOpenClawAgentDatabaseRegistrySnapshotRead } from "../state/openclaw-agent-db-registry-listing.js";
import { registerOpenClawAgentDatabaseReadCandidateResource } from "../state/openclaw-agent-db-resources.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import type { PreparedRepositoryWorkspace } from "../state/session-repository-workspaces.publication.js";
import {
  RepositoryPublicationFailureError,
  RepositoryPublicationWorkspaceChangedError as GitHubPublicationWorkspaceChangedError,
  RepositoryPublicationSessionChangedError as GitHubPublicationSessionChangedError,
} from "./github-publication-errors.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import type {
  PublicationSessionIdentity,
  PublicationSessionRead,
} from "./github-publication-session.types.js";
import {
  preparePublicationWorktreeRead,
  requirePublicationSessionOwner,
  type ExpectedWorktree,
  type PublicationSessionOwner,
} from "./github-publication-worktree-owner.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";
import { findCanonicalStoreMatch } from "./session-utils-store-selection.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";

// Discovery is best effort for 15 seconds; publication resolves the current Git repository again.
const repositoryOrigins = createStaleWhileRevalidateCache<string>({
  maxEntries: 256,
  maxPending: Number.POSITIVE_INFINITY,
  ttlMs: 15_000,
});

export type RepositoryPublicationSessionTarget = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  storePath?: string;
  expectedLifecycleRevision?: string;
  expectedWriterRunId?: string;
};
export type { PublicationSessionIdentity } from "./github-publication-session.types.js";

/** The selected publication metadata is invalidated by the session writer's receipts. */
export async function prepareGitHubPublicationSession(
  sessionKey: string,
  options: {
    agentId?: string;
    cfg?: OpenClawConfig;
    assertCurrent?: () => void;
    target?: RepositoryPublicationSessionTarget;
    fields?: readonly (keyof NonNullable<PublicationSessionRead["entry"]>)[];
    /** Saved snapshots a consumer compares; stored reads omit them by default. */
    projection?: readonly SessionEntrySnapshotField[];
  } = {},
) {
  const projection = options.projection ?? [];
  const fields = [
    ...(options.fields ??
      ([
        "sessionId",
        "lifecycleRevision",
        "archivedAt",
        "repositoryWorkspaceId",
        "worktree",
        "owner",
        "createdActor",
        "visibility",
        "incognito",
      ] as const)),
    ...(options.target?.expectedWriterRunId !== undefined ? (["activeWriterRunId"] as const) : []),
  ];
  let retained: ReturnType<typeof retainPreparedSessionEntryPredicate> | undefined;
  let active = true;
  let releaseSource: (() => void) | undefined;
  let assertSourcePublication: (() => void) | undefined;
  const retire = () => {
    active = false;
    retained?.release();
  };
  const scope = { sessionKey, agentId: options.agentId, storePath: options.target?.storePath };
  const assertCurrent = () => options.assertCurrent?.();
  const memory = captureSessionActorStorageOwner(scope, {
    assertCurrent,
    authorize: assertCurrent,
  });
  const readMemory =
    memory &&
    (() => ({
      canonicalKey: sessionKey,
      agentId: memory.agentId,
      storePath: memory.path,
      entry: readCapturedSessionActorEntry(memory, sessionKey),
    }));
  const retain = (
    source: CapturedSessionEntryReadSource | undefined,
    key: string,
    entry: PublicationSessionRead["entry"],
  ) => {
    if (typeof source?.databaseIdentity !== "string") {
      return;
    }
    const { path: sourcePath, agentId: sourceAgentId } = source;
    const databaseIdentity = `file:${source.databaseIdentity}`;
    // Observational reads retain the source until response publication: a closed or
    // replaced database must not keep serving facts read from the retired source.
    if (isArtifactPreservingStateRead()) {
      // Registry publications carry physical facts; unrelated registrations are not revocation.
      assertSourcePublication = prepareOpenClawAgentDatabaseRegistrySnapshotRead({}, (mutation) =>
        mutation.sources.every(
          (registered) =>
            (registered.path !== sourcePath &&
              registered.physicalPath !== sourcePath &&
              registered.identity !== databaseIdentity) ||
            (mutation.kind === "upsert" &&
              registered.agentId === sourceAgentId &&
              registered.identity === databaseIdentity &&
              registered.schemaVersion === OPENCLAW_AGENT_SCHEMA_VERSION),
        ),
      ).assertCurrent;
      // Retain the original source's native retirement signal independently of the
      // entry's writer postimages.
      releaseSource = registerOpenClawAgentDatabaseReadCandidateResource({
        path: sourcePath,
        revoke: retire,
        close: async () => retire(),
      });
    }
    retained = retainPreparedSessionEntryPredicate({
      databaseIdentity,
      sessionKey: key,
      entry,
      matches: (before, after) =>
        fields.every((field) => isDeepStrictEqual(before?.[field], after?.[field])),
    });
  };
  let loaded: PublicationSessionRead;
  try {
    if (readMemory) {
      loaded = readMemory();
    } else if (options.target?.storePath && options.target.agentId) {
      const storePath = options.target.storePath;
      const agentId = options.target.agentId;
      const storedKey = options.target.sessionKey ?? sessionKey;
      loaded = await withSessionEntryReadOnlyInWorker(
        { agentId, sessionKey: storedKey, storePath, projection },
        () => options.assertCurrent?.(),
        async (read, owner) => {
          if (!read.ok) {
            throw read.error;
          }
          retain(owner.source, storedKey, read.value);
          return { agentId, canonicalKey: sessionKey, storePath, entry: read.value };
        },
      );
    } else {
      loaded = await loadGatewaySessionEntryReadOnlyInWorker({
        cfg: options.cfg ?? getRuntimeConfig(),
        key: sessionKey,
        agentId: options.agentId,
        projection,
        assertActive: options.assertCurrent,
        onSelected(target) {
          retain(
            target.capturedReadSource,
            target.canonicalKey,
            findCanonicalStoreMatch(target.store, target.storeKeys)?.entry,
          );
        },
      });
    }
  } catch (error) {
    retire();
    releaseSource?.();
    throw error;
  }
  const release = () => {
    retire();
    releaseSource?.();
  };
  return {
    loaded,
    readCurrent: (): PublicationSessionRead => {
      options.assertCurrent?.();
      assertSourcePublication?.();
      if (!active || (retained && !retained.isCurrent())) {
        throw new GitHubPublicationSessionChangedError();
      }
      return readMemory
        ? readMemory()
        : { ...loaded, entry: retained ? retained.readRetainedEntry() : loaded.entry };
    },
    release,
    [Symbol.dispose]: release,
  };
}

export async function readGitHubPublicationWorktreeOwner(
  params: PublicationSessionIdentity & {
    expected?: ExpectedWorktree;
    allowExistingPullRequest?: boolean;
  },
) {
  const context = captureOpenClawStateWorkerContext();
  const session = await prepareGitHubPublicationSession(params.sessionKey, {
    agentId: params.agentId,
    assertCurrent: () => context.admission.assertCurrent(),
  });
  try {
    const owner = await preparePublicationWorktreeRead(
      requirePublicationSessionOwner(params, session.readCurrent()),
      context,
      session.readCurrent,
      params.expected,
      params.allowExistingPullRequest,
    )();
    return { ...owner, release: session.release, [Symbol.dispose]: session.release };
  } catch (error) {
    session.release();
    throw error;
  }
}

function resolveGitHubPublicationWorkspaceOwner(
  params: PublicationSessionIdentity,
  prepared: PreparedRepositoryWorkspace | undefined,
  readSession: () => PublicationSessionRead,
) {
  const loaded = requirePublicationSessionOwner(params, readSession());
  const workspaceId = loaded.entry.repositoryWorkspaceId;
  if (!workspaceId) {
    throw new GitHubPublicationSessionChangedError();
  }
  const workspace = prepared?.current();
  if (
    !workspace ||
    workspace.workspaceId !== workspaceId ||
    workspace.agentId !== params.agentId ||
    workspace.sessionKey !== params.sessionKey
  ) {
    throw new GitHubPublicationWorkspaceChangedError(
      "GitHub publication session repository owner changed.",
    );
  }
  return { kind: "repository" as const, loaded, workspace };
}

export async function prepareGitHubPublicationWorkspaceOwner(
  params: PublicationSessionIdentity,
  options: {
    sessionTarget?: RepositoryPublicationSessionTarget;
    assertCurrent?: () => void;
    allowExistingPullRequest?: boolean;
  } = {},
) {
  const context = captureOpenClawStateWorkerContext();
  const assertCurrent = () => {
    context.admission.assertCurrent();
    options.assertCurrent?.();
  };
  assertCurrent();
  const target = options.sessionTarget ? { ...options.sessionTarget } : undefined;
  if (target) {
    const logical =
      target.sessionKey &&
      resolveSessionStoreIdentity({
        cfg: getRuntimeConfig(),
        sessionKey: target.sessionKey,
        agentId: target.agentId,
      });
    if (
      !target.storePath ||
      !logical ||
      logical.agentId !== params.agentId ||
      logical.canonicalKey !== params.sessionKey
    ) {
      throw new GitHubPublicationSessionChangedError();
    }
  }
  const session = await prepareGitHubPublicationSession(params.sessionKey, {
    agentId: params.agentId,
    assertCurrent,
    target,
  });
  try {
    const snapshot = session.readCurrent();
    if (
      target &&
      (target.agentId !== params.agentId ||
        target.sessionId !== params.sessionId ||
        (target.expectedLifecycleRevision !== undefined &&
          snapshot.entry?.lifecycleRevision !== target.expectedLifecycleRevision) ||
        (target.expectedWriterRunId !== undefined &&
          snapshot.entry?.activeWriterRunId !== target.expectedWriterRunId))
    ) {
      throw new GitHubPublicationSessionChangedError();
    }
    const loaded = requirePublicationSessionOwner(params, snapshot);
    const workspaceId = loaded.entry.repositoryWorkspaceId;
    if (!workspaceId && !loaded.entry.worktree?.id) {
      throw new GitHubPublicationSessionChangedError();
    }
    const identity = { ...params, lifecycleRevision: loaded.entry.lifecycleRevision ?? null };
    const readWorktree = preparePublicationWorktreeRead(
      loaded,
      context,
      session.readCurrent,
      undefined,
      options.allowExistingPullRequest,
    );
    const prepared = workspaceId
      ? await getSessionRepositoryWorkspaceStore().prepare(workspaceId)
      : undefined;
    const validate = <T extends { loaded: PublicationSessionOwner }>(owner: T) => {
      assertCurrent();
      if (
        owner.loaded.storePath !== loaded.storePath ||
        owner.loaded.entry.repositoryWorkspaceId !== workspaceId ||
        (target?.expectedWriterRunId !== undefined &&
          owner.loaded.entry.activeWriterRunId !== target.expectedWriterRunId)
      ) {
        throw new GitHubPublicationSessionChangedError();
      }
      return owner;
    };
    let witness: Awaited<ReturnType<typeof readWorktree>> | undefined;
    const current = () => {
      if (workspaceId) {
        return validate(
          resolveGitHubPublicationWorkspaceOwner(identity, prepared, session.readCurrent),
        );
      }
      if (!witness) {
        throw new GitHubPublicationSessionChangedError();
      }
      return validate({ kind: "worktree" as const, ...witness, ...witness.assertCurrent() });
    };
    const read = async () => {
      if (!workspaceId) {
        witness = await readWorktree();
      }
      return current();
    };
    return {
      initial: await read(),
      read,
      current,
      // Repository-only projection; current() also exposes the retained worktree read witness.
      currentRepository: () =>
        validate(resolveGitHubPublicationWorkspaceOwner(identity, prepared, session.readCurrent)),
      release: session.release,
      [Symbol.dispose]: session.release,
    };
  } catch (error) {
    session.release();
    throw error;
  }
}

export async function hasGitHubPublicationRepositoryWorkspace(params: PublicationSessionIdentity) {
  const prepared = await prepareGitHubPublicationWorkspaceOwner(params, {
    allowExistingPullRequest: true,
  });
  using _ = { [Symbol.dispose]: () => prepared.release() };

  return prepared.initial.kind === "repository";
}

async function localGitHubPublicationSessionIdentity(row: {
  request_id: string;
  identity_source: string;
  session_id: string;
  session_key: string;
  agent_id: string;
  worktree_id: string;
  repository_fingerprint: string;
  branch: string;
}) {
  const authority = await prepareGitHubPublicationSessionLifecycle({
    publicationKind: row.identity_source === "personal" ? "personal" : "shared",
    requestId: row.request_id,
  }).catch((cause: unknown) => {
    throw new GitHubPublicationRecoveryPendingError(
      "GitHub publication lifecycle authority is unavailable; retry recovery.",
      { cause },
    );
  });
  const readLifecycle = () => {
    try {
      return authority.readCurrent();
    } catch (cause) {
      // Pending writes deny effects without proving that the accepted request failed.
      throw new GitHubPublicationRecoveryPendingError(
        "GitHub publication lifecycle authority is unavailable; retry recovery.",
        { cause },
      );
    }
  };
  const lifecycle = readLifecycle();
  if (!lifecycle) {
    throw new GitHubPublicationSessionChangedError();
  }
  return {
    sessionId: row.session_id,
    sessionKey: row.session_key,
    agentId: row.agent_id,
    lifecycleRevision: lifecycle.lifecycle_revision,
    assertLifecycleCurrent: readLifecycle,
    expected: {
      worktreeId: row.worktree_id,
      repositoryFingerprint: row.repository_fingerprint,
      branch: row.branch,
    },
  };
}

export async function readLocalGitHubPublicationWorktreeOwner(
  row: Parameters<typeof localGitHubPublicationSessionIdentity>[0],
) {
  const identity = await localGitHubPublicationSessionIdentity(row);
  const owner = await readGitHubPublicationWorktreeOwner({
    ...identity,
    allowExistingPullRequest: row.identity_source !== "personal",
  });
  return {
    ...owner,
    assertCurrent: () => {
      identity.assertLifecycleCurrent();
      return owner.assertCurrent();
    },
  };
}

/** Discovery validates the same registered repository identity as publication, without GitHub I/O. */
export async function prepareGitHubPublicationRepositoryIdentity(params: {
  worktree: ManagedWorktreeRecord;
  assertCurrent: () => void;
}) {
  const { worktree, assertCurrent } = params;
  assertCurrent();
  const repositoryIdentity = await managedWorktrees.resolveRepositoryIdentity(worktree.path);
  assertCurrent();
  if (
    repositoryIdentity.checkoutRoot !== worktree.path ||
    repositoryIdentity.repoRoot !== worktree.repoRoot ||
    repositoryIdentity.fingerprint !== worktree.repoFingerprint
  ) {
    throw new GitHubPublicationWorkspaceChangedError(
      "GitHub publication workspace repository changed.",
    );
  }
  return repositoryIdentity;
}

type QualifiedPublicationSource = {
  custody: SessionGitHubReadinessResult["custody"];
  target: SessionGitHubReadinessResult["target"];
  assertCurrent: () => void;
};
type PublicationSourceQualification =
  | ({ ok: true } & QualifiedPublicationSource)
  | { ok: false; kind: "changed" | "unavailable"; cause: unknown };

/** One target qualifier serves observation and legacy discovery; effects still requalify. */
export async function qualifyGitHubPublicationSource(
  session: PublicationSessionIdentity,
  assertCurrent: () => void,
  readSession: () => PublicationSessionRead,
  options: { readMode?: "existing-only"; supportsOrigin: (originUrl: string) => boolean },
): Promise<PublicationSourceQualification> {
  const checkSession = () => {
    assertCurrent();
    return requirePublicationSessionOwner(session, readSession(), true);
  };
  try {
    const context = captureOpenClawStateWorkerContext();
    const initial = checkSession();
    context.admission.assertCurrent();
    if (initial.entry.archivedAt !== undefined) {
      return {
        ok: true,
        custody: { kind: "archived" },
        target: { kind: "unknown", reason: "not-qualified" },
        assertCurrent: checkSession,
      };
    }
    const workspaceId = initial.entry.repositoryWorkspaceId;
    if (workspaceId) {
      const prepared = await getSessionRepositoryWorkspaceStore().prepare(
        workspaceId,
        options.readMode
          ? {
              mode: options.readMode,
              owner: { agentId: session.agentId, sessionKey: session.sessionKey },
            }
          : undefined,
      );
      const current = () => {
        assertCurrent();
        return resolveGitHubPublicationWorkspaceOwner(session, prepared, readSession);
      };
      const owner = current();
      const supportsOrigin = options.supportsOrigin(owner.workspace.url);
      return {
        ok: true,
        custody: { kind: "qualified", source: "repository" },
        target: supportsOrigin
          ? { kind: "supported", basis: "repository-url", freshness: "observed" }
          : { kind: "unsupported" },
        assertCurrent: () => {
          const latest = current();
          if (
            latest.workspace.workspaceId !== workspaceId ||
            latest.workspace.revision !== owner.workspace.revision ||
            options.supportsOrigin(owner.workspace.url) !== supportsOrigin
          ) {
            throw new GitHubPublicationWorkspaceChangedError(
              "GitHub publication session repository owner changed.",
            );
          }
        },
      };
    }
    if (!initial.entry.worktree?.id) {
      return {
        ok: true,
        custody: { kind: "unbound_workspace" },
        target: { kind: "unknown", reason: "not-qualified" },
        assertCurrent: () => {
          const current = checkSession();
          if (
            current.entry.worktree?.id ||
            current.entry.repositoryWorkspaceId ||
            current.entry.archivedAt !== undefined
          ) {
            throw new GitHubPublicationSessionChangedError();
          }
        },
      };
    }
    const owner = await preparePublicationWorktreeRead(
      initial,
      context,
      readSession,
      undefined,
      true,
    )();
    const check = () => {
      assertCurrent();
      owner.assertCurrent();
    };
    check();
    if (initial.entry.worktree.githubPullRequest) {
      return {
        ok: true,
        custody: { kind: "qualified", source: "imported-pr" },
        target: { kind: "supported", basis: "prepared-imported-pr", freshness: "observed" },
        assertCurrent: check,
      };
    }
    const { repoRoot, repoFingerprint } = owner.worktree;
    const key = JSON.stringify([context.admission.identity.key, repoRoot, repoFingerprint]);
    let observed = false;
    const target = await repositoryOrigins.read(
      key,
      async () => {
        const repository = await prepareGitHubPublicationRepositoryIdentity({
          worktree: owner.worktree,
          assertCurrent: () => context.admission.assertCurrent(),
        });
        observed = true;
        return repository.originUrl;
      },
      { allowStale: false },
    );
    check();
    const supportsOrigin = options.supportsOrigin(target.value);
    if (!supportsOrigin) {
      repositoryOrigins.deleteValue(target.value);
    }
    return {
      ok: true,
      custody: { kind: "qualified", source: "worktree" },
      target: supportsOrigin
        ? {
            kind: "supported",
            basis: "registered-repository",
            freshness: observed ? "observed" : "cached",
          }
        : { kind: "unsupported" },
      assertCurrent: () => {
        check();
        if (options.supportsOrigin(target.value) !== supportsOrigin) {
          throw new GitHubPublicationWorkspaceChangedError(
            "Publication provider target support changed.",
          );
        }
      },
    };
  } catch (cause) {
    // Authority failure is never a successful observation of an unavailable source.
    assertCurrent();
    return {
      ok: false,
      kind:
        cause instanceof GitHubPublicationSessionChangedError ||
        cause instanceof GitHubPublicationWorkspaceChangedError
          ? "changed"
          : "unavailable",
      cause,
    };
  }
}

/** Resolve local branch and origin under the admitted publication checkout owner. */
export async function readRepositoryPublicationTargetFacts(params: {
  worktree: ManagedWorktreeRecord;
  assertCurrent: () => void;
}): Promise<{ originUrl: string; branch: string; baseRef: string }> {
  const identity = await prepareGitHubPublicationRepositoryIdentity(params);
  params.assertCurrent();
  const { requirePublicationCommand } = await import("./github-publication-git-transport.js");
  const branch = await requirePublicationCommand(
    ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
    { cwd: params.worktree.path, beforeRun: params.assertCurrent },
  );
  params.assertCurrent();
  if (branch !== params.worktree.branch) {
    throw new RepositoryPublicationFailureError(
      `The session worktree has branch ${branch} checked out, but this session publishes branch ${params.worktree.branch}.`,
      {
        code: "workspace_changed",
        nextAction: `In the session worktree, rename the branch back with \`git branch -m ${branch} ${params.worktree.branch}\`, or switch to it with \`git switch ${params.worktree.branch}\` if it still exists, then request publication again. Publication only pushes the session branch.`,
      },
    );
  }
  return { originUrl: identity.originUrl, branch, baseRef: params.worktree.baseRef };
}

export function readAcceptedRepositoryPublicationWorktree(row: {
  requestId: string;
  kind: "shared" | "personal";
  sessionId: string;
  sessionKey: string;
  agentId: string;
  worktreeId: string;
  repositoryFingerprint: string;
  branch: string;
}) {
  return readLocalGitHubPublicationWorktreeOwner({
    request_id: row.requestId,
    identity_source: row.kind,
    session_id: row.sessionId,
    session_key: row.sessionKey,
    agent_id: row.agentId,
    worktree_id: row.worktreeId,
    repository_fingerprint: row.repositoryFingerprint,
    branch: row.branch,
  });
}
