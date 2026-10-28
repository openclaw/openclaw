import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  SessionGitLabPublishParams,
  SessionGitLabConfirmParams,
  SessionGitLabStatusResult,
} from "../../packages/gateway-protocol/src/schema/gitlab.js";
import { normalizeGitLabIssuer } from "../agents/gitlab-host.js";
import { resolveEffectiveGitLabToolIdentity } from "../agents/gitlab-tool-identity.js";
import { readUserGitLabConnectionAsync } from "../state/user-gitlab-connections.js";
import type { PersonalForgePublicationActionV2 } from "./forge-personal-publication-custody.js";
import { readGitHubPublicationWorktreeOwner } from "./github-publication-availability.js";
import { requirePublicationCommand } from "./github-publication-git-transport.js";
import { readPersonalGitLabPublicationAsync } from "./github-publication-store-async.js";
import {
  publicationPublisher,
  sameGitLabPublicationPublisher,
  type GitLabPublicationCredential,
} from "./gitlab-personal-publication-identity.js";
import { prepareManagedGitLabPublicationCredential } from "./gitlab-personal-publication-managed.js";
import {
  readGitLabPublicationForAction,
  readSharedGitLabPublicationForAction,
} from "./gitlab-personal-publication-read.js";
import {
  readAcceptedGitLabPublication,
  projectPersonalGitLabTerminalResult,
} from "./gitlab-personal-publication-row.js";
import { runPersonalGitLabPublication } from "./gitlab-personal-publication-runner.js";
import type { PersonalGitLabPublicationRow } from "./gitlab-personal-publication-store.js";
import {
  assertGitLabPublicationProject,
  createGitLabPublicationApi,
} from "./gitlab-publication-adapter.js";
import type { PersonalForgeAction } from "./server-methods/personal-forge-authorization.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

type Options = Pick<GatewayRequestHandlerOptions, "context">;
export type GitLabPublicationReadAction = PersonalForgeAction & {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string | null;
};

function issuerFor(options: Options): string {
  const issuer = options.context.getRuntimeConfig().gateway?.gitlab?.issuer;
  if (!issuer) {
    throw new Error("GitLab publication is not configured.");
  }
  return normalizeGitLabIssuer(issuer);
}

