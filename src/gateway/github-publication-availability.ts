import type { GitHubPublicationPublisher } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import {
  matchesPreparedGitHubPublicationIdentity,
  prepareGitHubPublicationIdentity,
  prepareGitHubPublicationOptionsIdentity,
  type PreparedGitHubPublicationIdentity,
} from "../agents/github-tool-identity.js";
import type { AgentRunSessionTarget } from "../agents/run-session-target.types.js";
import { SessionWorktreeSourceChangedError } from "../agents/worktrees/errors.js";
import {
  captureWorktreeRegistryReadGuard,
  readLiveRegistryWorktreeByOwner,
} from "../agents/worktrees/registry-read.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import type { ManagedWorktreeRecord } from "../agents/worktrees/types.js";
import { getRuntimeConfig } from "../config/config.js";
import { isNativeSessionEntryRead } from "../config/sessions/session-entry-read-request.js";
import {
  readSessionEntriesFromStoreInWorker,
  readSessionEntryReadOnlyInWorker,
} from "../config/sessions/session-entry-read-runtime.js";
import { preparePhysicalSessionStorePath } from "../config/sessions/session-store-path.js";
import { LruCache } from "../infra/lru-cache.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { readGitHubPublicationSessionLifecycle } from "../state/github-publication-session-lifecycles.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  getSessionRepositoryWorkspaceStore,
  type PreparedRepositoryWorkspace,
} from "../state/session-repository-workspaces.js";
import { requestCurrentGitHubOAuthRefresh } from "./github-oauth-lifecycle.js";
import {
  GitHubPublicationWorkspaceChangedError,
  GitHubPublicationSessionChangedError,
  rejectGitHubPublicationSelection,
  type GitHubPublicationPreparation,
} from "./github-publication-failure.js";
import { captureIncognitoPublicationSessionRead } from "./github-publication-incognito-source.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";

// Discovery only: publication resolves Git afresh. Registry/lifecycle guards retire facts early.
const worktreeTargets = new LruCache<{ expiresAt: number; assertCurrent: () => void }>(256);

function publicationConfigSnapshot() {
  const active = getActiveSecretsRuntimeConfigSnapshot();
  if (active) {
    return active;
  }
  const config = getRuntimeConfig();
  return { config, sourceConfig: config };
}

export function assertExpectedSharedGitHubPublisher(
  expected: GitHubPublicationPublisher | undefined,
  actual: GitHubPublicationPublisher,
  preparation?: GitHubPublicationPreparation,
): void {
  if (
    actual.source === "personal" ||
    (expected &&
      (expected.source !== actual.source ||
        expected.accountId !== actual.accountId ||
        expected.login.toLowerCase() !== actual.login.toLowerCase()))
  ) {
    rejectGitHubPublicationSelection(
      "GitHub publication identity changed; review the current shared account and try again.",
      preparation,
    );
  }
}

export function currentGitHubPublicationConfig() {
  return publicationConfigSnapshot().config;
}

export async function prepareCurrentGitHubPublicationIdentity(
  agentId: string,
  assertCurrent?: () => void,
): Promise<PreparedGitHubPublicationIdentity> {
  assertCurrent?.();
  await requestCurrentGitHubOAuthRefresh(agentId);
  assertCurrent?.();
  const snapshot = publicationConfigSnapshot();
  return await prepareGitHubPublicationIdentity({
    config: snapshot.config,
    sourceConfig: snapshot.sourceConfig,
    agentId,
    assertCurrent,
  });
}

export async function prepareCurrentGitHubPublicationOptionsIdentity(
  agentId: string,
  assertCurrent?: () => void,
) {
  assertCurrent?.();
  await requestCurrentGitHubOAuthRefresh(agentId);
  assertCurrent?.();
  const snapshot = publicationConfigSnapshot();
  return await prepareGitHubPublicationOptionsIdentity({
    config: snapshot.config,
    sourceConfig: snapshot.sourceConfig,
    agentId,
    assertCurrent,
  });
}

export function matchesCurrentGitHubPublicationIdentity(params: {
  agentId: string;
  identity: PreparedGitHubPublicationIdentity;
}): boolean {
  return matchesPreparedGitHubPublicationIdentity({
    config: currentGitHubPublicationConfig(),
    ...params,
  });
}

