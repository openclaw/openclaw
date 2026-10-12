import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RepositoryGitHubPublicationRow } from "../state/github-publication-read.types.js";
import { encodeGitHubPublicationRequester } from "../state/github-publication-requester.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import {
  bindPersonalGitHubPublicationSelection,
  preparePersonalGitHubPublicationSelection,
  type PersonalGitHubSessionActionV2,
} from "./github-personal-publication.js";
import { GitHubPublicationAuthorityLostError } from "./github-publication-execution-identity.js";
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
  type GitHubPublicationTransitionAuthority,
  type RepositoryGitHubPublicationExecutionAsync,
} from "./github-publication-store-async.js";
import { assertGitHubPublicationWorkflowChangesAllowed } from "./github-publication-workflows.js";
import { executeRepositoryGitHubPublication } from "./github-repository-publication-executor.js";
import { settleDeniedRepositoryGitHubPublication } from "./github-repository-publication-recovery.js";
import { terminalRepositoryGitHubPublication } from "./github-repository-publication-store.js";
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
      action?: PersonalGitHubSessionActionV2;
      requester?: GitHubPublicationRequesterPolicyV2;
    },
  ) => {
    let row = initial;
    if (terminalRepositoryGitHubPublication(row)) {
      return projectGitHubPublicationResult(row);
    }
    const { assertCustody, action } = context;
    assertCustody();
    const preparedOwner = await getSessionRepositoryWorkspaceStore().prepare(row.workspace_id);
    assertCustody();
    context.assertCurrent?.();
    const { loaded } = assertReceiptOwner(row, preparedOwner);
    const bound =
      action && row.connection_generation
        ? bindPersonalGitHubPublicationSelection(action, {
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
      try {
        context.assertCurrent?.();
      } catch (cause) {
        // A closed invocation leaves observed effects retryable; retained policy decides denial.
        throw new GitHubPublicationAuthorityLostError(
          "GitHub publication invocation authority changed.",
          { cause },
        );
      }
      if (row.owner_profile_id === null) {
        getRequester().assertCurrent();
      }
      bound?.assertCurrent();
    };
    const authority: GitHubPublicationTransitionAuthority = {
      assertAction: assertExecution,
      assertCustody: params.assertCurrent,
      prepareSource: () =>
        prepareSource(action ?? getRequester(), {
          agentId: row.agent_id,
          sessionKey: row.session_key,
          sessionId: row.session_id,
          lifecycleRevision: row.session_lifecycle_revision,
          repositoryWorkspaceId: row.workspace_id,
          repositoryBranch: row.branch,
          ...(action ? { personalOwnerProfileId: action.owner } : {}),
        }),
    };
    let execution: RepositoryGitHubPublicationExecutionAsync | undefined;
    const claimExecution = async () => {
      if (!execution) {
        execution = await claimRepositoryGitHubPublicationAsync(row, instanceId, authority);
        active.set(row.request_id, execution.row.execution_id!);
      }
      return execution;
    };
    try {
      if (row.owner_profile_id === null) {
        if (
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
            row = await bindRepositoryGitHubPublicationCheckpointAsync(
              row,
              facts,
              prepared.authority,
            );
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
