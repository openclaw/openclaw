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
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import type { GitHubPublicationSessionLifecycle } from "../state/github-publication-read.types.js";
import {
  readGitHubPublicationSessionLifecycle,
  readGitHubPublicationSessionLifecycleInWorker,
} from "../state/github-publication-session-lifecycles.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  getSessionRepositoryWorkspaceStore,
  type PreparedRepositoryWorkspace,
} from "../state/session-repository-workspaces.js";
import {
  prepareUserGitHubConnection,
  readPreparedUserGitHubConnection,
} from "../state/user-github-connections.js";
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
  GitHubPublicationRequesterUnavailableError,
  rejectGitHubPublicationSelection,
  type GitHubPublicationPreparation,
} from "./github-publication-failure.js";
import { captureGitHubPublicationWorkspaceSnapshot } from "./github-publication-git-transport.js";
import { projectGitHubPublicationResult } from "./github-publication-receipt.js";
import { insertPersonalGitHubPublicationAsync } from "./github-publication-request-async.js";
import type { GitHubPublicationRequesterV2 } from "./github-publication-requester.js";
import { bindGitHubPublicationSourceLifetime } from "./github-publication-source.js";
import {
  claimPersonalGitHubPublicationAsync,
  readPersonalGitHubPublicationAsync,
  readRepositoryGitHubPublicationAsync,
  type GitHubPublicationTransitionAuthority,
} from "./github-publication-store-async.js";
import { prepareGitHubPublicationTarget } from "./github-publication-target.js";
import { terminalRepositoryGitHubPublication } from "./github-repository-publication-store.js";
import { resolveReceiptOwner } from "./github-repository-publication-workspace.js";
import type { RepositoryGitHubPublicationStatusRow } from "./github-repository-publication.kernel.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

/** @deprecated Use PersonalGitHubSessionActionV2; removed in the next Plugin SDK major. */
export type PersonalGitHubSessionAction = PersonalGitHubAction & {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  lifecycleRevision: string | null;
};
export type PersonalGitHubSessionActionV2 = PersonalGitHubSessionAction &
  Pick<GitHubPublicationRequesterV2, "version" | "signal" | "prepareSource">;
type Selection = { generation: string; account: { accountId: number; login: string } };
type PersonalPublicationWorkspace = { assertCurrent: () => void; assertCustody: () => void };

export type PreparedRepositoryPublicationStatus = {
  requestId: string;
  workspaceId: string;
  repository: PreparedRepositoryWorkspace;
};

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
  receipt:
    | {
        kind: "worktree";
        row: PersonalGitHubPublicationRow;
        lifecycle: GitHubPublicationSessionLifecycle | undefined;
      }
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
  const sessionChanged =
    row.session_id !== session.sessionId ||
    (receipt.kind === "repository"
      ? receipt.row.session_lifecycle_revision !== (session.lifecycleRevision ?? null) ||
        !repositoryOwner
      : session.archivedAt != null ||
        !receipt.lifecycle ||
        receipt.lifecycle.lifecycle_revision !== (session.lifecycleRevision ?? null));
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

