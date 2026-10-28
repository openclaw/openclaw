import { randomUUID } from "node:crypto";
import type { SessionGitLabPublicationResult } from "../../packages/gateway-protocol/src/schema/gitlab.js";
import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import type {
  GitHubPublicationRow,
  RepositoryGitHubPublicationRow,
} from "../state/github-publication-read.types.js";
import {
  createGitHubPublicationWorkerScope,
  readGitHubPublicationInWorker as read,
} from "../state/github-publication-worker.js";
import type {
  GitHubPublicationDeferral,
  PersonalPublicationMutation,
  PublicationMaintenanceMutation,
  PublicationMutationReceipt,
  PublicationReadOperations,
  RepositoryPublicationMutation,
  SharedPublicationMutation,
} from "../state/github-publication-worker.types.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { PersonalGitHubPublicationRow } from "./github-personal-publication-store.js";
import type { GitHubPublicationEffectTransition } from "./github-publication-execution-effects.js";
import type { GitHubPublicationSourceCapability } from "./github-publication-source.js";
import type { PersonalGitLabPublicationRow } from "./gitlab-personal-publication-store.js";

/** Native callers retain live memory authority; durable execution predicates stay in the worker. */
export type GitHubPublicationTransitionAuthority = {
  prepareSource(): Promise<GitHubPublicationSourceCapability>;
  assertAction(): void;
  assertCustody(): void;
};

function publish(receipt: PublicationMutationReceipt) {
  for (const change of receipt.changes) {
    emitSessionLifecycleEvent({ ...change, reason: "github-publication" });
  }
  if (receipt.kind === "gitlab-personal") {
    for (const row of receipt.rows) {
      emitSessionLifecycleEvent({
        sessionKey: row.session_key,
        agentId: row.agent_id,
        reason: "gitlab-publication",
      });
    }
  }
}

function mutationScope() {
  return createGitHubPublicationWorkerScope(captureOpenClawStateWorkerContext());
}

async function personalMutation(
  scope: ReturnType<typeof mutationScope>,
  input: PersonalPublicationMutation,
  authority: (() => void) | GitHubPublicationTransitionAuthority,
) {
  const receipt = await withMutationAuthority(
    scope,
    { type: "githubPublications.personal", input: { ...input, operationId: randomUUID() } },
    authority,
  );
  if (receipt.kind !== "personal") {
    throw new Error("Invalid personal publication receipt.");
  }
  return receipt.rows;
}

async function gitLabPersonalMutation(
  scope: ReturnType<typeof mutationScope>,
  input: import("../state/github-publication-worker.types.js").GitLabPersonalPublicationMutation,
  authority: (() => void) | GitHubPublicationTransitionAuthority,
) {
  const receipt = await withMutationAuthority(
    scope,
    { type: "githubPublications.gitlabPersonal", input: { ...input, operationId: randomUUID() } },
    authority,
  );
  if (receipt.kind !== "gitlab-personal") {
    throw new Error("Invalid personal GitLab publication receipt.");
  }
  return receipt.rows;
}

async function repositoryMutation(
  scope: ReturnType<typeof mutationScope>,
  input: RepositoryPublicationMutation,
  authority: (() => void) | GitHubPublicationTransitionAuthority,
) {
  const receipt = await withMutationAuthority(
    scope,
    { type: "githubPublications.repository", input: { ...input, operationId: randomUUID() } },
    authority,
  );
  if (receipt.kind !== "repository") {
    throw new Error("Invalid repository publication receipt.");
  }
  return receipt.rows;
}

async function sharedMutation(
  scope: ReturnType<typeof mutationScope>,
  input: SharedPublicationMutation,
  authority: (() => void) | GitHubPublicationTransitionAuthority,
) {
  const receipt = await withMutationAuthority(
    scope,
    { type: "githubPublications.shared", input: { ...input, operationId: randomUUID() } },
    authority,
  );
  if (receipt.kind !== "shared") {
    throw new Error("Invalid shared publication receipt.");
  }
  return receipt.rows;
}

function requireRow<Row>(rows: Row[]): Row {
  if (!rows[0]) {
    throw new Error("GitHub publication transition returned no receipt.");
  }
  return rows[0];
}

