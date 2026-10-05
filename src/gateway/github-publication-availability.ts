import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { resolveGitHubHost } from "../agents/github-host-runtime.js";
import {
  measureGitHubIdentityPreparation,
  observeGitHubIdentityPreparation,
  type GitHubIdentityPreparationObserver,
} from "../agents/github-identity-preparation-timing.js";
import {
  matchesPreparedGitHubPublicationIdentity,
  prepareGitHubPublicationIdentity,
  prepareGitHubPublicationOptionsIdentity,
  type PreparedGitHubPublicationIdentity,
  resolveConfiguredGitHubToolIdentity,
} from "../agents/github-tool-identity.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
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
import type { FactoryGitHubProofClaim } from "./factory-github-proof.js";
import { requestCurrentGitHubOAuthRefresh } from "./github-oauth-lifecycle.js";
import { withFactoryPublicationIdentity } from "./github-publication-factory-identity.js";
import {
  GitHubPublicationWorkspaceChangedError,
  GitHubPublicationSessionChangedError,
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

export function currentGitHubPublicationConfig() {
  return publicationConfigSnapshot().config;
}

export type FactoryPublicationActor = {
  profileId: string;
  sessionKey: string;
  assertCurrent?: () => void;
};

export type FactoryPublicationCredential = {
  claim: FactoryGitHubProofClaim;
  assertCurrent: () => void;
};

export function factoryPublicationPreflightCredential(params: {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string | null;
  requestDigest?: string;
  assertCurrent: () => void;
}): FactoryPublicationCredential {
  return {
    claim: {
      purpose: "publication-preflight",
      binding: {
        kind: "session",
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        lifecycleRevision: params.lifecycleRevision,
        ...(params.requestDigest ? { requestDigest: params.requestDigest } : {}),
      },
    },
    assertCurrent: params.assertCurrent,
  };
}

/** Each bounded native read borrows the current Factory proof owner's lifetime. */
export function factoryPublicationNativeReader(
  actor: FactoryPublicationActor | undefined,
  credential: FactoryPublicationCredential | undefined,
) {
  if (process.env.FACTORY_AUTH_MODE !== "github") {
    return undefined;
  }
  if (!actor || !credential) {
    throw new Error("GitHub publication requires current actor and credential authority.");
  }
  return async (
    env: NodeJS.ProcessEnv,
    admission?: import("../agents/github-credential-reader.js").GitHubRepositoryAdmissionRequest,
  ) =>
    await withFactoryPublicationIdentity(
      actor,
      credential,
      async (proofEnv, readNativeCredential) => {
        if (!readNativeCredential) {
          throw new Error("Factory GitHub credential authority is unavailable.");
        }
        return await readNativeCredential({ ...env, ...proofEnv }, admission);
      },
    );
}

export async function prepareCurrentGitHubPublicationIdentity(
  agentId: string,
  actor?: FactoryPublicationActor,
  credential?: FactoryPublicationCredential,
): Promise<PreparedGitHubPublicationIdentity> {
  actor?.assertCurrent?.();
  credential?.assertCurrent();
  await requestCurrentGitHubOAuthRefresh(agentId);
  actor?.assertCurrent?.();
  const snapshot = publicationConfigSnapshot();
  const managedExecution = (["agent", "system"] as const).some((scope) =>
    resolveConfiguredGitHubToolIdentity({ config: snapshot.config, agentId, scope }),
  );
  const appExecution =
    (
      resolveConfiguredGitHubToolIdentity({ config: snapshot.config, agentId, scope: "agent" }) ??
      resolveConfiguredGitHubToolIdentity({ config: snapshot.config, agentId, scope: "system" })
    )?.kind === "app-installation";
  const assertCurrent = () => {
    actor?.assertCurrent?.();
    credential?.assertCurrent();
    if (currentGitHubPublicationConfig() !== snapshot.config) {
      throw new Error("GitHub publication identity changed.");
    }
    if (process.env.FACTORY_AUTH_MODE === "github" && (!actor || !credential)) {
      throw new Error("GitHub publication requires current actor and credential authority.");
    }
  };
  assertCurrent();
  const prepare = (
    env?: NodeJS.ProcessEnv,
    readNativeCredential?: import("../agents/github-credential-reader.js").GitHubCredentialReader,
  ) =>
    prepareGitHubPublicationIdentity({
      config: snapshot.config,
      sourceConfig: snapshot.sourceConfig,
      agentId,
      env,
      readNativeCredential,
      assertCurrent,
    });
  const identity =
    managedExecution && !appExecution
      ? await prepare()
      : await withFactoryPublicationIdentity(actor, credential, prepare);
  assertCurrent();
  return identity;
}

export async function prepareCurrentGitHubPublicationOptionsIdentity(
  agentId: string,
  actor?: FactoryPublicationActor,
  credential?: FactoryPublicationCredential,
  observePreparation?: GitHubIdentityPreparationObserver,
) {
  actor?.assertCurrent?.();
  await measureGitHubIdentityPreparation(observePreparation, "oauth_refresh", () =>
    requestCurrentGitHubOAuthRefresh(agentId),
  );
  actor?.assertCurrent?.();
  const snapshot = publicationConfigSnapshot();
  observeGitHubIdentityPreparation(observePreparation, "credential_proof", "started");
  let proofPrepared = false;
  const prepare = (
    env?: NodeJS.ProcessEnv,
    readNativeCredential?: import("../agents/github-credential-reader.js").GitHubCredentialReader,
  ) => {
    proofPrepared = true;
    observeGitHubIdentityPreparation(observePreparation, "credential_proof", "resolved");
    return prepareGitHubPublicationOptionsIdentity({
      config: snapshot.config,
      sourceConfig: snapshot.sourceConfig,
      agentId,
      env,
      readNativeCredential,
      observePreparation,
      assertCurrent,
    });
  };
  const managed = (["agent", "system"] as const).some((scope) =>
    resolveConfiguredGitHubToolIdentity({ config: snapshot.config, agentId, scope }),
  );
  const assertCurrent = () => {
    actor?.assertCurrent?.();
    credential?.assertCurrent();
    if (currentGitHubPublicationConfig() !== snapshot.config) {
      throw new Error("GitHub publication identity changed.");
    }
    if (process.env.FACTORY_AUTH_MODE === "github" && (!actor || !credential)) {
      throw new Error("GitHub publication requires current actor and credential authority.");
    }
  };
  assertCurrent();
  const identity = await (
    managed &&
    (
      resolveConfiguredGitHubToolIdentity({ config: snapshot.config, agentId, scope: "agent" }) ??
      resolveConfiguredGitHubToolIdentity({ config: snapshot.config, agentId, scope: "system" })
    )?.kind !== "app-installation"
      ? prepare()
      : withFactoryPublicationIdentity(actor, credential, prepare)
  ).catch((error: unknown) => {
    if (!proofPrepared) {
      observeGitHubIdentityPreparation(observePreparation, "credential_proof", "rejected");
    }
    throw error;
  });
  assertCurrent();
  return identity;
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

type GitHubPublicationWorkspace = ReturnType<typeof resolveGitHubPublicationWorkspaceOwner>;
type GitHubCredentialOnlyWorkspace = {
  kind: "none";
  loaded: ReturnType<typeof readPublicationSessionOwner>;
};
type PreparedGitHubPublicationWorkspaceOwner<Workspace> = {
  initial: Workspace;
  read: () => Promise<Workspace>;
  current: () => Workspace;
};

export function prepareGitHubPublicationWorkspaceOwner(
  params: PublicationSessionIdentity,
): Promise<PreparedGitHubPublicationWorkspaceOwner<GitHubPublicationWorkspace>>;
export function prepareGitHubPublicationWorkspaceOwner(
  params: PublicationSessionIdentity,
  options: { allowMissingWorkspace: true },
): Promise<
  PreparedGitHubPublicationWorkspaceOwner<
    GitHubPublicationWorkspace | GitHubCredentialOnlyWorkspace
  >
>;
export async function prepareGitHubPublicationWorkspaceOwner(
  params: PublicationSessionIdentity,
  options?: { allowMissingWorkspace: true },
) {
  const context = captureOpenClawStateWorkerContext();
  const loaded = requirePublicationSessionOwner(
    params,
    await loadGatewaySessionEntryReadOnlyInWorker({
      cfg: getRuntimeConfig(),
      key: params.sessionKey,
      agentId: params.agentId,
      projection: [],
    }),
  );
  context.admission.assertCurrent();
  const workspaceId = loaded.entry.repositoryWorkspaceId;
  const identity = { ...params, lifecycleRevision: loaded.entry.lifecycleRevision ?? null };
  const readWorktree = preparePublicationWorktreeRead(loaded, context);
  const prepared = workspaceId
    ? await getSessionRepositoryWorkspaceStore().prepare(workspaceId)
    : undefined;
  const credentialOnly = (current: ReturnType<typeof readPublicationSessionOwner>) =>
    options?.allowMissingWorkspace &&
    !current.entry.repositoryWorkspaceId &&
    !current.entry.worktree;
  const validate = (owner: GitHubPublicationWorkspace | GitHubCredentialOnlyWorkspace) => {
    context.admission.assertCurrent();
    if (owner.loaded.entry.repositoryWorkspaceId !== workspaceId) {
      throw new GitHubPublicationSessionChangedError();
    }
    return owner;
  };
  const current = () => {
    const currentSession = readPublicationSessionOwner(identity);
    return validate(
      credentialOnly(currentSession)
        ? { kind: "none", loaded: currentSession }
        : resolveGitHubPublicationWorkspaceOwner(identity, prepared),
    );
  };
  const read = async () => {
    const currentSession = readPublicationSessionOwner(identity);
    return validate(
      credentialOnly(currentSession)
        ? { kind: "none", loaded: currentSession }
        : workspaceId
          ? resolveGitHubPublicationWorkspaceOwner(identity, prepared)
          : { kind: "worktree", ...(await readWorktree()) },
    );
  };
  return { initial: await read(), read, current };
}

export function sameGitHubPublicationWorkspace(
  first: GitHubPublicationWorkspace | GitHubCredentialOnlyWorkspace,
  current: GitHubPublicationWorkspace | GitHubCredentialOnlyWorkspace,
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

export async function prepareGitHubPublicationAvailability(
  params: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
    assertCurrent?: () => boolean;
    operatorAuthority?: AdmittedRunOperatorAuthority;
  },
  preparation?: {
    workspace: Awaited<ReturnType<typeof prepareGitHubPublicationWorkspaceOwner>>;
    identity: PreparedGitHubPublicationIdentity;
    assertCurrent: () => void;
  },
): Promise<boolean> {
  try {
    if (params.assertCurrent?.() === false) {
      return false;
    }
    preparation?.assertCurrent();
    const prepared =
      preparation?.workspace ?? (await prepareGitHubPublicationWorkspaceOwner(params));
    const initial = prepared.initial;
    if (initial.kind === "none") {
      return false;
    }
    if (params.assertCurrent?.() === false) {
      return false;
    }
    const caller = getGatewayToolCallerIdentity();
    const authority =
      params.operatorAuthority ??
      (caller?.agentId === params.agentId && caller.sessionKey === params.sessionKey
        ? caller.operatorAuthority
        : undefined);
    if (authority) {
      assertAdmittedRunOperatorAuthority(authority);
    }
    if (process.env.FACTORY_AUTH_MODE === "github" && !authority) {
      return false;
    }
    const assertActorCurrent = () => {
      preparation?.assertCurrent();
      authority?.assertCurrent();
      if (
        params.assertCurrent?.() === false ||
        !sameGitHubPublicationWorkspace(initial, prepared.current())
      ) {
        throw new Error("GitHub publication session changed during availability.");
      }
    };
    const equivalent = preparation;
    const identity = equivalent
      ? preparation.identity
      : await prepareCurrentGitHubPublicationIdentity(
          params.agentId,
          authority
            ? {
                profileId: authority.profileId,
                sessionKey: params.sessionKey,
                assertCurrent: assertActorCurrent,
              }
            : undefined,
          factoryPublicationPreflightCredential({
            agentId: params.agentId,
            sessionKey: initial.loaded.canonicalKey,
            sessionId: params.sessionId,
            lifecycleRevision: initial.loaded.entry.lifecycleRevision ?? null,
            assertCurrent: assertActorCurrent,
          }),
        );
    assertActorCurrent();
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
      projection: [],
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

/** The PR reader is exposed only to an authenticated repository session. */
export async function prepareGitHubPullRequestReadAvailability(
  params: {
    sessionId: string;
    sessionKey: string;
    agentId: string;
    githubPublicationAvailable: boolean;
  },
  preparation?: Awaited<ReturnType<typeof prepareGitHubPublicationWorkspaceOwner>>,
): Promise<boolean> {
  if (
    !params.githubPublicationAvailable ||
    currentGitHubPublicationConfig().gateway?.projects?.nativeGitHubSearch !== true
  ) {
    return false;
  }
  try {
    const prepared = preparation ?? (await prepareGitHubPublicationWorkspaceOwner(params));
    const owner = prepared.current();
    return (
      owner.kind === "repository" &&
      parseGitHubRemoteUrl(owner.workspace.url, resolveGitHubHost()) !== null
    );
  } catch {
    return false;
  }
}
