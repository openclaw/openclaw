import { randomUUID } from "node:crypto";
import type {
  SessionGitHubConfirmParams,
  SessionGitHubPublicationResult,
  SessionGitHubPublishParams,
  SessionGitHubStatusResult,
} from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { acquireWorktreeRunLease } from "../agents/worktrees/run-lease.js";
import { resolveSessionWorkStartError } from "../config/sessions/session-work-start.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import { readGitHubPublicationSessionLifecycleInWorker } from "../state/github-publication-session-lifecycles.js";
import { presentPersonalGitHubPublicationStatusAsync } from "./github-personal-publication-status.js";
import { personalGitHubRequestDigest } from "./github-personal-publication-store.js";
import type { PersonalGitHubPublicationRow } from "./github-personal-publication-store.worker.js";
import {
  readGitHubPublicationWorktreeOwner,
  readRepositoryPublicationTargetFacts,
} from "./github-publication-availability.js";
import { RepositoryPublicationRequesterUnavailableError } from "./github-publication-errors.js";
import { executeGitHubPublication } from "./github-publication-executor.js";
import { captureGitHubPublicationWorkspaceSnapshot } from "./github-publication-git-transport.js";
import {
  bindPersonalPublisher,
  preparePersonalPublisher,
  assertPersonalReplay as assertPersonalGitHubPublicationReplay,
} from "./github-publication-policy.js";
import { projectGitHubPublicationResult } from "./github-publication-receipt.js";
import { insertPersonalGitHubPublicationAsync } from "./github-publication-request-async.js";
import type { GitHubPublicationRequesterV2 } from "./github-publication-requester.js";
import type { PublicationSessionIdentity as SessionIdentity } from "./github-publication-session.types.js";
import { bindGitHubPublicationSourceLifetime } from "./github-publication-source.js";
import {
  claimPersonalGitHubPublicationAsync,
  readPersonalGitHubPublicationAsync,
} from "./github-publication-store-async.js";
import type { GitHubPublicationTransitionAuthority } from "./github-publication-store-async.js";
import type {
  RepositoryPublicationProvider,
  RepositoryPublicationPersonalAction as PersonalGitHubAction,
  RepositoryPublicationPersonalSessionAction as PersonalGitHubSessionActionV2,
} from "./repository-publication-contract.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
export type { RepositoryPublicationPersonalSessionAction as PersonalGitHubSessionActionV2 } from "./repository-publication-contract.js";
type PersonalPublicationWorkspace = {
  assertCurrent: () => void;
  assertCustody: () => void;
  worktree: Awaited<ReturnType<typeof readGitHubPublicationWorktreeOwner>>["worktree"];
};
export type PersonalGitHubSessionAction = PersonalGitHubAction & {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  lifecycleRevision: string | null;
};
export function createPersonalGitHubPublicationCoordinator(
  placements: WorkerSessionPlacementStore,
  assertRuntimeCurrent: () => void,
  runtimeSignal: AbortSignal | undefined,
  provider: RepositoryPublicationProvider,
  getCommittedRuntimeConfig: () => OpenClawConfig,
) {
  const bindPersonalGitHubPublicationSelection = (
    ...args: Parameters<typeof bindPersonalPublisher> extends [unknown, ...infer Rest]
      ? Rest
      : never
  ) => bindPersonalPublisher(provider, ...args);
  const preparePersonalGitHubPublicationSelection = preparePersonalPublisher;
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
  const status = async (
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
      provider,
    );
  const withWorkspace = async <T>(
    action: PersonalGitHubSessionAction,
    run: (workspace: PersonalPublicationWorkspace) => Promise<T>,
  ): Promise<T> => {
    action.assertCurrent();
    return await placements.withLocalWorkspaceReservation(action, async (assertReservation) => {
      const worktreeOwner = await readGitHubPublicationWorktreeOwner(action);
      using _ = { [Symbol.dispose]: () => worktreeOwner.release() };

      const { worktree } = worktreeOwner;
      action.assertCurrent();
      assertReservation();
      const lease = await acquireWorktreeRunLease(worktree.id, {
        exclusive: true,
      });
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
        return await run({ assertCurrent, assertCustody, worktree });
      } finally {
        await lease.release();
      }
    });
  };
  const execute = async (
    action: PersonalGitHubSessionActionV2,
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
    const authority: GitHubPublicationTransitionAuthority = {
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
    };
    const execution = await claimPersonalGitHubPublicationAsync(row, instanceId, authority);
    active.set(row.request_id, execution.row.execution_id);
    try {
      return await executeGitHubPublication<PersonalGitHubPublicationRow>({
        provider,
        config: getCommittedRuntimeConfig(),
        initial: execution.row,
        requesterProfileId: () => action.owner,
        validateAuthority: () => {
          assertCurrent();
          return execution.ownsExecution();
        },
        validateCustody: () => {
          workspace.assertCustody();
          return execution.ownsExecution();
        },
        assertWorkflowChangesAllowed: assertCurrent,
        publisher: async () =>
          (await preparePersonalGitHubPublicationSelection(bound, workspace.assertCurrent)).lease,
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
    async requestPersonalForSession(
      input: SessionGitHubPublishParams,
      action: PersonalGitHubSessionActionV2,
    ): Promise<SessionGitHubPublicationResult> {
      if (input.selection?.source !== "personal" || input.idempotencyKey.length > 128) {
        throw new Error("My GitHub publication requires an explicit bounded account selection.");
      }
      const selected = input.selection;
      action.assertCurrent();
      const request = { sessionId: action.sessionId, idempotencyKey: input.idempotencyKey };
      const existing = await readPersonalGitHubPublicationAsync(action.owner, request);
      action.assertCurrent();
      if (existing) {
        assertPersonalGitHubPublicationReplay(existing, input, selected);
        return (await status(existing, action, action)).result;
      }
      const bound = await bindPersonalGitHubPublicationSelection(action, selected, {
        idempotencyKey: input.idempotencyKey,
        hasRequest: () => Boolean(existing),
      });
      return await withWorkspace(action, async (workspace) => {
        const assertCurrent = () => {
          workspace.assertCurrent();
          bound.assertCurrent();
        };
        const { worktree } = workspace;
        assertCurrent();
        const identity = await preparePersonalGitHubPublicationSelection(
          bound,
          workspace.assertCurrent,
        );
        const target = await provider.prepareTarget({
          ...(await readRepositoryPublicationTargetFacts({ worktree, assertCurrent })),
          publisher: identity.lease,
          assertCurrent,
        });
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
          draft: input.draft ? 1 : 0,
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
        const source = await prepareSource(action, {
          agentId: action.agentId,
          sessionKey: action.sessionKey,
          sessionId: action.sessionId,
          lifecycleRevision: action.lifecycleRevision,
          personalOwnerProfileId: action.owner,
          worktreeId: worktree.id,
        });
        let accepted: PersonalGitHubPublicationRow;
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
        return await execute(action, accepted, workspace);
      });
    },
    async personalStatusAsync(
      action: PersonalGitHubAction,
      session: SessionIdentity & { archivedAt?: number | null },
      requestId: string,
    ) {
      action.assertCurrent();
      const row = await readPersonalGitHubPublicationAsync(action.owner, { requestId });
      action.assertCurrent();
      if (!row || row.session_key !== session.sessionKey || row.agent_id !== session.agentId) {
        throw new Error("My GitHub publication was not found for this profile and session.");
      }
      return status(row, action, session);
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
      action.assertCurrent();
      return row ? status(row, action, session) : null;
    },
    async confirmPersonal(
      input: SessionGitHubConfirmParams,
      action: PersonalGitHubSessionActionV2,
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
    /** @deprecated Await personalStatusAsync; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
    personalStatus(
      _action: PersonalGitHubAction,
      _session: SessionIdentity & { archivedAt?: number | null },
      _requestId: string,
    ): SessionGitHubStatusResult {
      warnPluginSdkDeprecation({
        family: "github-publication",
        compatibility: "This method no longer performs publication work; use its replacement.",
        method: "personalStatus",
        replacement: "personalStatusAsync",
      });
      throw new Error("GitHub publication requires awaiting personalStatusAsync.");
    },
    /** @deprecated Use requestPersonalForSessionV2; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
    async requestPersonalForSession(
      _input: SessionGitHubPublishParams,
      _action: PersonalGitHubSessionAction,
    ): Promise<SessionGitHubPublicationResult> {
      warnPluginSdkDeprecation({
        family: "github-publication",
        compatibility: "This method no longer performs publication work; use its replacement.",
        method: "requestPersonalForSession",
        replacement: "requestPersonalForSessionV2",
      });
      throw new Error(
        "GitHub publication requires requestPersonalForSessionV2 with a host-prepared V2 action.",
      );
    },
    /** @deprecated Use confirmPersonalV2; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
    async confirmPersonal(
      _input: SessionGitHubConfirmParams,
      _action: PersonalGitHubSessionAction,
    ): Promise<SessionGitHubPublicationResult> {
      warnPluginSdkDeprecation({
        family: "github-publication",
        compatibility: "This method no longer performs publication work; use its replacement.",
        method: "confirmPersonal",
        replacement: "confirmPersonalV2",
      });
      throw new Error(
        "GitHub publication requires confirmPersonalV2 with a host-prepared V2 action.",
      );
    },
    requestPersonalForSessionV2(
      input: SessionGitHubPublishParams,
      action: PersonalGitHubSessionActionV2,
    ) {
      if (action.version !== 2) {
        throw new RepositoryPublicationRequesterUnavailableError();
      }
      return methods.requestPersonalForSession(input, action);
    },
    confirmPersonalV2(input: SessionGitHubConfirmParams, action: PersonalGitHubSessionActionV2) {
      if (action.version !== 2) {
        throw new RepositoryPublicationRequesterUnavailableError();
      }
      return methods.confirmPersonal(input, action);
    },
  };
}