export type PublicationSessionIdentity = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  lifecycleRevision?: string | null;
};
type ExpectedWorktree = { worktreeId: string; repositoryFingerprint: string; branch: string };
type PublicationSessionRead = Pick<
  ReturnType<typeof loadGatewaySessionEntryReadOnly>,
  "agentId" | "canonicalKey" | "storePath" | "entry"
>;

/** Publication uses only current identity, archive, and workspace metadata. */
export function readGitHubPublicationSession(
  sessionKey: string,
  options: Parameters<typeof loadGatewaySessionEntryReadOnly>[1] = {},
): PublicationSessionRead {
  return (
    captureIncognitoPublicationSessionRead(sessionKey, options)?.() ??
    loadGatewaySessionEntryReadOnly(sessionKey, options)
  );
}

function readPublicationSessionOwner(params: PublicationSessionIdentity, allowArchived = false) {
  const loaded = readGitHubPublicationSession(params.sessionKey, { agentId: params.agentId });
  return requirePublicationSessionOwner(params, loaded, allowArchived);
}

function requirePublicationSessionOwner(
  params: PublicationSessionIdentity,
  loaded: PublicationSessionRead,
  allowArchived = false,
) {
  const entry = loaded.entry;
  if (
    loaded.agentId !== params.agentId ||
    loaded.canonicalKey !== params.sessionKey ||
    entry?.sessionId !== params.sessionId ||
    (!allowArchived && entry.archivedAt !== undefined) ||
    (params.lifecycleRevision !== undefined &&
      (entry.lifecycleRevision ?? null) !== params.lifecycleRevision)
  ) {
    throw new GitHubPublicationSessionChangedError();
  }
  return { ...loaded, entry };
}

function requirePublicationWorktreeOwner(
  loaded: ReturnType<typeof readPublicationSessionOwner>,
  worktree: ManagedWorktreeRecord | undefined,
  expected?: ExpectedWorktree,
) {
  const entry = loaded.entry;
  if (
    !entry.worktree?.id ||
    !worktree ||
    worktree.removedAt !== undefined ||
    worktree.id !== entry.worktree.id ||
    worktree.ownerKind !== "session" ||
    worktree.ownerId !== loaded.canonicalKey ||
    worktree.branch !== entry.worktree.branch ||
    worktree.repoRoot !== entry.worktree.repoRoot
  ) {
    throw new GitHubPublicationSessionChangedError();
  }
  if (
    expected &&
    (worktree.id !== expected.worktreeId ||
      worktree.repoFingerprint !== expected.repositoryFingerprint ||
      worktree.branch !== expected.branch)
  ) {
    throw new GitHubPublicationWorkspaceChangedError(
      "GitHub publication workspace authority changed.",
    );
  }
  return { loaded, worktree };
}

function rejectChangedPublicationWorktree(error: unknown): never {
  if (error instanceof SessionWorktreeSourceChangedError) {
    throw new GitHubPublicationWorkspaceChangedError(error.message);
  }
  throw error;
}

function preparePublicationWorktreeRead(
  loaded: ReturnType<typeof readPublicationSessionOwner>,
  context: OpenClawStateWorkerContext,
  expected?: ExpectedWorktree,
  readSession = captureIncognitoPublicationSessionRead(
    loaded.canonicalKey,
    { agentId: loaded.agentId },
    loaded.storePath,
  ) ?? (() => loadGatewaySessionEntryReadOnly(loaded.canonicalKey, { agentId: loaded.agentId })),
) {
  const identity = {
    sessionId: loaded.entry.sessionId,
    sessionKey: loaded.canonicalKey,
    agentId: loaded.agentId,
    lifecycleRevision: loaded.entry.lifecycleRevision ?? null,
  };
  const workspaceId = loaded.entry.repositoryWorkspaceId;
  const selection = expected ? { ...expected } : undefined;
  return async () => {
    const acceptRead = captureWorktreeRegistryReadGuard(context, "publication");
    const worktree = await readLiveRegistryWorktreeByOwner(context, "session", identity.sessionKey);
    let assertRow: () => void;
    try {
      assertRow = acceptRead(worktree);
    } catch (error) {
      rejectChangedPublicationWorktree(error);
    }
    context.admission.assertCurrent();
    if (!worktree) {
      throw new GitHubPublicationSessionChangedError();
    }
    const current = requirePublicationSessionOwner(identity, readSession());
    if (current.entry.repositoryWorkspaceId !== workspaceId) {
      throw new GitHubPublicationSessionChangedError();
    }
    const assertCurrent = () => {
      context.admission.assertCurrent();
      const latest = requirePublicationSessionOwner(identity, readSession());
      if (latest.entry.repositoryWorkspaceId !== workspaceId) {
        throw new GitHubPublicationSessionChangedError();
      }
      try {
        assertRow();
      } catch (error) {
        rejectChangedPublicationWorktree(error);
      }
      return requirePublicationWorktreeOwner(latest, worktree, selection);
    };
    return { ...requirePublicationWorktreeOwner(current, worktree, selection), assertCurrent };
  };
}

