import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createRepositoryPublicationContentHostV1 } from "./github-publication-content.js";
import {
  RepositoryPublicationProviderUnavailableError,
  RepositoryPublicationRequesterUnavailableError,
} from "./github-publication-errors.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import {
  assertNativePublisherProvenance,
  matchesPublisherProvenance,
  publisherProvenance,
} from "./github-publication-publisher-facts.js";
import { projectGitHubPublicationResult } from "./github-publication-receipt.js";
import type { RepositoryGitHubPublicationExecutionAsync } from "./github-publication-store-async.js";
import {
  readGitHubRepositoryPublicationBlob,
  type GitHubRepositoryPublicationSnapshot,
} from "./github-repository-publication-snapshot.js";
import { GatewayOperatorAccessUnavailableError } from "./operator-access-policy.js";
import type {
  RepositoryPublicationProvider,
  RepositoryPublicationPublisher,
} from "./repository-publication-contract.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";

/** Execution claims, checkpoint bytes and phase settlement never leave this host owner. */
export async function executeRepositoryPublication(params: {
  provider: RepositoryPublicationProvider;
  config: OpenClawConfig;
  execution: RepositoryGitHubPublicationExecutionAsync;
  snapshot: GitHubRepositoryPublicationSnapshot;
  source: { url: string; branch: string; requestedRef?: string | null };
  snapshotRoot: string;
  storePath: string;
  requesterProfileId?: string;
  assertWorkspace: () => void;
  readCurrentEntry: () => InternalSessionEntry | undefined;
  validateAuthority: () => boolean;
  assertWorkflowChangesAllowed: () => void;
  publisher?: () => Promise<RepositoryPublicationPublisher>;
}) {
  const { execution, snapshot, provider } = params;
  const row = execution.row;
  const provenance = publisherProvenance(row);
  let dispatched = row.last_effect !== null;
  let acceptedHead = row.head_commit;
  const assertCustody = () => {
    if (!execution.ownsExecution()) {
      throw new GitHubPublicationRecoveryPendingError("Publication execution custody changed.");
    }
  };
  const assertCurrent = () => {
    assertCustody();
    params.assertWorkspace();
    if (!params.validateAuthority()) {
      throw new Error("Publication authority changed.");
    }
    provider.assertCurrent();
  };
  try {
    assertCurrent();
    const publisher = await (params.publisher?.() ??
      provider.preparePublisher(row.agent_id, provenance));
    assertCurrent();
    publisher.assertCurrent();
    assertNativePublisherProvenance(publisher.provenance);
    if (!matchesPublisherProvenance(row, publisher.provenance)) {
      throw new Error("Publication publisher changed.");
    }
    if (
      !row.push_repository ||
      !row.repository ||
      !row.base_branch ||
      snapshot.baseCommit !== row.source_head_commit ||
      snapshot.baseTree !== row.source_index_tree ||
      snapshot.workspaceTree !== row.workspace_tree
    ) {
      throw new Error("Publication accepted checkpoint changed.");
    }
    const session = {
      sessionId: row.session_id,
      sessionKey: row.session_key,
      agentId: row.agent_id,
      lifecycleRevision: row.session_lifecycle_revision,
    };
    const target = await provider.prepareTarget({
      originUrl: params.source.url,
      branch: row.branch,
      baseRef: row.base_branch,
      publisher,
      assertCurrent,
      repositoryOnly: true,
    });
    // Target discovery happened at admission; recovery preserves it rather than choosing another destination.
    if (
      target.pushRepository !== row.push_repository ||
      target.repository !== row.repository ||
      target.baseBranch !== row.base_branch ||
      target.branch !== row.branch
    ) {
      throw new Error("Publication accepted repository target changed.");
    }
    const blobs = new Set(
      snapshot.entries.flatMap((entry) =>
        entry.sha && entry.mode !== "160000" ? [entry.sha] : [],
      ),
    );
    const result = await provider.executeRepository({
      request: {
        requestId: row.request_id,
        createdAtMs: row.created_at_ms,
        session,
        ...(row.title ? { title: row.title } : {}),
        ...(row.body ? { body: row.body } : {}),
        draft: row.draft !== 0,
        publisher: provenance,
      },
      target,
      publisher,
      snapshot: {
        ...snapshot,
        entries: snapshot.entries,
        readBlob: async (sha) => {
          assertCurrent();
          if (!blobs.has(sha)) {
            throw new Error("Publication blob is outside its accepted checkpoint.");
          }
          const bytes = await readGitHubRepositoryPublicationBlob(params.snapshotRoot, sha);
          assertCurrent();
          return bytes;
        },
      },
      previousHeadCommit: row.previous_head_commit,
      headCommit: row.head_commit,
      contentHost: createRepositoryPublicationContentHostV1({
        session,
        baseRemoteUrl: target.baseRemoteUrl,
        accountId: row.identity_account_id,
        requesterProfileId: params.requesterProfileId,
        storePath: params.storePath,
        config: params.config,
        readCurrentEntry: params.readCurrentEntry,
        assertCurrent,
      }),
      assertCurrent,
      assertWorkflowChangesAllowed: params.assertWorkflowChangesAllowed,
      prepareCommit: async (head) => {
        assertCurrent();
        if (!/^[a-f0-9]{40}$/u.test(head)) {
          throw new Error("Publication commit is invalid.");
        }
        await execution.updateHead(head);
        acceptedHead = head;
      },
      effects: {
        record: async (kind, observed) => {
          if (observed === undefined) {
            assertCurrent();
            dispatched = true;
          } else {
            assertCustody();
          }
          if (observed?.headCommit && observed.headCommit !== acceptedHead) {
            throw new Error("Publication observation differs from its accepted commit.");
          }
          await execution.recordEffect(kind, observed);
        },
      },
    });
    assertCustody();
    if (result.headCommit !== acceptedHead) {
      throw new Error("Publication result differs from its prepared commit.");
    }
    return projectGitHubPublicationResult(
      await execution.complete({
        requestId: row.request_id,
        status: "published",
        url: result.url,
        repository: row.repository,
        branch: row.branch,
        headCommit: result.headCommit,
      }),
    );
  } catch (error) {
    if (error instanceof RepositoryPublicationProviderUnavailableError) {
      throw new GitHubPublicationRecoveryPendingError(error.message, { cause: error });
    }
    if (
      error instanceof RepositoryPublicationRequesterUnavailableError ||
      error instanceof GatewayOperatorAccessUnavailableError ||
      error instanceof GitHubPublicationRecoveryPendingError
    ) {
      throw error;
    }
    if (dispatched && !provider.isDefinitiveFailure(error)) {
      const interrupted = await execution.interrupt();
      if (error instanceof SessionMutationAuthorizationChangedError) {
        throw error;
      }
      return projectGitHubPublicationResult(interrupted);
    }
    const failure = provider.resolveFailure(error);
    return projectGitHubPublicationResult(
      await execution.complete({
        requestId: row.request_id,
        status: "failed",
        ...failure,
        message: "Repository publication failed.",
      }),
    );
  }
}