export async function bindPersonalGitHubPublicationSelection(
  action: PersonalGitHubSessionAction,
  selected: Selection,
  preparation?: GitHubPublicationPreparation,
) {
  await prepareUserGitHubConnection(action.owner);
  const assertCurrent = () => {
    action.assertCurrent();
    let record: ReturnType<typeof readPreparedUserGitHubConnection>;
    try {
      record = readPreparedUserGitHubConnection(action.owner);
    } catch {
      rejectGitHubPublicationSelection(
        "My GitHub identity changed; review the current account before publishing again.",
        preparation,
      );
    }
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
  bound: Awaited<ReturnType<typeof bindPersonalGitHubPublicationSelection>>,
  assertWorkspace: () => void,
) {
  const assertCurrent = () => {
    bound.assertCurrent();
    assertWorkspace();
  };
  assertCurrent();
  try {
    await requestCurrentPersonalGitHubRefresh(bound.owner);
    await prepareUserGitHubConnection(bound.owner);
  } catch {
    await prepareUserGitHubConnection(bound.owner);
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
  assertRuntimeCurrent = captureOpenClawStateWorkerContext().admission.assertCurrent,
  runtimeSignal?: AbortSignal,
) {
  const prepareSource = async (
    action: PersonalGitHubSessionActionV2,
    selector: Parameters<GitHubPublicationRequesterV2["prepareSource"]>[0],
  ) => {
    const source = await action.prepareSource(selector);
    try {
      assertRuntimeCurrent();
      return runtimeSignal ? bindGitHubPublicationSourceLifetime(source, runtimeSignal) : source;
    } catch (error) {
      await source.release();
      throw error;
    }
  };
  const instanceId = placements.workspaceResultInstanceId();
  const active = new Map<string, string>();
  const isExecuting = (row: PersonalGitHubPublicationRow) =>
    row.gateway_instance_id === instanceId &&
    row.execution_id !== null &&
    active.get(row.request_id) === row.execution_id;
  const needsStatusLifecycle = (row: PersonalGitHubPublicationRow) =>
    row.status !== "published" && row.status !== "failed" && !isExecuting(row);
  const readStatusLifecycle = (row: PersonalGitHubPublicationRow) =>
    needsStatusLifecycle(row)
      ? readGitHubPublicationSessionLifecycleInWorker({
          publicationKind: "personal",
          requestId: row.request_id,
        })
      : undefined;
  const status = (
    row: PersonalGitHubPublicationRow,
    action: PersonalGitHubAction,
    session: SessionIdentity & { archivedAt?: number | null },
    lifecycle: GitHubPublicationSessionLifecycle | undefined,
  ) =>
    presentPersonalGitHubPublicationStatus(
      { kind: "worktree", row, lifecycle },
      action,
      session,
      isExecuting(row),
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
    action: PersonalGitHubSessionAction | PersonalGitHubSessionActionV2,
    row: PersonalGitHubPublicationRow,
    workspace: PersonalPublicationWorkspace,
  ): Promise<SessionGitHubPublicationResult> => {
    const selected = {
      generation: row.connection_generation,
      account: { accountId: row.identity_account_id, login: row.identity_login },
    };
    const bound = await bindPersonalGitHubPublicationSelection(action, selected);
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
    const authority: GitHubPublicationTransitionAuthority | undefined =
      "version" in action
        ? {
            assertAction: assertCurrent,
            assertCustody: assertRuntimeCurrent,
            prepareSource: () =>
              prepareSource(action, {
                agentId: row.agent_id,
                sessionKey: row.session_key,
                sessionId: row.session_id,
                lifecycleRevision: action.lifecycleRevision,
                worktreeId: row.worktree_id,
                personalOwnerProfileId: action.owner,
              }),
          }
        : undefined;
    const execution = authority
      ? await claimPersonalGitHubPublicationAsync(row, instanceId, authority)
      : claimPersonalGitHubPublication(row, instanceId, assertCurrent);
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
        await execution.interrupt();
      } catch {
        /* Permanent deletion or a newer execution already fenced this operation. */
      }
      throw error;
    } finally {
      active.delete(row.request_id);
    }
  };
  const methods = {
    /** @deprecated Use requestPersonalForSessionV2; removed in the next Plugin SDK major. */
    async requestPersonalForSession(
      input: SessionGitHubPublishParams,
      action: PersonalGitHubSessionAction | PersonalGitHubSessionActionV2,
    ): Promise<SessionGitHubPublicationResult> {
      if (input.selection?.source !== "personal" || input.idempotencyKey.length > 128) {
        throw new Error("My GitHub publication requires an explicit bounded account selection.");
      }
      const selected = input.selection;
      action.assertCurrent();
      const request = { sessionId: action.sessionId, idempotencyKey: input.idempotencyKey };
      const existing =
        "version" in action
          ? await readPersonalGitHubPublicationAsync(action.owner, request)
          : readPersonalGitHubPublication(action.owner, request);
      action.assertCurrent();
      if (existing) {
        assertPersonalGitHubPublicationReplay(existing, input, selected);
        action.assertCurrent();
        const lifecycle = await readStatusLifecycle(existing);
        action.assertCurrent();
        return status(existing, action, action, lifecycle).result;
      }
      const bound = await bindPersonalGitHubPublicationSelection(action, selected, {
        idempotencyKey: input.idempotencyKey,
        hasRequest: () =>
          Boolean(
            "version" in action ? existing : readPersonalGitHubPublication(action.owner, request),
          ),
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
        let accepted: PersonalGitHubPublicationRow;
        if ("version" in action) {
          const source = await prepareSource(action, {
            agentId: action.agentId,
            sessionKey: action.sessionKey,
            sessionId: action.sessionId,
            lifecycleRevision: action.lifecycleRevision,
            personalOwnerProfileId: action.owner,
            worktreeId: worktree.id,
          });
          try {
            assertCurrent();
            accepted = await insertPersonalGitHubPublicationAsync(
              row,
              action.lifecycleRevision,
              source,
            );
          } finally {
            await source.release();
          }
        } else {
          accepted = insertPersonalGitHubPublication(row, action.lifecycleRevision, assertCurrent);
        }
        return await execute(action, accepted, workspace);
      });
    },
    /** @deprecated Use personalStatusAsync; removed in the next Plugin SDK major. */
    personalStatus(
      action: PersonalGitHubAction,
      session: SessionIdentity & { archivedAt?: number | null },
      requestId: string,
    ) {
      warnPluginSdkDeprecation({
        family: "github-publication",
        method: "personalStatus",
        replacement: "personalStatusAsync",
      });
      action.assertCurrent();
      const row = readPersonalGitHubPublication(action.owner, { requestId });
      if (!row || row.session_key !== session.sessionKey || row.agent_id !== session.agentId) {
        throw new Error("My GitHub publication was not found for this profile and session.");
      }
      return status(
        row,
        action,
        session,
        needsStatusLifecycle(row)
          ? readGitHubPublicationSessionLifecycle({ publicationKind: "personal", requestId })
          : undefined,
      );
    },
    async personalStatusAsync(
      action: PersonalGitHubAction,
      session: SessionIdentity & { archivedAt?: number | null },
      requestId: string,
    ) {
      action.assertCurrent();
      const row = await readPersonalGitHubPublicationAsync(action.owner, { requestId });
      if (!row || row.session_key !== session.sessionKey || row.agent_id !== session.agentId) {
        throw new Error("My GitHub publication was not found for this profile and session.");
      }
      const lifecycle = await readStatusLifecycle(row);
      action.assertCurrent();
      return status(row, action, session, lifecycle);
    },
    async personalPending(
      action: PersonalGitHubAction,
      session: SessionIdentity & { archivedAt?: number | null },
    ) {
      action.assertCurrent();
      const row = await readPersonalGitHubPublicationAsync(action.owner, {
        sessionKey: session.sessionKey,
        agentId: session.agentId,
      });
      const lifecycle = row ? await readStatusLifecycle(row) : undefined;
      action.assertCurrent();
      return row ? status(row, action, session, lifecycle) : null;
    },
    /** @deprecated Use confirmPersonalV2; removed in the next Plugin SDK major. */
    async confirmPersonal(
      input: SessionGitHubConfirmParams,
      action: PersonalGitHubSessionAction | PersonalGitHubSessionActionV2,
    ): Promise<SessionGitHubPublicationResult> {
      action.assertCurrent();
      const request = { requestId: input.requestId };
      const lifecycleRequest = {
        publicationKind: "personal" as const,
        requestId: input.requestId,
      };
      const [row, lifecycle] = await Promise.all([
        readPersonalGitHubPublicationAsync(action.owner, request),
        readGitHubPublicationSessionLifecycleInWorker(lifecycleRequest),
      ]);
      action.assertCurrent();
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
      await bindPersonalGitHubPublicationSelection(action, input);
      return await withWorkspace(
        action,
        async (workspace) => await execute(action, row, workspace),
      );
    },
  };
  return {
    ...methods,
    /** @deprecated Use requestPersonalForSessionV2; removed in the next Plugin SDK major. */
    requestPersonalForSession(
      input: SessionGitHubPublishParams,
      action: PersonalGitHubSessionAction,
    ) {
      warnPluginSdkDeprecation({
        family: "github-publication",
        method: "requestPersonalForSession",
        replacement: "requestPersonalForSessionV2",
      });
      return methods.requestPersonalForSession(input, action);
    },
    /** @deprecated Use confirmPersonalV2; removed in the next Plugin SDK major. */
    confirmPersonal(input: SessionGitHubConfirmParams, action: PersonalGitHubSessionAction) {
      warnPluginSdkDeprecation({
        family: "github-publication",
        method: "confirmPersonal",
        replacement: "confirmPersonalV2",
      });
      return methods.confirmPersonal(input, action);
    },
    requestPersonalForSessionV2(
      input: SessionGitHubPublishParams,
      action: PersonalGitHubSessionActionV2,
    ) {
      if (action.version !== 2) {
        throw new GitHubPublicationRequesterUnavailableError();
      }
      return methods.requestPersonalForSession(input, action);
    },
    confirmPersonalV2(input: SessionGitHubConfirmParams, action: PersonalGitHubSessionActionV2) {
      if (action.version !== 2) {
        throw new GitHubPublicationRequesterUnavailableError();
      }
      return methods.confirmPersonal(input, action);
    },
  };
}