export function readGitHubPublicationWorktreeOwner(
  params: PublicationSessionIdentity & { expected?: ExpectedWorktree },
) {
  const context = captureOpenClawStateWorkerContext();
  return preparePublicationWorktreeRead(
    readPublicationSessionOwner(params),
    context,
    params.expected,
  )();
}

function resolveGitHubPublicationWorkspaceOwner(
  loaded: ReturnType<typeof readPublicationSessionOwner>,
  prepared: PreparedRepositoryWorkspace | undefined,
) {
  const workspaceId = loaded.entry.repositoryWorkspaceId;
  if (!workspaceId) {
    throw new GitHubPublicationSessionChangedError();
  }
  const workspace = prepared?.current();
  if (
    !workspace ||
    workspace.workspaceId !== workspaceId ||
    workspace.agentId !== loaded.agentId ||
    workspace.sessionKey !== loaded.canonicalKey
  ) {
    throw new Error("GitHub publication session repository owner changed.");
  }
  return { kind: "repository" as const, loaded, workspace };
}

type GitHubPublicationWorkspace =
  | ReturnType<typeof resolveGitHubPublicationWorkspaceOwner>
  | ({ kind: "worktree" } & Awaited<ReturnType<ReturnType<typeof preparePublicationWorktreeRead>>>);
type GitHubCredentialOnlyWorkspace = {
  kind: "none";
  loaded: ReturnType<typeof readPublicationSessionOwner>;
};
type PublicationWorkspaceOptions = {
  sessionTarget?: AgentRunSessionTarget;
  assertCurrent?: () => void;
};
type PreparedGitHubPublicationWorkspaceOwner<T> = {
  initial: T;
  read: () => Promise<T>;
  current: () => T;
  currentRepository: () => ReturnType<typeof resolveGitHubPublicationWorkspaceOwner>;
};

export function prepareGitHubPublicationWorkspaceOwner(
  params: PublicationSessionIdentity,
  options?: PublicationWorkspaceOptions,
): Promise<PreparedGitHubPublicationWorkspaceOwner<GitHubPublicationWorkspace>>;
export function prepareGitHubPublicationWorkspaceOwner(
  params: PublicationSessionIdentity,
  options: PublicationWorkspaceOptions & { allowMissingWorkspace: true },
): Promise<
  PreparedGitHubPublicationWorkspaceOwner<
    GitHubPublicationWorkspace | GitHubCredentialOnlyWorkspace
  >
