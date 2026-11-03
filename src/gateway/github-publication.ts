import type {
  SessionGitHubPublicationResult,
  SessionGitHubStatusResult,
} from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { prepareGitHubPublicationSessionLifecycle } from "../state/github-publication-session-lifecycles.js";
import { createGitHubPublicationWorkerScope } from "../state/github-publication-worker.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createPersonalGitHubPublicationCoordinator } from "./github-personal-publication.js";
import {
  prepareGitHubPublicationSession,
  hasGitHubPublicationRepositoryWorkspace,
} from "./github-publication-availability.js";
import { refreshManagedWorkspaceBase } from "./github-publication-base-refresh.js";
import {
  createGitHubPublicationCoordinatorMethods,
  requestGitHubPublicationForClaim,
} from "./github-publication-coordinator-methods.js";
import { createRepositoryPublicationHostExecution } from "./github-publication-execution.js";
import { executeGitHubPublication } from "./github-publication-executor.js";
import { assertPublicationChangePermission as assertGitHubPublicationWorkflowChangesAllowed } from "./github-publication-policy.js";
import {
  reconcileGitHubPublication,
  observeGitHubPublication,
  type GitHubPublicationRecoveryBackoff,
} from "./github-publication-recovery.js";
import { isGitHubPublicationRequesterV2 } from "./github-publication-requester-capability.js";
import type { GitHubPublicationRequesterV2 } from "./github-publication-requester.js";
import type {
  GitHubPublicationClaimRequest,
  GitHubPublicationClaimRequestV2,
  GitHubPublicationSessionRequest,
} from "./github-publication-session.types.js";
import {
  runGitHubPublicationMaintenanceAsync,
  readRepositoryGitHubPublicationAsync,
} from "./github-publication-store-async.js";
import {
  prepareGitHubPublicationClaimWorkspace,
  sameWorktree,
} from "./github-publication-workspace.js";
import { createRepositoryGitHubPublicationCoordinator } from "./github-repository-publication.js";
import type { RepositoryPublicationProvider } from "./repository-publication-contract.js";
import { resolveLocalWorkspaceOwner } from "./worker-environments/local-workspace-projection.js";
import type {
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./worker-environments/placement-store.js";

export type GitHubPublicationTranscriptReport = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  result: SessionGitHubPublicationResult;
  /** Run whose tool call requested this publication, when it is known to this process. */
  runId?: string;
};

