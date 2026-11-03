import type {
  GitHubPublicationPublisher,
  SessionGitHubPublishParams,
} from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import type { GitHubPublicationExecutionRow } from "../state/github-publication-read.types.js";
import type { prepareGitHubPublicationWorkspaceOwner } from "./github-publication-availability.js";
import {
  RepositoryPublicationAuthorityLostError,
  RepositoryPublicationChangePermissionError,
  RepositoryPublicationFailureError,
} from "./github-publication-errors.js";
import {
  assertNativePublisherProvenance,
  matchesPublisherProvenance,
  publisherProvenance,
} from "./github-publication-publisher-facts.js";
import type { GitHubPublicationRequesterPolicy } from "./github-publication-requester.js";
import type {
  RepositoryPublicationProvider,
  RepositoryPublicationPublisher,
  RepositoryPublicationPersonalSessionAction,
} from "./repository-publication-contract.js";
export type NativeReceiptPublisher = ReturnType<typeof storagePublisher>;
function storagePublisher(lease: RepositoryPublicationPublisher) {
  lease.assertCurrent();
  assertNativePublisherProvenance(lease.provenance);
  return { ...lease.provenance, lease };
}
export async function prepareCurrentPublisher(
  provider: RepositoryPublicationProvider,
  agentId: string,
) {
  return storagePublisher(await provider.preparePublisher(agentId));
}
export function matchesCurrentPublisher(identity: NativeReceiptPublisher): boolean {
  try {
    identity.lease.assertCurrent();
    return true;
  } catch {
    return false;
  }
}
export async function bindPersonalPublisher(
  provider: RepositoryPublicationProvider,
  action: RepositoryPublicationPersonalSessionAction,
  selected: { generation: string; account: { accountId: number; login: string } },
  preparation?: { idempotencyKey: string; hasRequest: () => boolean },
) {
  const binding = await provider.bindPersonal({
    action: { owner: action.owner, agentId: action.agentId, assertCurrent: action.assertCurrent },
    selected,
    preparation,
  });
  const facts = binding.provenance;
  assertNativePublisherProvenance(facts);
  return { ...binding, profileId: facts.profileId, accountId: facts.account.accountId };
}
export async function preparePersonalPublisher(
  bound: Awaited<ReturnType<typeof bindPersonalPublisher>>,
  assertWorkspace: () => void,
) {
  return storagePublisher(await bound.prepare(assertWorkspace));
}
export function assertExpectedPublisher(
  expected: GitHubPublicationPublisher | undefined,
  actual: GitHubPublicationPublisher,
  preparation?: { idempotencyKey: string; hasRequest: () => boolean },
) {
  if (
    actual.source === "personal" ||
    (expected &&
      (expected.source !== actual.source ||
        expected.accountId !== actual.accountId ||
        expected.login.toLowerCase() !== actual.login.toLowerCase()))
  ) {
    let rejection;
    try {
      if (preparation && !preparation.hasRequest()) {
        rejection = {
          code: "GITHUB_PUBLICATION_SELECTION_REJECTED" as const,
          idempotencyKey: preparation.idempotencyKey,
        };
      }
    } catch {}
    throw new RepositoryPublicationFailureError(
      "Publication identity changed; review the selected shared account.",
      {
        code: "identity_changed",
        nextAction: "Review the current shared publisher and request publication again.",
      },
      rejection,
    );
  }
}
export function assertPersonalReplay(
  existing: {
    connection_generation: string | null;
    identity_account_id: number;
    identity_login: string;
    title: string | null;
    body: string | null;
    draft: number | null;
  },
  input: Pick<SessionGitHubPublishParams, "title" | "body" | "draft">,
  selected: { generation: string; account: { accountId: number; login: string } },
) {
  if (
    existing.connection_generation !== selected.generation ||
    existing.identity_account_id !== selected.account.accountId ||
    existing.identity_login.toLowerCase() !== selected.account.login.toLowerCase() ||
    existing.title !== (input.title ?? null) ||
    existing.body !== (input.body ?? null) ||
    (existing.draft == null
      ? input.draft === false
      : existing.draft !== Number(input.draft ?? false))
  ) {
    throw new Error("My GitHub publication idempotency key was reused with a different selection.");
  }
}
export function matchesPublisherRow(
  row: {
    identity_source: string;
    identity_profile_id: string | null;
    identity_account_id: number;
    identity_login: string;
  },
  identity: NativeReceiptPublisher,
) {
  return (
    row.identity_source === identity.source &&
    row.identity_profile_id === (identity.profileId ?? null) &&
    row.identity_account_id === identity.account.accountId &&
    row.identity_login.toLowerCase() === identity.account.login.toLowerCase()
  );
}
export function sameGitHubPublicationWorkspace(
  first: Awaited<ReturnType<typeof prepareGitHubPublicationWorkspaceOwner>>["initial"],
  current: Awaited<ReturnType<typeof prepareGitHubPublicationWorkspaceOwner>>["initial"],
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
export function assertPublicationChangePermission(requester: GitHubPublicationRequesterPolicy) {
  requester.assertCurrent();
  if (
    !roleScopesAllow({
      role: "operator",
      requestedScopes: ["operator.write"],
      allowedScopes: requester.snapshot.scopes,
    })
  ) {
    throw new RepositoryPublicationChangePermissionError();
  }
}

export function createExecutionPublisher(params: {
  row: Pick<
    GitHubPublicationExecutionRow,
    | "identity_source"
    | "identity_profile_id"
    | "identity_account_id"
    | "identity_login"
    | "agent_id"
  >;
  provider: RepositoryPublicationProvider;
  publisher?: () => Promise<RepositoryPublicationPublisher>;
  validateAuthority: () => boolean;
  assertWorkspace: () => void;
}) {
  let active: RepositoryPublicationPublisher | undefined;
  const assertCurrent = () => {
    if (!params.validateAuthority()) {
      throw new RepositoryPublicationAuthorityLostError("Publication authority changed.");
    }
    params.assertWorkspace();
    params.provider.assertCurrent();
    active?.assertCurrent();
  };
  return {
    assertCurrent,
    refreshIdentity: async () => {
      assertCurrent();
      if (!active) {
        active = await (params.publisher?.() ??
          params.provider.preparePublisher(params.row.agent_id, publisherProvenance(params.row)));
        assertNativePublisherProvenance(active.provenance);
      } else {
        await active.refresh();
      }
      assertCurrent();
      if (!matchesPublisherProvenance(params.row, active.provenance)) {
        throw new Error("Publication publisher changed.");
      }
      return active;
    },
  };
}