>;
export async function prepareGitHubPublicationWorkspaceOwner(
  params: PublicationSessionIdentity,
  options: PublicationWorkspaceOptions & { allowMissingWorkspace?: true } = {},
) {
  const context = captureOpenClawStateWorkerContext();
  const assertCurrent = () => {
    context.admission.assertCurrent();
    options.assertCurrent?.();
  };
  assertCurrent();
  const target = options.sessionTarget ? { ...options.sessionTarget } : undefined;
  const readBoundSession = captureIncognitoPublicationSessionRead(
    params.sessionKey,
    { agentId: params.agentId },
    target?.storePath,
  );
  const readCurrentSession =
    readBoundSession ??
    (() => loadGatewaySessionEntryReadOnly(params.sessionKey, { agentId: params.agentId }));
  const readSession = async (identity: PublicationSessionIdentity = params) => {
    let snapshot: PublicationSessionRead;
    if (readBoundSession) {
      snapshot = readBoundSession();
      if (
        target &&
        (target.agentId !== identity.agentId ||
          target.sessionId !== identity.sessionId ||
          target.sessionKey !== identity.sessionKey ||
          (target.expectedLifecycleRevision !== undefined &&
            snapshot.entry?.lifecycleRevision !== target.expectedLifecycleRevision) ||
          (target.expectedWriterRunId !== undefined &&
            snapshot.entry?.activeWriterRunId !== target.expectedWriterRunId))
      ) {
        throw new GitHubPublicationSessionChangedError();
      }
    } else if (target) {
      // Reuse the admitted store locator rather than rediscovering it from current config.
      if (
        !target.storePath ||
        !target.sessionKey ||
        target.agentId !== params.agentId ||
        target.sessionId !== params.sessionId
      ) {
        throw new GitHubPublicationSessionChangedError();
      }
      const logicalTarget =
        target.sessionKey === params.sessionKey
          ? { agentId: target.agentId, canonicalKey: target.sessionKey }
          : resolveSessionStoreIdentity({
              cfg: getRuntimeConfig(),
              sessionKey: target.sessionKey,
              agentId: target.agentId,
            });
      if (
        logicalTarget.agentId !== params.agentId ||
        logicalTarget.canonicalKey !== params.sessionKey
      ) {
        throw new GitHubPublicationSessionChangedError();
      }
      const scope = {
        agentId: target.agentId,
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        storePath: target.storePath,
        projection: [],
      };
      const entry = isNativeSessionEntryRead(scope, target.agentId)
        ? await readSessionEntryReadOnlyInWorker(
            { ...scope, readConsistency: "latest" },
            assertCurrent,
          )
        : (
            await readSessionEntriesFromStoreInWorker(
              {
                agentId: target.agentId,
                storePath: target.storePath,
                sessionKeys: [target.sessionKey],
                projection: "exact",
                snapshotFields: [],
              },
              assertCurrent,
            )
          ).entries.find(({ sessionKey }) => sessionKey === target.sessionKey)?.entry;
      assertCurrent();
      if (
        (target.expectedLifecycleRevision !== undefined &&
          entry?.lifecycleRevision !== target.expectedLifecycleRevision) ||
        (target.expectedWriterRunId !== undefined &&
          entry?.activeWriterRunId !== target.expectedWriterRunId)
      ) {
        throw new GitHubPublicationSessionChangedError();
      }
      snapshot = {
        agentId: target.agentId,
        canonicalKey: logicalTarget.canonicalKey,
        storePath: target.storePath,
        entry,
      };
    } else {
      snapshot = await loadGatewaySessionEntryReadOnlyInWorker({
        cfg: getRuntimeConfig(),
        key: params.sessionKey,
        agentId: params.agentId,
        projection: [],
        assertActive: assertCurrent,
      });
    }
    assertCurrent();
    return requirePublicationSessionOwner(identity, snapshot);
  };
  const loaded = await readSession();
  const workspaceId = loaded.entry.repositoryWorkspaceId;
  if (!options.allowMissingWorkspace && !workspaceId && !loaded.entry.worktree?.id) {
    throw new GitHubPublicationSessionChangedError();
  }
  const identity = { ...params, lifecycleRevision: loaded.entry.lifecycleRevision ?? null };
  const routedStorePath = requirePublicationSessionOwner(identity, readCurrentSession()).storePath;
  if (routedStorePath !== loaded.storePath) {
    const env = { ...process.env, ...context.environment };
    const [admittedPath, routedPath] = await Promise.all(
      [loaded.storePath, routedStorePath].map((storePath) =>
        preparePhysicalSessionStorePath({ ...identity, storePath, env }),
      ),
    );
    assertCurrent();
    if (admittedPath !== routedPath) {
      throw new GitHubPublicationSessionChangedError();
    }
  }
  const readWorktree = preparePublicationWorktreeRead(
    loaded,
    context,
    undefined,
    readCurrentSession,
  );
  const prepared = workspaceId
    ? await getSessionRepositoryWorkspaceStore().prepare(workspaceId)
    : undefined;
  const validate = <T extends { loaded: ReturnType<typeof readPublicationSessionOwner> }>(
    owner: T,
  ) => {
    assertCurrent();
    if (
      (owner.loaded.storePath !== loaded.storePath && owner.loaded.storePath !== routedStorePath) ||
      owner.loaded.entry.repositoryWorkspaceId !== workspaceId
    ) {
      throw new GitHubPublicationSessionChangedError();
    }
    return owner;
  };
  const currentSession = () => {
    const current = requirePublicationSessionOwner(identity, readCurrentSession());
    if (
      current.storePath !== routedStorePath ||
      (target?.expectedWriterRunId !== undefined &&
        current.entry.activeWriterRunId !== target.expectedWriterRunId)
    ) {
      throw new GitHubPublicationSessionChangedError();
    }
    return validate({ loaded: current }).loaded;
  };
  const currentRepository = () =>
    validate(resolveGitHubPublicationWorkspaceOwner(currentSession(), prepared));
  let worktreeWitness: Awaited<ReturnType<typeof readWorktree>> | undefined;
  const current = () => {
    const sessionOwner = currentSession();
    if (workspaceId) {
      return validate(resolveGitHubPublicationWorkspaceOwner(sessionOwner, prepared));
    }
    if (options.allowMissingWorkspace && !sessionOwner.entry.worktree) {
      return validate({ kind: "none" as const, loaded: sessionOwner });
    }
    if (!worktreeWitness) {
      throw new GitHubPublicationSessionChangedError();
    }
    const owner = worktreeWitness.assertCurrent();
    return validate({
      kind: "worktree" as const,
      ...worktreeWitness,
      ...requirePublicationWorktreeOwner(sessionOwner, owner.worktree),
    });
  };
  const readWorkspace = async (sessionOwner: ReturnType<typeof readPublicationSessionOwner>) => {
    validate({ loaded: sessionOwner });
    if (workspaceId) {
      return validate(resolveGitHubPublicationWorkspaceOwner(sessionOwner, prepared));
    }
    if (options.allowMissingWorkspace && !sessionOwner.entry.worktree) {
      return validate({ kind: "none" as const, loaded: sessionOwner });
    }
    const witness = await readWorktree();
    const owner = validate({
      kind: "worktree" as const,
      ...witness,
      ...requirePublicationWorktreeOwner(sessionOwner, witness.worktree),
    });
    // Retain the worker owner's live guard, never a caller-thread registry lookup.
    worktreeWitness = witness;
    return owner;
  };
  const read = async () => readWorkspace(await readSession(identity));
  return { initial: await readWorkspace(loaded), read, current, currentRepository };
}

