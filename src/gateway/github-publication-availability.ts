import type { GitHubPublicationPublisher } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import {
  matchesPreparedGitHubPublicationIdentity,
  prepareGitHubPublicationIdentity,
  prepareGitHubPublicationOptionsIdentity,
  type PreparedGitHubPublicationIdentity,
} from "../agents/github-tool-identity.js";
import {
  readLiveRegistryWorktreeByOwner,
  readRegistryWorktree,
} from "../agents/worktrees/registry-read.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { getRuntimeConfig } from "../config/config.js";
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
import { parseGitHubRemoteUrl } from "./github-remote.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";

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
): Promise<PreparedGitHubPublicationIdentity> {
  await requestCurrentGitHubOAuthRefresh(agentId);
  const snapshot = publicationConfigSnapshot();
  return await prepareGitHubPublicationIdentity({
    config: snapshot.config,
    sourceConfig: snapshot.sourceConfig,
    agentId,
  });
}

export async function prepareCurrentGitHubPublicationOptionsIdentity(agentId: string) {
  await requestCurrentGitHubOAuthRefresh(agentId);
  const snapshot = publicationConfigSnapshot();
  return await prepareGitHubPublicationOptionsIdentity({
    config: snapshot.config,
    sourceConfig: snapshot.sourceConfig,
    agentId,
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

function readPublicationSessionOwner(params: PublicationSessionIdentity, allowArchived = false) {
  const loaded = loadGatewaySessionEntryReadOnly(params.sessionKey, { agentId: params.agentId });
  return requirePublicationSessionOwner(params, loaded, allowArchived);
}

function requirePublicationSessionOwner(
  params: PublicationSessionIdentity,
  loaded: ReturnType<typeof loadGatewaySessionEntryReadOnly>,
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
  worktree: ReturnType<typeof managedWorktrees.findLiveByOwner>,
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

function readPublicationWorktreeOwner(
  loaded: ReturnType<typeof readPublicationSessionOwner>,
  expected?: ExpectedWorktree,
) {
  return requirePublicationWorktreeOwner(
    loaded,
    managedWorktrees.findLiveByOwner("session", loaded.canonicalKey),
    expected,
  );
}

function preparePublicationWorktreeRead(
  loaded: ReturnType<typeof readPublicationSessionOwner>,
  context: OpenClawStateWorkerContext,
  expected?: ExpectedWorktree,
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
    const worktree = await readLiveRegistryWorktreeByOwner(context, "session", identity.sessionKey);
    context.admission.assertCurrent();
    if (!worktree) {
      throw new GitHubPublicationSessionChangedError();
    }
    const current = readPublicationSessionOwner(identity);
    if (current.entry.repositoryWorkspaceId !== workspaceId) {
      throw new GitHubPublicationSessionChangedError();
    }
    return requirePublicationWorktreeOwner(current, worktree, selection);
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

export function resolveGitHubPublicationWorktreeOwner(
  params: PublicationSessionIdentity & { expected?: ExpectedWorktree },
) {
  return readPublicationWorktreeOwner(readPublicationSessionOwner(params), params.expected);
}

function resolveGitHubPublicationWorkspaceOwner(
  params: PublicationSessionIdentity,
  prepared: PreparedRepositoryWorkspace | undefined,
) {
  const loaded = readPublicationSessionOwner(params);
  const workspaceId = loaded.entry.repositoryWorkspaceId;
  if (!workspaceId) {
    return { kind: "worktree" as const, ...readPublicationWorktreeOwner(loaded) };
  }
  const workspace = prepared?.current();
  if (
    !workspace ||
    workspace.workspaceId !== workspaceId ||
    workspace.agentId !== params.agentId ||
    workspace.sessionKey !== params.sessionKey
  ) {
    throw new Error("GitHub publication session repository owner changed.");
  }
  return { kind: "repository" as const, loaded, workspace };
}

export async function prepareGitHubPublicationWorkspaceOwner(params: PublicationSessionIdentity) {
  const context = captureOpenClawStateWorkerContext();
  const loaded = requirePublicationSessionOwner(
    params,
    await loadGatewaySessionEntryReadOnlyInWorker({
      cfg: getRuntimeConfig(),
      key: params.sessionKey,
      agentId: params.agentId,
    }),
  );
  context.admission.assertCurrent();
  const workspaceId = loaded.entry.repositoryWorkspaceId;
  const identity = { ...params, lifecycleRevision: loaded.entry.lifecycleRevision ?? null };
  const readWorktree = preparePublicationWorktreeRead(loaded, context);
  const prepared = workspaceId
    ? await getSessionRepositoryWorkspaceStore().prepare(workspaceId)
    : undefined;
  const validate = (owner: ReturnType<typeof resolveGitHubPublicationWorkspaceOwner>) => {
    context.admission.assertCurrent();
    if (owner.loaded.entry.repositoryWorkspaceId !== workspaceId) {
      throw new GitHubPublicationSessionChangedError();
    }
    return owner;
  };
  const read = async () =>
    validate(
      workspaceId
        ? resolveGitHubPublicationWorkspaceOwner(identity, prepared)
        : { kind: "worktree", ...(await readWorktree()) },
    );
  return {
    initial: await read(),
    read,
    // Effect guards retain live authority; prepared reads only select their inputs.
    current: () => validate(resolveGitHubPublicationWorkspaceOwner(identity, prepared)),
  };
}

export function sameGitHubPublicationWorkspace(
  first: ReturnType<typeof resolveGitHubPublicationWorkspaceOwner>,
  current: ReturnType<typeof resolveGitHubPublicationWorkspaceOwner>,
): boolean {
  if (first.loaded.entry?.lifecycleRevision !== current.loaded.entry?.lifecycleRevision) {
    return false;
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

export function resolveLocalGitHubPublicationWorktreeOwner(
  row: Parameters<typeof localGitHubPublicationSessionIdentity>[0],
) {
  return resolveGitHubPublicationWorktreeOwner(localGitHubPublicationSessionIdentity(row));
}

export function readLocalGitHubPublicationWorktreeOwner(
  row: Parameters<typeof localGitHubPublicationSessionIdentity>[0],
) {
  return readGitHubPublicationWorktreeOwner(localGitHubPublicationSessionIdentity(row));
}

export async function prepareGitHubPublicationAvailability(params: {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  assertCurrent?: () => boolean;
}): Promise<boolean> {
  try {
    if (params.assertCurrent?.() === false) {
      return false;
    }
    const prepared = await prepareGitHubPublicationWorkspaceOwner(params);
    const initial = prepared.initial;
    if (params.assertCurrent?.() === false) {
      return false;
    }
    const identity = await prepareCurrentGitHubPublicationIdentity(params.agentId);
    if (params.assertCurrent?.() === false) {
      return false;
    }
    const current = await prepared.read();
    if (params.assertCurrent?.() === false) {
      return false;
    }
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
  worktree: ReturnType<typeof resolveGitHubPublicationWorktreeOwner>["worktree"];
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

/** Qualify only the target; execution still owns branch, permission and publication checks. */
export async function hasSupportedGitHubPublicationTarget(
  session: PublicationSessionIdentity,
  assertCurrent: () => void,
): Promise<boolean> {
  assertCurrent();
  const context = captureOpenClawStateWorkerContext();
  const initial = requirePublicationSessionOwner(
    session,
    await loadGatewaySessionEntryReadOnlyInWorker({
      cfg: getRuntimeConfig(),
      key: session.sessionKey,
      agentId: session.agentId,
      assertActive: assertCurrent,
    }),
    true,
  );
  context.admission.assertCurrent();
  if (initial.entry.archivedAt !== undefined) {
    return false;
  }
  const workspaceId = initial.entry.repositoryWorkspaceId;
  const worktreeId = initial.entry.worktree?.id;
  const currentSession = () => {
    assertCurrent();
    const loaded = readPublicationSessionOwner(session);
    if (
      loaded.entry.repositoryWorkspaceId !== workspaceId ||
      loaded.entry.worktree?.id !== worktreeId
    ) {
      throw new GitHubPublicationSessionChangedError();
    }
    return loaded;
  };
  let originUrl: string;
  if (workspaceId) {
    const prepared = await getSessionRepositoryWorkspaceStore().prepare(workspaceId);
    currentSession();
    const owner = resolveGitHubPublicationWorkspaceOwner(session, prepared);
    if (owner.kind !== "repository") {
      throw new GitHubPublicationSessionChangedError();
    }
    originUrl = owner.workspace.url;
  } else if (worktreeId) {
    const readWorktree = async (expected?: ExpectedWorktree) => {
      const record = await readRegistryWorktree(context, worktreeId);
      context.admission.assertCurrent();
      return requirePublicationWorktreeOwner(currentSession(), record, expected).worktree;
    };
    const worktree = await readWorktree();
    const repository = await prepareGitHubPublicationRepositoryIdentity({
      worktree,
      assertCurrent: currentSession,
    });
    const current = await readWorktree({
      worktreeId: worktree.id,
      repositoryFingerprint: worktree.repoFingerprint,
      branch: worktree.branch,
    });
    if (current.path !== worktree.path) {
      throw new GitHubPublicationWorkspaceChangedError(
        "GitHub publication workspace repository changed.",
      );
    }
    originUrl = repository.originUrl;
  } else {
    return false;
  }
  const remote = parseGitHubRemoteUrl(originUrl);
  return Boolean(
    remote && /^[A-Za-z0-9_.-]+$/u.test(remote.owner) && /^[A-Za-z0-9_.-]+$/u.test(remote.repo),
  );
}
