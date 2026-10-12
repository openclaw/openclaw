import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RepositoryGitHubPublicationRow } from "../state/github-publication-read.types.js";
import { encodeGitHubPublicationRequester } from "../state/github-publication-requester.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import {
  bindPersonalGitHubPublicationSelection,
  preparePersonalGitHubPublicationSelection,
  type PersonalGitHubSessionAction,
  type PersonalGitHubSessionActionV2,
} from "./github-personal-publication.js";
import { GitHubPublicationRequesterUnavailableError } from "./github-publication-failure.js";
import { projectGitHubPublicationResult } from "./github-publication-receipt.js";
import {
  isGitHubPublicationRequesterV2,
  restoreGitHubPublicationRequester,
  type GitHubPublicationRequesterPolicyV2,
} from "./github-publication-requester.js";
import {
  bindRepositoryGitHubPublicationCheckpointAsync,
  claimRepositoryGitHubPublicationAsync,
  readRepositoryGitHubPublicationAsync,
  type GitHubPublicationTransitionAuthority,
  type RepositoryGitHubPublicationExecutionAsync,
} from "./github-publication-store-async.js";
import { assertGitHubPublicationWorkflowChangesAllowed } from "./github-publication-workflows.js";
import { executeRepositoryGitHubPublication } from "./github-repository-publication-executor.js";
import { settleDeniedRepositoryGitHubPublication } from "./github-repository-publication-recovery.js";
import {
  bindRepositoryGitHubPublicationCheckpoint,
  claimRepositoryGitHubPublication,
  requireRepositoryGitHubPublication,
  terminalRepositoryGitHubPublication,
  type RepositoryGitHubPublicationExecution,
} from "./github-repository-publication-store.js";
import {
  assertReceiptOwner,
  captureCheckpoint,
} from "./github-repository-publication-workspace.js";