export function createGitHubPublicationCoordinator(params: {
  provider: RepositoryPublicationProvider;
  placements: WorkerSessionPlacementStore;
  environments?: Parameters<typeof createRepositoryGitHubPublicationCoordinator>[0]["environments"];
  getCommittedRuntimeConfig: () => OpenClawConfig;
  assertCurrent?: () => void;
  signal?: AbortSignal;
  recovery?: {
    shared: GitHubPublicationRecoveryBackoff;
    repository: GitHubPublicationRecoveryBackoff;
  };
}) {
  function refuseLegacyPublication(
    method: string,
    replacement: string,
    guidance = "and await completion",
  ): never {
    warnPluginSdkDeprecation({
      family: "github-publication",
      compatibility: "This method no longer performs publication work; use its replacement.",
      method,
      replacement,
    });
    throw new Error(`Use ${replacement} ${guidance}.`);
  }

  const assertAvailable = () => provider.assertCurrent();
  const scope = createGitHubPublicationWorkerScope(captureOpenClawStateWorkerContext());
  const assertCurrent = params.assertCurrent ?? scope.assertCurrent;
  const signal = params.signal ?? scope.signal;
  const provider = params.provider;

  const requestForClaim = (request: GitHubPublicationClaimRequestV2) =>
    requestGitHubPublicationForClaim(
      { provider, placements: params.placements, assertCurrent, signal },
      request,
    );

  const processRow = createRepositoryPublicationHostExecution({
    ...params,
    assertCurrent,
    signal,
    adapter: {
      execute: (input) =>
        executeGitHubPublication({
          ...input,
          provider,
          config: params.getCommittedRuntimeConfig(),
        }),
      reconcile: (input) => reconcileGitHubPublication({ ...input, provider }),
      observe: (input) => observeGitHubPublication({ ...input, provider }),
      assertWorkflowChangesAllowed: assertGitHubPublicationWorkflowChangesAllowed,
    },
  });

  const repository = createRepositoryGitHubPublicationCoordinator({
    ...params,
    provider,
    recovery: params.recovery?.repository,
    assertCurrent,
    signal,
  });
  const personal = createPersonalGitHubPublicationCoordinator(
    params.placements,
    assertCurrent,
    signal,
    provider,
    params.getCommittedRuntimeConfig,
  );
  // A publication processed inside its run's tool call reports into that run, so
  // the transcript notice stays within the turn. Process-local by design: after a
  // restart before reporting, the notice is recorded without a run, as it was before.
  const requestingRuns = new Map<string, string>();
  const methods = createGitHubPublicationCoordinatorMethods({
    provider,
    placements: params.placements,
    recovery: params.recovery,
    assertCurrent,
    requestForClaimV2: requestForClaim,
    getCommittedRuntimeConfig: params.getCommittedRuntimeConfig,
    signal,
    sameWorktree,
    processRow,
    recordRequestingRun: (requestId, runId) => requestingRuns.set(requestId, runId),
  });
  return {
    ...methods,
    supportsOrigin: (originUrl: string) => provider.supportsOrigin(originUrl),
    performPullRequestAction: (
      input: Parameters<RepositoryPublicationProvider["performPullRequestAction"]>[0],
    ) => provider.performPullRequestAction(input),
    inspectPullRequest: (
      input: Parameters<RepositoryPublicationProvider["inspectPullRequest"]>[0],
    ) => provider.inspectPullRequest(input),
    async preparePullRequest(
      input: import("./repository-publication-contract.js").PullRequestPreparationInput,
    ) {
      assertAvailable();
      assertCurrent();
      if (!isGitHubPublicationRequesterV2(input.requester)) {
        throw new Error("PR preparation requires a host-prepared requester.");
      }
      const [{ performSessionGitHubPreparation }, { getPluginRuntimeGatewayRequestScope }] =
        await Promise.all([
          import("./github-pr-workspace-preparation.js"),
          import("../plugins/runtime/gateway-request-scope.js"),
        ]);
      const requestScope = getPluginRuntimeGatewayRequestScope();
      const context = requestScope?.resolveGatewayContext?.() ?? requestScope?.context;
      if (!context) {
        throw new Error("PR preparation requires its live Gateway request.");
      }
      return await performSessionGitHubPreparation(input, provider, context);
    },
    async refreshBase(input: {
      sessionKey: string;
      agentId: string;
      requester: GitHubPublicationRequesterV2;
      signal?: AbortSignal;
      conflictsResolved?: boolean;
      baseCommit?: string;
    }) {
      assertAvailable();
      assertCurrent();
      if (!isGitHubPublicationRequesterV2(input.requester)) {
        throw new Error("Base refresh requires a host-prepared requester.");
      }
      const caller = getGatewayToolCallerIdentity();
      const sandbox = caller?.workspaceBaseRefreshSandbox;
      if (
        !caller ||
        !sandbox?.enabled ||
        !sandbox.backend ||
        sandbox.workspaceSource !== "managed-worktree"
      ) {
        throw new Error(
          "Run refresh_base from this workspace's sandboxed agent so its review base can be prepared.",
        );
      }
      if (sandbox.workspaceAccess === "ro") {
        throw new Error("The workspace is read-only; refresh_base requires a writable sandbox.");
      }
      if (normalizeAgentId(input.agentId) !== normalizeAgentId(caller.agentId)) {
        throw new Error("Base refresh must use the current conversation's workspace.");
      }
      using selected = await prepareGitHubPublicationSession(caller.sessionKey, {
        agentId: caller.agentId,
        assertCurrent: input.requester.assertCurrent,
      });
      const loaded = selected.readCurrent();
      if (!loaded.entry?.sessionId) {
        throw new Error("The base refresh session is unavailable.");
      }
      if (loaded.canonicalKey !== input.sessionKey) {
        throw new Error("Base refresh must use the current conversation's workspace.");
      }
      if (loaded.entry.worktree?.githubPullRequest) {
        throw new Error(
          "This workspace continues an existing PR. Use prepare_pr with its URL to prepare its current source and review base.",
        );
      }
      const session = { agentId: loaded.agentId, sessionKey: loaded.canonicalKey };
      const publisher = await provider.preparePublisher(session.agentId);
      const assertAction = () => {
        assertCurrent();
        input.signal?.throwIfAborted();
        selected.readCurrent();
        input.requester.assertCurrent();
        publisher.assertCurrent();
      };
      assertAction();
      using owner = await resolveLocalWorkspaceOwner({
        ...session,
        cfg: params.getCommittedRuntimeConfig(),
        assertCurrent: assertAction,
      });
      if (!owner) {
        throw new Error("Base refresh requires this session's existing local managed workspace.");
      }
      const result = await params.placements.withWorkspaceExclusion(
        loaded.entry.sessionId,
        async (assertOwned) =>
          refreshManagedWorkspaceBase({
            owner,
            provider,
            publisher,
            sandbox,
            signal: input.signal,
            assertCurrent: () => {
              assertAction();
              assertOwned();
            },
            conflictsResolved: input.conflictsResolved,
            baseCommit: input.baseCommit,
          }),
      );
      assertAction();
      return result;
    },
    ...personal,
    /** @deprecated Use requestForClaimV2; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
    requestForClaim: async (
      _request: GitHubPublicationClaimRequest,
    ): Promise<SessionGitHubPublicationResult> => {
      return refuseLegacyPublication(
        "requestForClaim",
        "requestForClaimV2",
        "with a host-prepared requester",
      );
    },
    requestForClaimV2: async (request: GitHubPublicationClaimRequestV2) => {
      assertAvailable();
      if (!isGitHubPublicationRequesterV2(request.requester)) {
        throw new Error("GitHub publication requires a host-prepared V2 requester.");
      }
      assertCurrent();
      return (await hasGitHubPublicationRepositoryWorkspace({
        sessionId: request.claim.sessionId,
        sessionKey: request.sessionKey,
        agentId: request.agentId,
      }))
        ? repository.requestForClaimV2(request)
        : requestForClaim(request);
    },
    async prepareClaimWorkspace(claim: WorkerSessionTurnClaim) {
      await prepareGitHubPublicationClaimWorkspace(
        { placements: params.placements, assertCurrent },
        claim,
      );
      await repository.prepareClaimWorkspace(claim);
    },
    /** @deprecated Use deferClaimPreparationAsync; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
    deferClaimPreparation(_claim: WorkerSessionTurnClaim): void {
      return refuseLegacyPublication("deferClaimPreparation", "deferClaimPreparationAsync");
    },
    async deferClaimPreparationAsync(claim: WorkerSessionTurnClaim) {
      await runGitHubPublicationMaintenanceAsync({ operation: "deferClaim", claim }, assertCurrent);
    },
    /** @deprecated Use requestForSessionV2; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
    async requestForSession(
      _input: GitHubPublicationSessionRequest,
    ): Promise<SessionGitHubPublicationResult> {
      return refuseLegacyPublication(
        "requestForSession",
        "requestForSessionV2",
        "with a host-prepared requester",
      );
    },
    async requestForSessionV2(input: Parameters<typeof methods.requestForSessionV2>[0]) {
      assertAvailable();
      if (!isGitHubPublicationRequesterV2(input.requester)) {
        throw new Error("GitHub publication requires a host-prepared V2 requester.");
      }
      assertCurrent();
      if (!input.sessionKey) {
        throw new Error("GitHub publication requires an authoritative session.");
      }
      const loaded = await (
        await import("./session-utils-store-worker.js")
      ).loadGatewaySessionEntryReadOnlyInWorker({
        cfg: params.getCommittedRuntimeConfig(),
        key: input.sessionKey,
        agentId: input.agentId,
        assertActive: assertCurrent,
      });
      return loaded.entry?.repositoryWorkspaceId
        ? repository.requestForSessionV2(input)
        : methods.requestForSessionV2(input);
    },
    /** @deprecated Use requestPersonalForSessionV2; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
    async requestPersonalForSession(
      ..._args: Parameters<typeof personal.requestPersonalForSession>
    ): Promise<SessionGitHubPublicationResult> {
      return refuseLegacyPublication(
        "requestPersonalForSession",
        "requestPersonalForSessionV2",
        "with a host-prepared action",
      );
    },
    async requestPersonalForSessionV2(
      ...args: Parameters<typeof personal.requestPersonalForSessionV2>
    ) {
      assertAvailable();
      return (await hasGitHubPublicationRepositoryWorkspace(args[1]))
        ? repository.requestPersonalForSessionV2(...args)
        : personal.requestPersonalForSessionV2(...args);
    },
    preparePersonalStatus: repository.preparePersonalStatus,
    /** @deprecated Use personalStatusAsync and await completion. */
    personalStatus(
      ..._args: Parameters<typeof repository.personalStatusAsync>
    ): SessionGitHubStatusResult {
      return refuseLegacyPublication("personalStatus", "personalStatusAsync");
    },
    async personalStatusAsync(...args: Parameters<typeof repository.personalStatusAsync>) {
      return (
        (await repository.personalStatusAsync(...args)) ??
        personal.personalStatusAsync(args[0], args[1], args[2])
      );
    },
    async personalPending(...args: Parameters<typeof personal.personalPending>) {
      return (await repository.personalPending(...args)) ?? personal.personalPending(...args);
    },
    /** @deprecated Use confirmPersonalV2; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
    confirmPersonal(
      ..._args: Parameters<typeof personal.confirmPersonal>
    ): Promise<SessionGitHubPublicationResult> {
      return refuseLegacyPublication(
        "confirmPersonal",
        "confirmPersonalV2",
        "with a host-prepared action",
      );
    },
    async confirmPersonalV2(...args: Parameters<typeof personal.confirmPersonalV2>) {
      assertAvailable();
      return (await repository.hasRequestAsync(args[0].requestId))
        ? repository.confirmPersonalV2(...args)
        : personal.confirmPersonalV2(...args);
    },
    async processClaim(claim: WorkerSessionTurnClaim) {
      return [...(await methods.processClaim(claim)), ...(await repository.processClaim(claim))];
    },
    async resumeSessionRequests(
      isStopping?: () => boolean,
      isPendingEmpty?: (kind: "shared" | "repository") => boolean,
    ) {
      const failures: unknown[] = [];
      for (const coordinator of [methods, repository]) {
        if (isStopping?.()) {
          break;
        }
        if (coordinator === repository && isPendingEmpty?.("repository")) {
          continue;
        }
        try {
          await coordinator.resumeSessionRequests(
            isStopping,
            () => isPendingEmpty?.("shared") ?? false,
          );
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          failures
            .map((error) => (error instanceof Error ? error.message : String(error)))
            .join("; "),
        );
      }
    },
    /** @deprecated Use deferOrphanedRequestsAsync; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
    deferOrphanedRequests(): void {
      return refuseLegacyPublication("deferOrphanedRequests", "deferOrphanedRequestsAsync");
    },
    async deferOrphanedRequestsAsync(
      isPendingEmpty?: (kind: "shared" | "repository") => boolean,
    ): Promise<void> {
      await methods.deferOrphanedRequestsAsync();
      if (!isPendingEmpty?.("repository")) {
        await repository.deferOrphanedRequestsAsync();
      }
    },
    /** @deprecated Use listUnreportedResultsAsync; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
    listUnreportedResults(): GitHubPublicationTranscriptReport[] {
      return refuseLegacyPublication("listUnreportedResults", "listUnreportedResultsAsync");
    },
    async listUnreportedResultsAsync() {
      const publications: GitHubPublicationTranscriptReport[] = [
        ...(await methods.listUnreportedResultsAsync()),
        ...(await repository.listUnreportedResultsAsync()),
      ];
      for (const publication of publications) {
        const runId = requestingRuns.get(publication.result.requestId);
        if (runId) {
          publication.runId = runId;
        }
      }
      return publications;
    },
    /** @deprecated Use readAsync and await completion. */
    read(_requestId: string): SessionGitHubPublicationResult | undefined {
      return refuseLegacyPublication("read", "readAsync");
    },
    async readAsync(requestId: string) {
      return (await repository.readAsync(requestId)) ?? methods.readAsync(requestId);
    },
    async readReportLifecycleAsync(report: GitHubPublicationTranscriptReport) {
      const requestId = report.result.requestId;
      const row = await readRepositoryGitHubPublicationAsync(requestId);
      assertCurrent();
      if (row) {
        return row.session_lifecycle_revision;
      }
      const lifecycle = await prepareGitHubPublicationSessionLifecycle({
        publicationKind: report.result.publisher?.source === "personal" ? "personal" : "shared",
        requestId,
      });
      assertCurrent();
      const binding = lifecycle.readCurrent();
      if (!binding) {
        throw new Error("GitHub publication transcript lifecycle is unavailable.");
      }
      return binding.lifecycle_revision;
    },
    /** @deprecated Use markReportedAsync; final compatibility day: 2026-12-31; removal in the first January 2027 stable release. */
    markReported(_requestId: string): void {
      return refuseLegacyPublication("markReported", "markReportedAsync");
    },
    async markReportedAsync(requestId: string) {
      await runGitHubPublicationMaintenanceAsync({ operation: "report", requestId }, assertCurrent);
      requestingRuns.delete(requestId);
    },
  };
}

export type GitHubPublicationCoordinator = ReturnType<typeof createGitHubPublicationCoordinator>;