function requestIdFor(action: GitLabPublicationReadAction, issuer: string, key: string): string {
  const hex = createHash("sha256")
    .update(
      JSON.stringify([
        "gitlab-publication",
        action.owner,
        issuer,
        action.sessionId,
        action.lifecycleRevision,
        key,
      ]),
    )
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function readPersonalGitLabCheckoutTarget(
  options: Options,
  action: PersonalForgeAction,
  cwd: string,
) {
  const issuer = issuerFor(options);
  const origin = await requirePublicationCommand(["git", "remote", "get-url", "origin"], {
    cwd,
    beforeRun: action.assertCurrent,
  });
  if (!origin.startsWith(`${issuer}/`) || !origin.endsWith(".git")) {
    throw new Error("The session does not have a canonical GitLab HTTPS origin.");
  }
  const repository = origin.slice(issuer.length + 1, -4);
  if (!/^[\w.-]+(?:\/[\w.-]+)+$/u.test(repository)) {
    throw new Error("The session GitLab repository path is invalid.");
  }
  action.assertCurrent();
  return { repository, issuer, gitUrl: origin };
}

async function targetFor(options: Options, action: GitLabPublicationReadAction) {
  using owner = await readGitHubPublicationWorktreeOwner(action);
  const target = await readPersonalGitLabCheckoutTarget(
    options,
    {
      ...action,
      assertCurrent() {
        action.assertCurrent();
        owner.assertCurrent();
      },
    },
    owner.worktree.path,
  );
  return { ...target, branch: owner.worktree.branch };
}

/** Provider admission precedes binding a local checkout as well as any remote write. */
export async function preparePersonalGitLabPublicationProject(
  options: Options,
  action: PersonalForgeAction,
  credential: GitLabPublicationCredential,
  target: Awaited<ReturnType<typeof readPersonalGitLabCheckoutTarget>>,
) {
  if (target.issuer !== credential.account.issuer) {
    throw new Error("The selected GitLab publisher belongs to another issuer.");
  }
  const api = createGitLabPublicationApi({
    target: {
      issuer: target.issuer,
      projectId: 1,
      projectPath: target.repository,
      gitUrl: target.gitUrl,
      webUrl: `${target.issuer}/${target.repository}`,
      baseBranch: "",
    },
    credentials: credential,
    assertCurrent() {
      action.assertCurrent();
      credential.assertCurrent();
    },
  });
  const value = await api.request({
    method: "GET",
    path: `projects/${encodeURIComponent(target.repository)}`,
  });
  const project = z.object({ id: z.number().int().positive() }).parse(value);
  assertGitLabPublicationProject(value, {
    issuer: target.issuer,
    projectId: project.id,
    projectPath: target.repository,
    gitUrl: target.gitUrl,
    webUrl: `${target.issuer}/${target.repository}`,
    baseBranch: "",
  });
  action.assertCurrent();
  credential.assertCurrent();
  assertPersonalGitLabPublicationProjectAllowed(options, project.id);
  return project;
}

export function assertPersonalGitLabPublicationProjectAllowed(options: Options, projectId: number) {
  const configured = options.context.getRuntimeConfig().gateway?.gitlab;
  if (!configured || (configured.projects && !configured.projects.includes(projectId))) {
    throw new Error("GitLab publication project is not allowed.");
  }
}

function assertReceiptSession(
  row: PersonalGitLabPublicationRow,
  action: GitLabPublicationReadAction,
) {
  const saved = readAcceptedGitLabPublication(row);
  if (
    saved.sessionIdentity.sessionId !== action.sessionId ||
    saved.sessionIdentity.sessionKey !== action.sessionKey ||
    saved.sessionIdentity.agentId !== action.agentId ||
    saved.sessionIdentity.lifecycleRevision !== action.lifecycleRevision
  ) {
    throw new Error("GitLab publication belongs to another session incarnation.");
  }
  return saved;
}

function projectStatus(
  row: PersonalGitLabPublicationRow,
  action: GitLabPublicationReadAction,
  credential: {
    publisher: GitLabPublicationCredential["publisher"];
    generation: string;
    account: { accountId: number; login: string };
  } | null,
): SessionGitLabStatusResult {
  const saved = assertReceiptSession(row, action);
  const acceptedPublisher = publicationPublisher(saved.publisher);
  const publisher = {
    source: acceptedPublisher.source,
    accountId: row.identity_account_id,
    login: saved.actor.login,
  };
  if (row.status === "published" || row.status === "failed") {
    return { result: projectPersonalGitLabTerminalResult(row), confirmation: null };
  }
  if (
    !credential ||
    !sameGitLabPublicationPublisher(saved.publisher, credential.publisher) ||
    credential.generation !== row.connection_generation ||
    credential.account.accountId !== row.identity_account_id ||
    credential.account.login !== row.identity_login
  ) {
    return {
      result: {
        requestId: row.request_id,
        status: "failed",
        code: "identity_changed",
        publisher,
        message: "The original GitLab publisher changed or is unavailable.",
        nextAction:
          "Preserve the accepted request and inspect its original branch and merge request.",
      },
      confirmation: null,
    };
  }
  const confirmation =
    row.status === "needs_confirmation"
      ? {
          requestDigest: row.request_digest,
          generation: row.connection_generation,
          account: { accountId: publisher.accountId, login: publisher.login },
          pushRepository: saved.target.projectPath,
          repository: saved.target.projectPath,
          branch: saved.branch,
          baseBranch: saved.target.baseBranch,
          sourceHeadCommit: saved.sourceHead,
          sourceIndexTree: saved.sourceIndexTree,
          workspaceTree: saved.workspaceHead,
        }
      : null;
  return {
    result: {
      requestId: row.request_id,
      publisher,
      status: confirmation
        ? "needs_confirmation"
        : row.status === "requested"
          ? "requested"
          : "publishing",
      message: confirmation
        ? "Confirm recovery of the original GitLab publication."
        : "The accepted GitLab publication must be observed before another write.",
    },
    confirmation,
  };
}

export async function readGitLabPublicationPublisher(
  options: Options,
  action: GitLabPublicationReadAction,
  requestId: string,
) {
  const row = await readGitLabPublicationForAction(action, issuerFor(options), {
    requestId,
  });
  action.assertCurrent();
  if (!row) {
    throw new Error("GitLab publication request was not found.");
  }
  return publicationPublisher(assertReceiptSession(row, action).publisher);
}

export async function readPersonalGitLabPublicationOptions(
  options: Options,
  action: GitLabPublicationReadAction,
  idempotencyKey?: string,
) {
  const issuer = issuerFor(options);
  const connection = await readUserGitLabConnectionAsync(action.owner, issuer);
  action.assertCurrent();
  const selected = connection?.selection;
  const personalRow = await readPersonalGitLabPublicationAsync(
    action.owner,
    issuer,
    idempotencyKey
      ? { sessionId: action.sessionId, idempotencyKey }
      : { sessionKey: action.sessionKey, agentId: action.agentId },
  );
  const sharedRow = await readSharedGitLabPublicationForAction(
    action,
    issuer,
    idempotencyKey ? { idempotencyKey } : { latest: true },
    { allowUnavailableWorkspace: true },
  );
  const configuredShared = resolveEffectiveGitLabToolIdentity({
    config: options.context.getRuntimeConfig(),
    agentId: action.agentId,
  });
  let sharedCredential: GitLabPublicationCredential | null = null;
  if (configuredShared) {
    try {
      sharedCredential = await prepareManagedGitLabPublicationCredential({
        config: options.context.getRuntimeConfig(),
        getCurrentConfig: options.context.getRuntimeConfig,
        agentId: action.agentId,
        assertCurrent: action.assertCurrent,
      });
    } catch {
      action.assertCurrent();
    }
  }
  try {
    const personalPending =
      personalRow &&
      publicationPublisher(assertReceiptSession(personalRow, action).publisher).source ===
        "personal"
        ? projectStatus(
            personalRow,
            action,
            selected?.kind === "connected" && !selected.refreshFailure
              ? {
                  publisher: { source: "personal" },
                  generation: connection!.generation,
                  account: selected.account,
                }
              : null,
          )
        : null;
    const sharedPending = sharedRow ? projectStatus(sharedRow, action, sharedCredential) : null;
    let target: Awaited<ReturnType<typeof targetFor>> | null = null;
    try {
      target = await targetFor(options, action);
    } catch {
      // The accepted receipt remains discoverable while its original worktree is unavailable.
      action.assertCurrent();
    }
    const result = {
      issuer,
      personal: connection
        ? {
            state:
              selected?.kind === "connected" && !selected.refresh && !selected.refreshFailure
                ? ("connected" as const)
                : ("disconnected" as const),
            generation: connection.generation,
            account:
              selected?.kind === "connected"
                ? { accountId: selected.account.accountId, login: selected.account.login }
                : null,
            accessExpiresAtMs: selected?.kind === "connected" ? selected.tokens.expiresAtMs : null,
            refreshState:
              selected?.kind === "connected" && (selected.refresh || selected.refreshFailure)
                ? ("failed" as const)
                : selected?.kind === "connected"
                  ? ("available" as const)
                  : ("not_applicable" as const),
            pending: null,
          }
        : null,
      shared:
        sharedCredential && sharedCredential.publisher.source !== "personal"
          ? {
              source: sharedCredential.publisher.source,
              accountId: sharedCredential.account.accountId,
              login: sharedCredential.account.login,
            }
          : null,
      sharedUnavailableReason: sharedCredential
        ? undefined
        : configuredShared
          ? ("unverified" as const)
          : ("unavailable" as const),
      pendingPersonal: personalPending,
      latestShared: sharedPending,
      target: target ? { repository: target.repository, branch: target.branch } : null,
    };
    return result;
  } finally {
    sharedCredential?.close();
  }
}

export async function readPersonalGitLabPublicationStatus(
  options: Options,
  action: GitLabPublicationReadAction,
  credential: GitLabPublicationCredential | null,
  requestId: string,
) {
  const row = await readGitLabPublicationForAction(action, issuerFor(options), {
    requestId,
  });
  action.assertCurrent();
  if (!row) {
    throw new Error("GitLab publication request was not found.");
  }
  let currentCredential = credential;
  try {
    currentCredential?.assertCurrent();
  } catch {
    action.assertCurrent();
    currentCredential = null;
  }
  return projectStatus(row, action, currentCredential);
}

export async function requestPersonalGitLabPublication(
  options: Options,
  action: PersonalForgePublicationActionV2,
  credential: GitLabPublicationCredential,
  params: SessionGitLabPublishParams,
) {
  const requestId = requestIdFor(action, issuerFor(options), params.idempotencyKey);
  const existing = await readGitLabPublicationForAction(action, credential.account.issuer, {
    requestId,
  });
  if (existing) {
    const saved = assertReceiptSession(existing, action);
    if (
      !sameGitLabPublicationPublisher(saved.publisher, credential.publisher) ||
      existing.connection_generation !== credential.generation ||
      saved.title !== (params.title ?? `Publish ${saved.branch}`) ||
      saved.description !== (params.body ?? "") ||
      saved.draft !== (params.draft ?? true) ||
      (saved.bootstrapDraft ?? false) !== (params.bootstrapDraft ?? false) ||
      (params.baseBranch !== undefined && saved.target.baseBranch !== params.baseBranch)
    ) {
      throw new Error("The idempotency key belongs to a different accepted GitLab publication.");
    }
    return projectStatus(existing, action, credential).result;
  }
  const unresolved =
    credential.publisher.source === "personal"
      ? await readPersonalGitLabPublicationAsync(action.owner, credential.account.issuer, {
          sessionKey: action.sessionKey,
          agentId: action.agentId,
        })
      : await readSharedGitLabPublicationForAction(action, credential.account.issuer, {
          pending: true,
        });
  if (
    unresolved &&
    unresolved.session_id === action.sessionId &&
    unresolved.session_lifecycle_revision === action.lifecycleRevision &&
    unresolved.request_id !== requestId
  ) {
    throw new Error(
      "An earlier GitLab publication is unresolved; recover its original request before starting another.",
    );
  }
  const target = await targetFor(options, action);
  const project = await preparePersonalGitLabPublicationProject(
    options,
    action,
    credential,
    target,
  );
  await runPersonalGitLabPublication(options, action, credential, {
    requestId,
    idempotencyKey: params.idempotencyKey,
    projectId: project.id,
    title: params.title ?? `Publish ${target.branch}`,
    description: params.body,
    draft: params.draft,
    bootstrapDraft: params.bootstrapDraft,
    baseBranch: params.baseBranch,
  });
  return (await readPersonalGitLabPublicationStatus(options, action, credential, requestId)).result;
}

export async function confirmPersonalGitLabPublication(
  options: Options,
  action: PersonalForgePublicationActionV2,
  credential: GitLabPublicationCredential,
  params: SessionGitLabConfirmParams,
) {
  const row = await readGitLabPublicationForAction(action, issuerFor(options), {
    requestId: params.requestId,
  });
  const saved = row ? assertReceiptSession(row, action) : null;
  if (
    !row ||
    !saved ||
    !sameGitLabPublicationPublisher(saved.publisher, credential.publisher) ||
    row.request_digest !== params.requestDigest ||
    row.connection_generation !== params.generation ||
    row.identity_account_id !== params.account.accountId ||
    credential.account.login !== params.account.login ||
    credential.generation !== params.generation ||
    credential.account.accountId !== row.identity_account_id
  ) {
    throw new Error("GitLab confirmation no longer matches the accepted request.");
  }
  if (row.status !== "needs_confirmation") {
    return projectStatus(row, action, credential).result;
  }
  await runPersonalGitLabPublication(options, action, credential, {
    requestId: row.request_id,
    idempotencyKey: row.idempotency_key,
    projectId: saved.target.projectId,
    title: saved.title,
    description: saved.description,
    draft: saved.draft,
    bootstrapDraft: saved.bootstrapDraft,
    baseBranch: saved.target.baseBranch,
  });
  return (await readPersonalGitLabPublicationStatus(options, action, credential, row.request_id))
    .result;
}