function withMutationAuthority(
  scope: ReturnType<typeof mutationScope>,
  command: Parameters<ReturnType<typeof mutationScope>["mutate"]>[0],
  authority: (() => void) | GitHubPublicationTransitionAuthority,
): Promise<PublicationMutationReceipt> {
  if (typeof authority === "function") {
    return scope.mutate(command, authority, publish);
  }
  const assertCurrent = () => {
    authority.assertCustody();
    authority.assertAction();
  };
  return scope.mutate(command, assertCurrent, publish, () => authority.prepareSource());
}

function effects<Row>(apply: (transition: GitHubPublicationEffectTransition) => Promise<Row>) {
  // A dispatched marker may survive beforeRun refusal; it never proves an observed effect.
  return {
    updateHead: (headCommit: string) => apply({ operation: "updateHead", headCommit }),
    complete: (result: SessionGitHubPublicationResult) => apply({ operation: "complete", result }),
    async recordEffect(
      effect: "push" | "pull_request",
      observed?: { headCommit?: string; url?: string },
    ) {
      await apply({ operation: "recordEffect", effect, observed });
    },
    interrupt: () => apply({ operation: "interrupt" }),
  };
}

export async function claimPersonalGitHubPublicationAsync(
  row: PersonalGitHubPublicationRow,
  instanceId: string,
  authority: GitHubPublicationTransitionAuthority,
) {
  const scope = mutationScope();
  const executionId = randomUUID();
  const identity = { row, instanceId, executionId };
  const claimed = requireRow(
    await personalMutation(scope, { operation: "claim", ...identity }, authority),
  );
  return {
    row: { ...claimed, gateway_instance_id: instanceId, execution_id: executionId },
    // The coordinator owns this claim under workspace exclusion until settlement.
    ownsExecution() {
      scope.assertCurrent();
      return true;
    },
    ...effects(async (transition) => {
      return requireRow(
        await personalMutation(scope, { ...identity, ...transition }, () =>
          authority.assertCustody(),
        ),
      );
    }),
  };
}

export async function claimPersonalGitLabPublicationAsync(
  row: PersonalGitLabPublicationRow,
  instanceId: string,
  authority: GitHubPublicationTransitionAuthority,
) {
  const scope = mutationScope();
  const executionId = randomUUID();
  const identity = { row, instanceId, executionId };
  const claimed = requireRow(
    await gitLabPersonalMutation(scope, { operation: "claim", ...identity }, authority),
  );
  const apply = async (
    transition: (
      | Exclude<GitHubPublicationEffectTransition, { operation: "complete" }>
      | { operation: "complete"; result: SessionGitLabPublicationResult }
    ) & {
      resultJson?: string;
      pushObservation?: "applied" | "unchanged";
    },
  ) =>
    requireRow(
      await gitLabPersonalMutation(scope, { ...identity, ...transition }, () =>
        authority.assertCustody(),
      ),
    );
  return {
    row: claimed,
    ownsExecution() {
      scope.assertCurrent();
      return true;
    },
    updateHead: (headCommit: string) => apply({ operation: "updateHead", headCommit }),
    recordEffect: (
      effect: "push" | "pull_request",
      observed?: { headCommit?: string; url?: string },
      pushObservation?: "applied" | "unchanged",
    ) => apply({ operation: "recordEffect", effect, observed, pushObservation }),
    complete: (result: SessionGitLabPublicationResult, resultJson?: string) =>
      apply({ operation: "complete", result, resultJson }),
    interrupt: () => apply({ operation: "interrupt" }),
  };
}

export async function claimRepositoryGitHubPublicationAsync(
  row: RepositoryGitHubPublicationRow,
  instanceId: string,
  authority: GitHubPublicationTransitionAuthority,
) {
  const scope = mutationScope();
  const executionId = randomUUID();
  const identity = { row, instanceId, executionId };
  const claimed = requireRow(
    await repositoryMutation(scope, { operation: "claim", ...identity }, () =>
      authority.assertCustody(),
    ),
  );
  return {
    row: { ...claimed, gateway_instance_id: instanceId, execution_id: executionId },
    ownsExecution() {
      scope.assertCurrent();
      return true;
    },
    ...effects(async (transition) => {
      return requireRow(
        await repositoryMutation(scope, { ...identity, ...transition }, () =>
          authority.assertCustody(),
        ),
      );
    }),
  };
}