export function sameGitHubPublicationWorkspace(
  first: Awaited<ReturnType<typeof prepareGitHubPublicationWorkspaceOwner>>["initial"],
  current: Awaited<ReturnType<typeof prepareGitHubPublicationWorkspaceOwner>>["initial"],
): boolean {
  if (first.loaded.entry?.lifecycleRevision !== current.loaded.entry?.lifecycleRevision) {
    return false;
  }
  if (first.kind === "none" || current.kind === "none") {
    return first.kind === current.kind;
  }
  return first.kind === "repository"
    ? current.kind === "repository" &&
        current.workspace.workspaceId === first.workspace.workspaceId &&
        current.workspace.url === first.workspace.url &&
        current.workspace.branch === first.workspace.branch
    : current.kind === "worktree" &&
        current.worktree.id === first.worktree.id &&
        current.worktree.repoFingerprint === first.worktree.repoFingerprint &&
        current.worktree.branch === first.worktree.branch;
}

function localGitHubPublicationSessionIdentity(row: {
  request_id: string;
  identity_source: string;
  session_id: string;
  session_key: string;
  agent_id: string;
  worktree_id: string;
  repository_fingerprint: string;
  branch: string;
}) {
  const lifecycle = readGitHubPublicationSessionLifecycle({
    publicationKind: row.identity_source === "personal" ? "personal" : "shared",
    requestId: row.request_id,
  });
  if (!lifecycle) {
    throw new GitHubPublicationSessionChangedError();
  }
  return {
    sessionId: row.session_id,
    sessionKey: row.session_key,
    agentId: row.agent_id,
    lifecycleRevision: lifecycle.lifecycle_revision,
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
  const identity = localGitHubPublicationSessionIdentity(row);
  const owner = await readGitHubPublicationWorktreeOwner(identity);
  return {
    ...owner,
    assertCurrent: () => {
      if (
        localGitHubPublicationSessionIdentity(row).lifecycleRevision !== identity.lifecycleRevision
      ) {
        throw new GitHubPublicationSessionChangedError();
      }
      return owner.assertCurrent();
    },
  };
}

export async function prepareGitHubPublicationAvailability(params: {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  sessionTarget?: AgentRunSessionTarget;
  assertCurrent?: () => boolean;
}): Promise<boolean> {
  try {
    const assertCurrent = () => {
      if (params.assertCurrent?.() === false) {
        throw new GitHubPublicationSessionChangedError();
      }
    };
    assertCurrent();
    const prepared = await prepareGitHubPublicationWorkspaceOwner(params, {
      sessionTarget: params.sessionTarget,
      assertCurrent,
    });
    const initial = prepared.initial;
    assertCurrent();
    const identity = await prepareCurrentGitHubPublicationIdentity(params.agentId);
    assertCurrent();
    const current = await prepared.read();
    assertCurrent();
    return (
      sameGitHubPublicationWorkspace(initial, current) &&
      matchesCurrentGitHubPublicationIdentity({ agentId: params.agentId, identity })
    );
  } catch {
    return false;
  }
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

function isSupportedGitHubOrigin(originUrl: string): boolean {
  const remote = parseGitHubRemoteUrl(originUrl);
  return Boolean(
    remote && /^[A-Za-z0-9_.-]+$/u.test(remote.owner) && /^[A-Za-z0-9_.-]+$/u.test(remote.repo),
  );
}

/** Qualify only the target; execution still owns branch, permission and publication checks. */
export async function hasSupportedGitHubPublicationTarget(
  session: PublicationSessionIdentity,
  assertCurrent: () => void,
): Promise<boolean> {
  assertCurrent();
  const context = captureOpenClawStateWorkerContext();
  const initial = requirePublicationSessionOwner(
    session,
    getSessionActorStorageBinding(session) || captureIncognitoSessionBinding(session)
      ? readGitHubPublicationSession(session.sessionKey, { agentId: session.agentId })
      : await loadGatewaySessionEntryReadOnlyInWorker({
          cfg: getRuntimeConfig(),
          key: session.sessionKey,
          agentId: session.agentId,
          assertActive: assertCurrent,
          projection: [],
        }),
    true,
  );
  context.admission.assertCurrent();
  if (initial.entry.archivedAt !== undefined) {
    return false;
  }
  const workspaceId = initial.entry.repositoryWorkspaceId;
  if (workspaceId) {
    const prepared = await getSessionRepositoryWorkspaceStore().prepare(workspaceId);
    assertCurrent();
    const owner = resolveGitHubPublicationWorkspaceOwner(
      readPublicationSessionOwner(session),
      prepared,
    );
    return isSupportedGitHubOrigin(owner.workspace.url);
  }
  if (!initial.entry.worktree?.id) {
    return false;
  }
  const owner = await preparePublicationWorktreeRead(initial, context)();
  const assertWorktreeCurrent = () => {
    assertCurrent();
    owner.assertCurrent();
  };
  assertWorktreeCurrent();
  const key = `${context.admission.databasePath}\0${owner.worktree.id}`;
  const cached = worktreeTargets.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    try {
      cached.assertCurrent();
      return true;
    } catch {
      // The current read may select a replacement owner; qualify its Git facts again.
    }
  }
  worktreeTargets.delete(key);
  const repository = await prepareGitHubPublicationRepositoryIdentity({
    worktree: owner.worktree,
    assertCurrent: assertWorktreeCurrent,
  });
  assertWorktreeCurrent();
  const supported = isSupportedGitHubOrigin(repository.originUrl);
  if (supported) {
    worktreeTargets.set(key, {
      expiresAt: Date.now() + 15_000,
      assertCurrent: owner.assertCurrent,
    });
  }
  return supported;
}
