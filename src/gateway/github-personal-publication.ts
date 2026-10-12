import { randomUUID } from "node:crypto";
import type {
  SessionGitHubConfirmParams,
  SessionGitHubPublicationResult,
  SessionGitHubPublishParams,
} from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { preparePersonalGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import { acquireWorktreeRunLease } from "../agents/worktrees/run-lease.js";
import { resolveSessionWorkStartError } from "../config/sessions/lifecycle.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import {
  readGitHubPublicationSessionLifecycle,
  readGitHubPublicationSessionLifecycleInWorker,
} from "../state/github-publication-session-lifecycles.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { prepareUserGitHubConnection } from "../state/user-github-connections.js";
import { requestCurrentPersonalGitHubRefresh } from "./github-oauth-lifecycle.js";
import type { PersonalGitHubAction } from "./github-personal-oauth.js";
import {
  presentPersonalGitHubPublicationStatus,
  presentPersonalGitHubPublicationStatusAsync,
} from "./github-personal-publication-status.js";
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
  type GitHubPublicationTransitionAuthority,
} from "./github-publication-store-async.js";
import { prepareGitHubPublicationTarget } from "./github-publication-target.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

export {
  preparePersonalRepositoryPublicationStatus,
  presentPersonalGitHubPublicationStatus,
  presentPersonalGitHubPublicationStatusAsync,
  type PreparedRepositoryPublicationStatus,
} from "./github-personal-publication-status.js";

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
  let prepared = await prepareUserGitHubConnection(action.owner);
  const assertCurrent = () => {
    action.assertCurrent();
    prepared.assertCurrent();
    const record = prepared.connection;
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
    async refresh() {
      prepared = await prepareUserGitHubConnection(action.owner);
      assertCurrent();
    },
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
  } catch {
    assertWorkspace();
    throw new Error(
      "My GitHub credentials are unavailable; reconnect My GitHub before publishing.",
    );
  }
  await bound.refresh();
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
  const statusAsync = async (
    row: PersonalGitHubPublicationRow,
    action: PersonalGitHubAction,
    session: SessionIdentity & { archivedAt?: number | null },
  ) =>
    presentPersonalGitHubPublicationStatusAsync(
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
        return (await statusAsync(existing, action, action)).result;
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
      return await statusAsync(row, action, session);
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
      return row ? await statusAsync(row, action, session) : null;
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
      const [row, lifecycle] =
        "version" in action
          ? await Promise.all([
              readPersonalGitHubPublicationAsync(action.owner, request),
              readGitHubPublicationSessionLifecycleInWorker(lifecycleRequest),
            ])
          : [
              readPersonalGitHubPublication(action.owner, request),
              readGitHubPublicationSessionLifecycle(lifecycleRequest),
            ];
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