export type RepositoryGitHubPublicationExecutionAsync = Awaited<
  ReturnType<typeof claimRepositoryGitHubPublicationAsync>
>;

export async function claimGitHubPublicationExecutionAsync(
  requestId: string,
  instanceId: string,
  assertCustody: () => void,
) {
  return requireRow(
    await sharedMutation(
      mutationScope(),
      { operation: "claim", requestId, instanceId },
      assertCustody,
    ),
  );
}

export function createGitHubPublicationExecutionStoreAsync(
  instanceId: string,
  authority: GitHubPublicationTransitionAuthority,
) {
  const scope = mutationScope();
  return {
    async bindWorkspaceSnapshot(
      input: Extract<SharedPublicationMutation, { operation: "bindWorkspaceSnapshot" }>["input"],
    ) {
      return requireRow(
        await sharedMutation(
          scope,
          { operation: "bindWorkspaceSnapshot", input, instanceId },
          authority,
        ),
      );
    },
    async updatePublishingFacts(
      input: Extract<SharedPublicationMutation, { operation: "updatePublishingFacts" }>["input"],
    ) {
      return requireRow(
        await sharedMutation(scope, { operation: "updatePublishingFacts", input, instanceId }, () =>
          authority.assertCustody(),
        ),
      );
    },
    async complete(row: GitHubPublicationRow, result: SessionGitHubPublicationResult) {
      return requireRow(
        await sharedMutation(scope, { operation: "complete", row, result, instanceId }, () =>
          authority.assertCustody(),
        ),
      );
    },
  };
}

export async function bindRepositoryGitHubPublicationCheckpointAsync(
  row: RepositoryGitHubPublicationRow,
  checkpoint: Extract<RepositoryPublicationMutation, { operation: "checkpoint" }>["checkpoint"],
  authority: GitHubPublicationTransitionAuthority,
) {
  return requireRow(
    await repositoryMutation(
      mutationScope(),
      { operation: "checkpoint", row, checkpoint },
      authority,
    ),
  );
}

export async function failRepositoryGitHubPublicationPreparationAsync(
  row: RepositoryGitHubPublicationRow,
  nextAction: string,
  assertCustody: () => void,
) {
  return requireRow(
    await repositoryMutation(
      mutationScope(),
      { operation: "failPreparation", row, nextAction },
      assertCustody,
    ),
  );
}

export async function failStaleRepositoryGitHubPublicationAsync(
  row: RepositoryGitHubPublicationRow,
  assertCustody: () => void,
) {
  await repositoryMutation(mutationScope(), { operation: "retire", row }, assertCustody);
}

export async function deferRepositoryGitHubPublicationClaimsAsync(
  selection: GitHubPublicationDeferral,
  assertCurrent: () => void,
) {
  await repositoryMutation(mutationScope(), { operation: "defer", selection }, assertCurrent);
}

export async function deferGitHubPublicationRequestsAsync(
  selection: GitHubPublicationDeferral,
  assertCurrent: () => void,
) {
  await sharedMutation(mutationScope(), { operation: "defer", selection }, assertCurrent);
}

export async function requirePersonalGitHubPublicationConfirmationAsync(
  instanceId: string,
  assertCurrent?: () => void,
) {
  const scope = mutationScope();
  await personalMutation(
    scope,
    { operation: "restart", instanceId },
    assertCurrent ?? scope.assertCurrent,
  );
}

export async function requirePersonalGitLabPublicationConfirmationAsync(
  instanceId: string,
  assertCurrent?: () => void,
) {
  const scope = mutationScope();
  await gitLabPersonalMutation(
    scope,
    { operation: "restart", instanceId },
    assertCurrent ?? scope.assertCurrent,
  );
}

export async function markPersonalGitLabPublicationReportedAsync(requestId: string) {
  const scope = mutationScope();
  return await gitLabPersonalMutation(
    scope,
    { operation: "report", requestId },
    scope.assertCurrent,
  );
}

