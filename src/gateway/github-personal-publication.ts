import { randomUUID } from "node:crypto";
import type {
  SessionGitHubConfirmParams,
  SessionGitHubPublicationResult,
  SessionGitHubPublishParams,
  SessionGitHubStatusResult,
} from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { preparePersonalGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import { acquireWorktreeRunLease } from "../agents/worktrees/run-lease.js";
import { resolveSessionWorkStartError } from "../config/sessions/lifecycle.js";
import { readGitHubPublicationSessionLifecycle } from "../state/github-publication-session-lifecycles.js";
import {
  getSessionRepositoryWorkspaceStore,
  type PreparedRepositoryWorkspace,
} from "../state/session-repository-workspaces.js";
import { readUserGitHubConnection } from "../state/user-github-connections.js";
import { requestCurrentPersonalGitHubRefresh } from "./github-oauth-lifecycle.js";
import { personalGitHubStatus, type PersonalGitHubAction } from "./github-personal-oauth.js";
import {
  claimPersonalGitHubPublication,
  insertPersonalGitHubPublication,
  personalGitHubRequestDigest,
  readPersonalGitHubPublication,
  type PersonalGitHubPublicationRow,
} from "./github-personal-publication-store.js";
import {
  readGitHubPublicationWorktreeOwner,
  type PublicationSessionIdentity as SessionIdentity,
} from "./github-publication-availability.js";
import { executeGitHubPublication } from "./github-publication-executor.js";
import {
  rejectGitHubPublicationSelection,
  type GitHubPublicationPreparation,
} from "./github-publication-failure.js";
import { captureGitHubPublicationWorkspaceSnapshot } from "./github-publication-git-transport.js";
import { projectGitHubPublicationResult } from "./github-publication-receipt.js";
import { prepareGitHubPublicationTarget } from "./github-publication-target.js";
import {
  readRepositoryGitHubPublication,
  terminalRepositoryGitHubPublication,
} from "./github-repository-publication-store.js";
import { resolveReceiptOwner } from "./github-repository-publication-workspace.js";
import type { RepositoryGitHubPublicationStatusRow } from "./github-repository-publication.kernel.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

export type PersonalGitHubSessionAction = PersonalGitHubAction & {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  lifecycleRevision: string | null;
};
type Selection = { generation: string; account: { accountId: number; login: string } };
type PersonalPublicationWorkspace = { assertCurrent: () => void; assertCustody: () => void };

export type PreparedRepositoryPublicationStatus = {
  requestId: string;
  workspaceId: string;
  repository: PreparedRepositoryWorkspace;
};

export async function preparePersonalRepositoryPublicationStatus(requestId: string) {
  const row = readRepositoryGitHubPublication(requestId);
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
  receipt:
    | { kind: "worktree"; row: PersonalGitHubPublicationRow }
    | {
        kind: "repository";
        row: RepositoryGitHubPublicationStatusRow;
        prepared: PreparedRepositoryPublicationStatus | undefined;
      },
  action: PersonalGitHubAction,
  session: SessionIdentity & { archivedAt?: number | null },
  executing: boolean,
): SessionGitHubStatusResult {
  const { row } = receipt;
  const pending =
    receipt.kind === "repository"
      ? !terminalRepositoryGitHubPublication(row) && !executing
      : row.status === "needs_confirmation" ||
        ((row.status === "requested" || row.status === "publishing") && !executing);
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
  const connection = pending ? personalGitHubStatus(action) : null;
  const lifecycle =
    pending && receipt.kind === "worktree"
      ? readGitHubPublicationSessionLifecycle({
          publicationKind: "personal",
          requestId: row.request_id,
        })
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

export function assertPersonalGitHubPublicationReplay(
  existing: {
    connection_generation: string | null;
    identity_account_id: number;
    identity_login: string;
    title: string | null;
    body: string | null;
  },
  input: Pick<SessionGitHubPublishParams, "title" | "body">,
  selected: Selection,
): void {
  if (
    existing.connection_generation !== selected.generation ||
    existing.identity_account_id !== selected.account.accountId ||
    existing.identity_login.toLowerCase() !== selected.account.login.toLowerCase() ||
    existing.title !== (input.title ?? null) ||
    existing.body !== (input.body ?? null)
  ) {
    throw new Error("My GitHub publication idempotency key was reused with a different selection.");
  }
}

export function bindPersonalGitHubPublicationSelection(
  action: PersonalGitHubSessionAction,
  selected: Selection,
  preparation?: GitHubPublicationPreparation,
) {
  const assertCurrent = () => {
    action.assertCurrent();
    const record = readUserGitHubConnection(action.owner);
    if (
      record?.generation !== selected.generation ||
      record.selection.kind !== "connected" ||
      record.selection.accountId !== selected.account.accountId ||
      record.selection.login.toLowerCase() !== selected.account.login.toLowerCase()
    ) {
      rejectGitHubPublicationSelection(
        "My GitHub identity changed; review the current account before publishing again.",
        preparation,
      );
    }
    return record.selection;
  };
  const initial = assertCurrent();
  return {
    owner: action.owner,
    profileId: initial.profileId,
    accountId: initial.accountId,
    assertCurrent,
  };
}

export async function preparePersonalGitHubPublicationSelection(
  bound: ReturnType<typeof bindPersonalGitHubPublicationSelection>,
  assertWorkspace: () => void,
) {
  const assertCurrent = () => {
    bound.assertCurrent();
    assertWorkspace();
  };
  assertCurrent();
  try {
    await requestCurrentPersonalGitHubRefresh(bound.owner);
  } catch {
    assertCurrent();
    throw new Error(
      "My GitHub credentials are unavailable; reconnect My GitHub before publishing.",
    );
  }
  assertCurrent();
  return await preparePersonalGitHubPublicationIdentity({
    profileId: bound.profileId,
    accountId: bound.accountId,
    assertCurrent,
  });
}

export function createPersonalGitHubPublicationCoordinator(
  placements: WorkerSessionPlacementStore,
) {
  const instanceId = placements.workspaceResultInstanceId();
  const active = new Map<string, string>();
  const status = (
    row: PersonalGitHubPublicationRow,
    action: PersonalGitHubAction,
    session: SessionIdentity & { archivedAt?: number | null },
  ) =>
    presentPersonalGitHubPublicationStatus(
      { kind: "worktree", row },
      action,
      session,
      row.gateway_instance_id === instanceId &&
        row.execution_id !== null &&
        active.get(row.request_id) === row.execution_id,
    );
  const withWorkspace = async <T>(
    action: PersonalGitHubSessionAction,
    run: (workspace: PersonalPublicationWorkspace) => Promise<T>,
  ): Promise<T> => {
    action.assertCurrent();
    return await placements.withLocalWorkspaceReservation(action, async (assertReservation) => {
      const worktreeOwner = await readGitHubPublicationWorktreeOwner(action);
      const { worktree } = worktreeOwner;
      action.assertCurrent();
      assertReservation();
      const lease = await acquireWorktreeRunLease(worktree.id, { exclusive: true });
      const assertCustody = () => {
        assertReservation();
        const current = worktreeOwner.assertCurrent();
        const workStartError = resolveSessionWorkStartError(
          action.sessionKey,
          current.loaded.entry,
          { expectedSessionId: action.sessionId },
        );
        if (workStartError) {
          throw new Error(workStartError);
        }
      };
      const assertCurrent = () => {
        action.assertCurrent();
        assertCustody();
      };
      try {
        assertCurrent();
        return await run({ assertCurrent, assertCustody });
      } finally {
        await lease.release();
      }
    });
  };
  const execute = async (
    action: PersonalGitHubSessionAction,
    row: PersonalGitHubPublicationRow,
    workspace: PersonalPublicationWorkspace,
  ): Promise<SessionGitHubPublicationResult> => {
    const selected = {
      generation: row.connection_generation,
      account: { accountId: row.identity_account_id, login: row.identity_login },
    };
    const bound = bindPersonalGitHubPublicationSelection(action, selected);
    const assertCurrent = () => {
      bound.assertCurrent();
      workspace.assertCurrent();
      if (
        bound.profileId !== row.identity_profile_id ||
        action.sessionId !== row.session_id ||
        action.owner !== row.owner_profile_id
      ) {
        throw new Error("My GitHub publication owner changed.");
      }
    };
    assertCurrent();
    const execution = claimPersonalGitHubPublication(row, instanceId, assertCurrent);
    active.set(row.request_id, execution.row.execution_id);
    try {
      return await executeGitHubPublication<PersonalGitHubPublicationRow>({
        initial: execution.row,
        validateAuthority: () => {
          assertCurrent();
          return execution.ownsExecution();
        },
        validateCustody: () => {
          workspace.assertCustody();
          return execution.ownsExecution();
        },
        assertWorkflowChangesAllowed: assertCurrent,
        identity: {
          prepare: async () =>
            await preparePersonalGitHubPublicationSelection(bound, workspace.assertCurrent),
          isCurrent: (identity) => {
            assertCurrent();
            return (
              identity.source === "personal" &&
              identity.profileId === bound.profileId &&
              identity.account.accountId === selected.account.accountId
            );
          },
        },
        target: {
          pushRepository: row.push_repository,
          repository: row.repository,
          baseBranch: row.base_branch,
        },
        bindWorkspaceSnapshot: () => {
          throw new Error("My GitHub publication is missing its accepted snapshot.");
        },
        updatePublishingFacts: (facts) => {
          assertCurrent();
          if (
            facts.repository !== row.repository ||
            facts.branch !== row.branch ||
            facts.baseBranch !== row.base_branch ||
            facts.sourceHeadCommit !== row.source_head_commit ||
            facts.workspaceTree !== row.workspace_tree
          ) {
            throw new Error("My GitHub publication accepted workspace changed.");
          }
          return execution.updateHead(facts.headCommit);
        },
        complete: (_row, result) => execution.complete(result),
        recordEffect: execution.recordEffect.bind(execution),
        interrupt: execution.interrupt.bind(execution),
      });
    } catch (error) {
      try {
        execution.interrupt();
      } catch {
        /* Permanent deletion or a newer execution already fenced this operation. */
      }
      throw error;
    } finally {
      active.delete(row.request_id);
    }
  };
  return {
    async requestPersonalForSession(
      input: SessionGitHubPublishParams,
      action: PersonalGitHubSessionAction,
    ): Promise<SessionGitHubPublicationResult> {
      if (input.selection?.source !== "personal" || input.idempotencyKey.length > 128) {
        throw new Error("My GitHub publication requires an explicit bounded account selection.");
      }
      const selected = input.selection;
      action.assertCurrent();
      const readRequest = () =>
        readPersonalGitHubPublication(action.owner, {
          sessionId: action.sessionId,
          idempotencyKey: input.idempotencyKey,
        });
      const existing = readRequest();
      if (existing) {
        assertPersonalGitHubPublicationReplay(existing, input, selected);
        action.assertCurrent();
        return status(existing, action, action).result;
      }
      const bound = bindPersonalGitHubPublicationSelection(action, selected, {
        idempotencyKey: input.idempotencyKey,
        hasRequest: () => Boolean(readRequest()),
      });
      return await withWorkspace(action, async (workspace) => {
        const assertCurrent = () => {
          workspace.assertCurrent();
          bound.assertCurrent();
        };
        const { worktree } = await readGitHubPublicationWorktreeOwner(action);
        assertCurrent();
        const identity = await preparePersonalGitHubPublicationSelection(
          bound,
          workspace.assertCurrent,
        );
        const target = await prepareGitHubPublicationTarget({ worktree, identity, assertCurrent });
        const snapshot = await captureGitHubPublicationWorkspaceSnapshot({
          cwd: worktree.path,
          assertCurrent,
        });
        assertCurrent();
        const now = Date.now();
        const row: PersonalGitHubPublicationRow = {
          request_id: randomUUID(),
          owner_profile_id: action.owner,
          connection_generation: selected.generation,
          idempotency_key: input.idempotencyKey,
          request_digest: "",
          session_id: action.sessionId,
          session_key: action.sessionKey,
          agent_id: action.agentId,
          worktree_id: worktree.id,
          repository_fingerprint: worktree.repoFingerprint,
          identity_source: "personal",
          identity_profile_id: identity.profileId!,
          identity_account_id: identity.account.accountId,
          identity_login: identity.account.login,
          title: input.title ?? null,
          body: input.body ?? null,
          status: "requested",
          gateway_instance_id: instanceId,
          execution_id: null,
          push_repository: target.pushRepository,
          repository: target.repository,
          branch: target.branch,
          base_branch: target.baseBranch,
          source_head_commit: snapshot.sourceHeadCommit,
          source_index_tree: snapshot.sourceIndexTree,
          workspace_tree: snapshot.workspaceTree,
          head_commit: null,
          pull_request_url: null,
          error_code: null,
          next_action: null,
          last_effect: null,
          effect_state: null,
          created_at_ms: now,
          updated_at_ms: now,
          reported_at_ms: null,
        };
        row.request_digest = personalGitHubRequestDigest(row);
        return await execute(
          action,
          insertPersonalGitHubPublication(row, action.lifecycleRevision, assertCurrent),
          workspace,
        );
      });
    },
    personalStatus(
      action: PersonalGitHubAction,
      session: SessionIdentity & { archivedAt?: number | null },
      requestId: string,
    ) {
      action.assertCurrent();
      const row = readPersonalGitHubPublication(action.owner, { requestId });
      if (!row || row.session_key !== session.sessionKey || row.agent_id !== session.agentId) {
        throw new Error("My GitHub publication was not found for this profile and session.");
      }
      return status(row, action, session);
    },
    personalPending(
      action: PersonalGitHubAction,
      session: SessionIdentity & { archivedAt?: number | null },
    ) {
      action.assertCurrent();
      const row = readPersonalGitHubPublication(action.owner, {
        sessionKey: session.sessionKey,
        agentId: session.agentId,
      });
      return row ? status(row, action, session) : null;
    },
    async confirmPersonal(
      input: SessionGitHubConfirmParams,
      action: PersonalGitHubSessionAction,
    ): Promise<SessionGitHubPublicationResult> {
      action.assertCurrent();
      const row = readPersonalGitHubPublication(action.owner, { requestId: input.requestId });
      const lifecycle = readGitHubPublicationSessionLifecycle({
        publicationKind: "personal",
        requestId: input.requestId,
      });
      if (
        !row ||
        row.session_id !== action.sessionId ||
        (!(row.status === "published" || row.status === "failed") &&
          (!lifecycle || lifecycle.lifecycle_revision !== action.lifecycleRevision)) ||
        row.request_digest !== input.requestDigest ||
        row.connection_generation !== input.generation ||
        row.identity_account_id !== input.account.accountId ||
        row.identity_login.toLowerCase() !== input.account.login.toLowerCase()
      ) {
        throw new Error("My GitHub confirmation no longer matches the original request.");
      }
      if (row.status === "published" || row.status === "failed") {
        return projectGitHubPublicationResult(row);
      }
      if (active.has(row.request_id)) {
        throw new Error("My GitHub publication is still running; wait for its result.");
      }
      bindPersonalGitHubPublicationSelection(action, input);
      return await withWorkspace(
        action,
        async (workspace) => await execute(action, row, workspace),
      );
    },
  };
}