export function createRepositoryGitHubPublicationExecution(params: {
  instanceId: string;
  active: Map<string, string>;
  getCommittedRuntimeConfig: () => OpenClawConfig;
  assertCurrent: () => void;
  prepareSource: (
    requester: Pick<GitHubPublicationRequesterPolicyV2, "prepareSource">,
    selector: Parameters<GitHubPublicationRequesterPolicyV2["prepareSource"]>[0],
  ) => ReturnType<GitHubPublicationRequesterPolicyV2["prepareSource"]>;
}) {
  const { instanceId, active, getCommittedRuntimeConfig, prepareSource } = params;
  return async (
    initial: RepositoryGitHubPublicationRow,
    context: {
      assertCustody: () => void;
      assertCurrent?: () => void;
      action?: PersonalGitHubSessionAction | PersonalGitHubSessionActionV2;
      requester?: GitHubPublicationRequesterPolicyV2;
      worker?: boolean;
    },
  ) => {
    const worker = context.worker !== false && (!context.action || "version" in context.action);
    const current = worker
      ? await readRepositoryGitHubPublicationAsync(initial.request_id)
      : requireRepositoryGitHubPublication(initial.request_id);
    context.assertCurrent?.();
    if (!current) {
      throw new Error("GitHub publication request no longer exists.");
    }
    let row = current;
    if (terminalRepositoryGitHubPublication(row)) {
      return projectGitHubPublicationResult(row);
    }
    const { assertCustody, action } = context;
    assertCustody();
    const preparedOwner = await getSessionRepositoryWorkspaceStore().prepare(row.workspace_id);
    const preparedRow = worker
      ? await readRepositoryGitHubPublicationAsync(initial.request_id)
      : requireRepositoryGitHubPublication(initial.request_id);
    assertCustody();
    context.assertCurrent?.();
    if (!preparedRow) {
      throw new Error("GitHub publication request no longer exists.");
    }
    row = preparedRow;
    if (terminalRepositoryGitHubPublication(row)) {
      return projectGitHubPublicationResult(row);
    }
    const { loaded } = assertReceiptOwner(row, preparedOwner);
    const bound =
      action && row.connection_generation
        ? await bindPersonalGitHubPublicationSelection(action, {
            generation: row.connection_generation,
            account: { accountId: row.identity_account_id, login: row.identity_login },
          })
        : undefined;
    if (
      (row.owner_profile_id !== null) !== Boolean(bound) ||
      (bound && bound.profileId !== row.identity_profile_id)
    ) {
      throw new Error("My GitHub publication owner changed.");
    }
    let requester: GitHubPublicationRequesterPolicyV2 | undefined;
    let releaseRequester: (() => void) | undefined;
    const getRequester = () => {
      if (!requester) {
        throw new GitHubPublicationRequesterUnavailableError();
      }
      return requester;
    };
    const assertExecution = () => {
      // Classify source loss before personal preparation can turn it into a retryable error.
      assertReceiptOwner(row, preparedOwner);
      assertCustody();
      if (row.owner_profile_id === null) {
        getRequester().assertCurrent();
      }
      context.assertCurrent?.();
      bound?.assertCurrent();
    };
    const authority: GitHubPublicationTransitionAuthority | undefined = worker
      ? {
          assertAction: assertExecution,
          assertCustody: params.assertCurrent,
          prepareSource: () =>
            prepareSource(action && "version" in action ? action : getRequester(), {
              agentId: row.agent_id,
              sessionKey: row.session_key,
              sessionId: row.session_id,
              lifecycleRevision: row.session_lifecycle_revision,
              repositoryWorkspaceId: row.workspace_id,
              repositoryBranch: row.branch,
              ...(action ? { personalOwnerProfileId: action.owner } : {}),
            }),
        }
      : undefined;
    let execution:
      | RepositoryGitHubPublicationExecution
      | RepositoryGitHubPublicationExecutionAsync
      | undefined;
    const claimExecution = async () => {
      if (!execution) {
        execution = authority
          ? await claimRepositoryGitHubPublicationAsync(row, instanceId, authority)
          : claimRepositoryGitHubPublication(row, instanceId, {
              assertCustody,
              assertCurrent: assertExecution,
            });
        active.set(row.request_id, execution.row.execution_id!);
      }
      return execution;
    };
    try {
      if (row.owner_profile_id === null) {
        if (
          worker &&
          context.requester &&
          isGitHubPublicationRequesterV2(context.requester) &&
          encodeGitHubPublicationRequester(context.requester.snapshot) ===
            row.requester_authority_json
        ) {
          requester = context.requester;
        } else {
          const restored = await restoreGitHubPublicationRequester(
            row.requester_authority_json,
            { sessionKey: row.session_key, agentId: row.agent_id },
            getCommittedRuntimeConfig,
          );
          requester = restored;
          releaseRequester = restored.release;
        }
      }
      assertExecution();
      if (
        !row.checkpoint_ref &&
        row.owner_profile_id === null &&
        !assertReceiptOwner(row, preparedOwner).workspace.checkpointRef
      ) {
        return projectGitHubPublicationResult(row);
      }
      return await captureCheckpoint(
        row,
        assertExecution,
        async (facts, prepared) => {
          if (!row.checkpoint_ref) {
            row = prepared.authority
              ? await bindRepositoryGitHubPublicationCheckpointAsync(row, facts, prepared.authority)
              : bindRepositoryGitHubPublicationCheckpoint(row, facts, assertExecution);
          }
          assertExecution();
          return await executeRepositoryGitHubPublication({
            execution: await claimExecution(),
            snapshot: prepared.snapshot,
            snapshotRoot: prepared.snapshotRoot,
            storePath: loaded.storePath,
            assertWorkflowChangesAllowed: bound
              ? assertExecution
              : () => assertGitHubPublicationWorkflowChangesAllowed(getRequester()),
            assertWorkspace: () => {
              assertReceiptOwner(row, preparedOwner);
            },
            validateAuthority: () => {
              assertExecution();
              return true;
            },
            ...(bound
              ? {
                  identity: {
                    prepare: () =>
                      preparePersonalGitHubPublicationSelection(bound, assertExecution),
                    isCurrent: (identity: PreparedGitHubPublicationIdentity) => {
                      assertExecution();
                      return (
                        identity.source === "personal" &&
                        identity.profileId === bound.profileId &&
                        identity.account.accountId === row.identity_account_id
                      );
                    },
                  },
                }
              : {}),
          });
        },
        authority,
      );
    } catch (error) {
      if (
        row.owner_profile_id === null &&
        error instanceof GitHubPublicationRequesterUnavailableError
      ) {
        return await settleDeniedRepositoryGitHubPublication({
          execution: await claimExecution(),
          assertCustody,
          error,
        });
      }
      if (execution?.ownsExecution()) {
        await execution.interrupt();
      }
      throw error;
    } finally {
      releaseRequester?.();
      if (execution) {
        active.delete(row.request_id);
      }
    }
  };
}