export async function runGitHubPublicationMaintenanceAsync(
  input: PublicationMaintenanceMutation,
  assertCurrent?: () => void,
) {
  const scope = mutationScope();
  await scope.mutate(
    { type: "githubPublications.maintenance", input: { ...input, operationId: randomUUID() } },
    assertCurrent ?? scope.assertCurrent,
    publish,
  );
}

export async function readPersonalGitHubPublicationAsync(
  owner: string,
  request: PublicationReadOperations["githubPublications.personalRead"]["input"]["request"],
) {
  const result = await read({ type: "githubPublications.personalRead", input: { owner, request } });
  return result?.type === "githubPublications.personalRead" ? result.row : undefined;
}

export async function readPersonalGitLabPublicationAsync(
  owner: string,
  issuer: string,
  request: PublicationReadOperations["githubPublications.gitlabPersonalRead"]["input"]["request"],
) {
  const result = await read({
    type: "githubPublications.gitlabPersonalRead",
    input: { owner, issuer, request },
  });
  return result?.type === "githubPublications.gitlabPersonalRead" ? result.row : undefined;
}

export async function readSharedGitLabPublicationAsync(
  input: PublicationReadOperations["githubPublications.gitlabSharedRead"]["input"],
) {
  const result = await read({ type: "githubPublications.gitlabSharedRead", input });
  return result?.type === "githubPublications.gitlabSharedRead" ? result.row : undefined;
}

export async function listUnreportedPersonalGitLabPublicationsAsync() {
  const result = await read({
    type: "githubPublications.gitlabPersonalUnreported",
    input: undefined,
  });
  return result?.type === "githubPublications.gitlabPersonalUnreported" ? result.rows : [];
}

export async function listRepositoryGitHubPublicationsAsync(
  input: PublicationReadOperations["githubPublications.repositoryList"]["input"] = {},
) {
  const result = await read({ type: "githubPublications.repositoryList", input });
  return result?.type === "githubPublications.repositoryList" ? result.rows : [];
}

export async function readRepositoryGitHubPublicationAsync(requestId: string) {
  const result = await read({ type: "githubPublications.repositoryRead", input: { requestId } });
  return result?.type === "githubPublications.repositoryRead" ? result.row : undefined;
}

export async function readRepositoryGitHubPublicationBranchAsync(
  input: PublicationReadOperations["githubPublications.branch"]["input"],
) {
  const result = await read({ type: "githubPublications.branch", input });
  return result?.type === "githubPublications.branch"
    ? result.branch
    : { head: undefined, unsettled: false };
}

export async function listUnreportedPersonalGitHubPublicationsAsync() {
  const result = await read({ type: "githubPublications.unreported", input: undefined });
  return result?.type === "githubPublications.unreported" ? result.rows : [];
}

export async function listGitHubPublicationsForClaimAsync(
  claim: PublicationReadOperations["githubPublications.claimRequests"]["input"]["claim"],
  options: { pendingOnly?: boolean } = {},
) {
  const result = await read({
    type: "githubPublications.claimRequests",
    input: { claim, ...options },
  });
  return result?.type === "githubPublications.claimRequests" ? result.rows : [];
}

export async function listSharedGitHubPublicationsAsync(
  input: PublicationReadOperations["githubPublications.sharedList"]["input"] = {},
) {
  const result = await read({ type: "githubPublications.sharedList", input });
  return result?.type === "githubPublications.sharedList" ? result.rows : [];
}

export async function bindAcceptedGitHubPublicationClaimSnapshotAsync(
  input: Extract<SharedPublicationMutation, { operation: "bindAcceptedSnapshot" }>["input"],
  assertCustody: () => void,
) {
  return requireRow(
    await sharedMutation(
      mutationScope(),
      { operation: "bindAcceptedSnapshot", input },
      assertCustody,
    ),
  );
}

export async function readGitHubPublicationRequestAsync(
  input: PublicationReadOperations["githubPublications.sharedRead"]["input"],
) {
  const result = await read({ type: "githubPublications.sharedRead", input });
  return result?.type === "githubPublications.sharedRead" ? result.row : undefined;
}
