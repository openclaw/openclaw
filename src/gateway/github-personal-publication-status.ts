import type { SessionGitHubStatusResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import {
  readGitHubPublicationSessionLifecycle,
  readGitHubPublicationSessionLifecycleInWorker,
} from "../state/github-publication-session-lifecycles.js";
import {
  getSessionRepositoryWorkspaceStore,
  type PreparedRepositoryWorkspace,
} from "../state/session-repository-workspaces.js";
import type { PersonalGitHubPublicationRow } from "./github-personal-publication-store.js";
import {
  personalGitHubStatus,
  personalGitHubStatusAsync,
  type PersonalGitHubAction,
} from "./github-personal-status.js";
import type { PublicationSessionIdentity as SessionIdentity } from "./github-publication-availability.js";
import { projectGitHubPublicationResult } from "./github-publication-receipt.js";
import { readRepositoryGitHubPublicationAsync } from "./github-publication-store-async.js";
import { terminalRepositoryGitHubPublication } from "./github-repository-publication-store.js";
import { resolveReceiptOwner } from "./github-repository-publication-workspace.js";
import type { RepositoryGitHubPublicationStatusRow } from "./github-repository-publication.kernel.js";

export type PreparedRepositoryPublicationStatus = {
  requestId: string;
  workspaceId: string;
  repository: PreparedRepositoryWorkspace;
};

type PersonalPublicationReceipt =
  | { kind: "worktree"; row: PersonalGitHubPublicationRow }
  | {
      kind: "repository";
      row: RepositoryGitHubPublicationStatusRow;
      prepared: PreparedRepositoryPublicationStatus | undefined;
    };

function isPendingPersonalPublication(receipt: PersonalPublicationReceipt, executing: boolean) {
  const { row } = receipt;
  return receipt.kind === "repository"
    ? !terminalRepositoryGitHubPublication(row) && !executing
    : row.status === "needs_confirmation" ||
        ((row.status === "requested" || row.status === "publishing") && !executing);
}

export async function preparePersonalRepositoryPublicationStatus(requestId: string) {
  const row = await readRepositoryGitHubPublicationAsync(requestId);
  return row && row.owner_profile_id !== null && !terminalRepositoryGitHubPublication(row)
    ? {
        requestId: row.request_id,
        workspaceId: row.workspace_id,
        repository: await getSessionRepositoryWorkspaceStore().prepare(row.workspace_id),
      }
    : undefined;
}

/** Source owners supply liveness; personal status never grants execution authority. */
export function presentPersonalGitHubPublicationStatus(
  receipt: PersonalPublicationReceipt,
  action: PersonalGitHubAction,
  session: SessionIdentity & { archivedAt?: number | null },
  executing: boolean,
  preparedConnection?: ReturnType<typeof personalGitHubStatus> | null,
  preparedLifecycle?: ReturnType<typeof readGitHubPublicationSessionLifecycle> | null,
): SessionGitHubStatusResult {
  const { row } = receipt;
  const pending = isPendingPersonalPublication(receipt, executing);
  let repositoryOwner: ReturnType<typeof resolveReceiptOwner>;
  if (receipt.kind === "repository") {
    action.assertCurrent();
    if (
      row.owner_profile_id !== action.owner ||
      row.session_key !== session.sessionKey ||
      row.agent_id !== session.agentId
    ) {
      throw new Error("My GitHub publication was not found for this profile and session.");
    }
    if (pending) {
      const { prepared } = receipt;
      if (
        !prepared ||
        prepared.requestId !== row.request_id ||
        prepared.workspaceId !== receipt.row.workspace_id
      ) {
        throw new Error("My GitHub publication source changed; refresh its status.");
      }
      repositoryOwner = resolveReceiptOwner(receipt.row, prepared.repository);
    }
  }
  const connection =
    preparedConnection === undefined
      ? pending
        ? personalGitHubStatus(action)
        : null
      : preparedConnection;
  const lifecycle =
    pending && receipt.kind === "worktree"
      ? preparedLifecycle === undefined
        ? readGitHubPublicationSessionLifecycle({
            publicationKind: "personal",
            requestId: row.request_id,
          })
        : preparedLifecycle
      : undefined;
  const sessionChanged =
    row.session_id !== session.sessionId ||
    (receipt.kind === "repository"
      ? receipt.row.session_lifecycle_revision !== (session.lifecycleRevision ?? null) ||
        !repositoryOwner
      : session.archivedAt != null ||
        !lifecycle ||
        lifecycle.lifecycle_revision !== (session.lifecycleRevision ?? null));
  const code = !pending
    ? null
    : sessionChanged
      ? "session_changed"
      : connection?.generation !== row.connection_generation ||
          connection.account?.accountId !== row.identity_account_id ||
          connection.account.login.toLowerCase() !== row.identity_login.toLowerCase()
        ? "identity_changed"
        : null;
  if (code) {
    return {
      result: projectGitHubPublicationResult({
        ...row,
        status: "failed",
        error_code: code,
        next_action:
          receipt.kind === "repository"
            ? "Review the original account and any recorded GitHub effects, then create a new publication for the current session."
            : code === "session_changed"
              ? "This request belongs to an earlier session incarnation. Review any recorded GitHub effects and create a new publication for the current session."
              : "The original My GitHub selection changed or is unavailable. Review any recorded GitHub effects, reconnect if needed, and create a new publication.",
      }),
      confirmation: null,
    };
  }
  const result = projectGitHubPublicationResult(
    pending ? { ...row, status: "needs_confirmation" } : row,
  );
  if (
    !pending ||
    (receipt.kind === "repository" &&
      (!row.connection_generation ||
        !row.push_repository ||
        !row.repository ||
        !row.base_branch ||
        !row.source_head_commit ||
        !row.source_index_tree ||
        !row.workspace_tree))
  ) {
    return { result, confirmation: null };
  }
  // Worktree fields are non-null; repository fields passed the guard above.
  return {
    result,
    confirmation: {
      requestDigest: row.request_digest,
      generation: row.connection_generation!,
      account: { accountId: row.identity_account_id, login: row.identity_login },
      pushRepository: row.push_repository!,
      repository: row.repository!,
      branch: row.branch,
      baseBranch: row.base_branch!,
      sourceHeadCommit: row.source_head_commit!,
      sourceIndexTree: row.source_index_tree!,
      workspaceTree: row.workspace_tree!,
    },
  };
}

export async function presentPersonalGitHubPublicationStatusAsync(
  receipt: PersonalPublicationReceipt,
  action: PersonalGitHubAction,
  session: SessionIdentity & { archivedAt?: number | null },
  executing: boolean,
): Promise<SessionGitHubStatusResult> {
  const pending = isPendingPersonalPublication(receipt, executing);
  const [connection, lifecycle] = await Promise.all([
    pending ? personalGitHubStatusAsync(action) : null,
    pending && receipt.kind === "worktree"
      ? readGitHubPublicationSessionLifecycleInWorker({
          publicationKind: "personal",
          requestId: receipt.row.request_id,
        })
      : null,
  ]);
  action.assertCurrent();
  return presentPersonalGitHubPublicationStatus(
    receipt,
    action,
    session,
    executing,
    connection,
    lifecycle ?? null,
  );
}

export function createRepositoryPersonalPublicationStatus(
  instanceId: string,
  active: ReadonlyMap<string, string>,
) {
  const personalStatus = (
    row: RepositoryGitHubPublicationStatusRow,
    action: PersonalGitHubAction,
    session: SessionIdentity,
    prepared: PreparedRepositoryPublicationStatus | undefined,
  ) =>
    presentPersonalGitHubPublicationStatus(
      { kind: "repository", row, prepared },
      action,
      session,
      row.execution_id !== null &&
        row.gateway_instance_id === instanceId &&
        active.get(row.request_id) === row.execution_id,
    );
  const personalStatusAsync = async (
    row: RepositoryGitHubPublicationStatusRow,
    action: PersonalGitHubAction,
    session: SessionIdentity,
    prepared: PreparedRepositoryPublicationStatus | undefined,
  ) =>
    presentPersonalGitHubPublicationStatusAsync(
      { kind: "repository", row, prepared },
      action,
      session,
      row.execution_id !== null &&
        row.gateway_instance_id === instanceId &&
        active.get(row.request_id) === row.execution_id,
    );
  return { personalStatus, personalStatusAsync };
}
