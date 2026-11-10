import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveConfiguredGitHubHost } from "../agents/github-host.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { callGatewayTool } from "../agents/tools/gateway.js";
import type { CronJob } from "../cron/types.js";
import { sessionPrAutoFixTarget } from "../shared/session-pr-auto-fix.js";
import { pullRequestState } from "./github-publication-action-target.js";
import {
  fingerprint,
  unavailable,
  readPrAutoFixFeedback,
} from "./github-publication-auto-fix-feedback.js";
import {
  assertExpectedSharedGitHubPublisher,
  currentGitHubPublicationConfig,
  prepareGitHubPublicationSession,
  readGitHubPublicationWorktreeOwner,
} from "./github-publication-availability.js";
import { GitHubPublicationReadUnavailableError } from "./github-publication-json-read.js";
import { projectGitHubPublicationResult } from "./github-publication-receipt.js";
import { prepareGitHubPublicationRequesterV2 } from "./github-publication-requester.js";
import { prepareSelectedGitHubPullRequestReader } from "./github-publication-selected-read.js";
import { readSharedGitHubPublication } from "./github-publication-shared-read.js";
import { resolveLeastPrivilegeOperatorScopesForMethod } from "./method-scopes.js";
import { withInProcessGatewayDispatch } from "./server-plugin-in-process-dispatch.js";

/** Native selected-session observer. Never adopts a PR or submits publication; terminal cleanup is self-only. */
export async function readSessionPrAutoFixObservation(params: {
  job: CronJob;
  assertCurrent: () => void;
}) {
  const target = sessionPrAutoFixTarget(params.job);
  if (!target) {
    throw new Error(
      "Auto-fix requires its authenticated scheduled source; recreate this automation from the owning conversation.",
    );
  }
  const assertCurrent = params.assertCurrent;
  using selected = await prepareGitHubPublicationSession(target.sessionKey, {
    agentId: target.agentId,
    assertCurrent,
  });
  const loaded = selected.readCurrent();
  if (!loaded.entry) {
    throw new Error("Auto-fix owning session is unavailable.");
  }
  const session = {
    agentId: loaded.agentId,
    sessionKey: loaded.canonicalKey,
    sessionId: loaded.entry.sessionId,
  };
  const binding = loaded.entry.worktree?.githubPullRequest;
  const publication = await readSharedGitHubPublication(session, {}, selected.readCurrent);
  assertCurrent();
  const published =
    publication?.status === "published"
      ? publication
      : await readSharedGitHubPublication(session, { status: "published" }, selected.readCurrent);
  assertCurrent();
  const url = binding?.url ?? published?.pull_request_url;
  const host = resolveConfiguredGitHubHost(currentGitHubPublicationConfig());
  const parsed = URL.parse(url ?? "");
  const parts = parsed?.pathname.split("/");
  const owner = parts?.[1];
  const repo = parts?.[2];
  const number = Number(parts?.[4]);
  const key =
    "session-pr:v1:" +
    fingerprint([
      target.agentId,
      target.sessionKey,
      null,
      owner?.toLowerCase(),
      repo?.toLowerCase(),
      number,
    ]) +
    ":autoFix";
  if (
    !url ||
    !owner ||
    !repo ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    parsed?.host !== host ||
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parts?.length !== 5 ||
    parts[3] !== "pull" ||
    params.job.declarationKey !== key
  ) {
    throw new Error(
      "Auto-fix target is not this session's selected or published PR. Restore its workspace association; no other PR was adopted.",
    );
  }
  const assertCaller = captureGatewayToolCallerAssertion();
  const resolveGatewayContext = getGatewayToolCallerIdentity()?.gatewayContextResolver;
  if (!assertCaller || !resolveGatewayContext) {
    throw new Error("Auto-fix requires an admitted Gateway caller.");
  }
  const method = "sessions.github.action";
  const request = { action: "edit", sessionKey: session.sessionKey, agentId: session.agentId };
  return await withInProcessGatewayDispatch(
    method,
    request,
    {
      forceSyntheticClient: true,
      operatorRoleActor: { kind: "system" },
      syntheticScopes: resolveLeastPrivilegeOperatorScopesForMethod(method, request),
      syntheticScopeMode: "minimum",
      resolveGatewayContext,
    },
    async (resolved) => {
      const assertRequest = () => {
        assertCurrent();
        selected.readCurrent();
        assertCaller();
        resolved.assertContextCurrent();
        resolved.assertInvocationCurrent();
      };
      const admitted = await prepareGitHubPublicationRequesterV2(resolved, session);
      try {
        const branch = binding?.head?.branch ?? published?.branch;
        if (!branch) {
          throw new Error("Auto-fix selected PR head branch is unavailable.");
        }
        const pullRequest = {
          url,
          repository: binding?.base.repository ?? owner + "/" + repo,
          branch,
        };
        const reader = await prepareSelectedGitHubPullRequestReader({
          session,
          pullRequest,
          binding,
          requester: admitted.requester,
          assertCurrent: assertRequest,
        });
        if (!binding && published) {
          assertExpectedSharedGitHubPublisher(projectGitHubPublicationResult(published).publisher, {
            source: reader.identity.source,
            ...reader.identity.account,
          });
        }
        const raw = await reader.readJson(reader.endpoint);
        const state = pullRequestState(
          raw,
          pullRequest,
          binding,
          reader.inspection?.result.author.accountId,
        );
        if (!isRecord(raw) || !isRecord(raw.user) || typeof raw.user.login !== "string") {
          throw unavailable();
        }
        const head = state.headCommit;
        const previous = isRecord(params.job.state.triggerState)
          ? params.job.state.triggerState
          : undefined;
        const retainedId =
          typeof previous?.pendingRequestId === "string" ? previous.pendingRequestId : undefined;
        // Observe an accepted task by its original id. The native publication owner
        // retains recovery; this condition never submits/replays publication work.
        let retained = retainedId
          ? await readSharedGitHubPublication(
              session,
              { requestId: retainedId },
              selected.readCurrent,
            )
          : publication;
        assertRequest();
        if (retainedId && !retained) {
          throw unavailable();
        }
        let currentPublication = retained ? projectGitHubPublicationResult(retained) : undefined;
        let pendingPublication =
          currentPublication?.status === "requested" || currentPublication?.status === "publishing";
        const terminal = ["closed", "merged"].includes(state.state);
        if (terminal) {
          // The trigger holds the actual scheduled invocation’s self-removal capability.
          // Use the same public handler as the automations tool, never direct job mutation.
          try {
            await withGatewayToolCallerIdentity(
              {
                ...getGatewayToolCallerIdentity(),
                agentId: target.agentId,
                sessionKey: target.sessionKey,
                cronSelfManagementJobId: params.job.id,
              },
              () =>
                callGatewayTool(
                  "cron.remove",
                  {},
                  { id: params.job.id },
                  { requireAgentRuntimeIdentity: true },
                ),
            );
          } catch (error) {
            // A self-removal can cancel its own caller after commit. Inspect local
            // owner state before any retry; an absent exact job needs no replay.
            if (resolved.context.cron.getJob(params.job.id)) {
              assertRequest();
              throw new GitHubPublicationReadUnavailableError(
                "Terminal PR cleanup is not confirmed; retain this job for another bounded attempt",
                { cause: error },
              );
            }
          }
          if (resolved.context.cron.getJob(params.job.id)) {
            throw new GitHubPublicationReadUnavailableError(
              "Terminal PR cleanup is not confirmed; retain this job for another bounded attempt",
            );
          }
          return {
            head,
            complete: true,
            terminal: true,
            actionable: false,
            fingerprint: fingerprint([head, state.state]),
            findings: [],
            publication: currentPublication,
            cleanupConfirmed: true,
          };
        }
        if (retained && ["requested", "publishing"].includes(retained.status)) {
          const current = selected.readCurrent().entry;
          if (
            !("worktree_id" in retained) ||
            !current?.worktree ||
            retained.worktree_id !== current.worktree.id ||
            (retained.repository !== null && retained.repository !== pullRequest.repository) ||
            retained.branch !== branch ||
            (retained.pull_request_url && retained.pull_request_url !== url)
          ) {
            throw new Error(
              "Accepted publication no longer belongs to this selected PR/workspace; no recovery was attempted",
            );
          }
          // Queued requests have no remote repository metadata until preparation.
          // Anchor that phase to this selected PR and the original native custody,
          // rather than mistaking an uninitialized remote field for a mismatch.
          const selectedTarget = binding
            ? binding.url === url &&
              binding.base.repository === pullRequest.repository &&
              binding.head?.branch === branch
            : published?.pull_request_url === url &&
              published.repository === pullRequest.repository &&
              published.branch === branch;
          if (
            retained.repository === null &&
            (retained.status !== "requested" || !selectedTarget)
          ) {
            throw new Error(
              "Accepted publication has no verified selected target; no recovery was attempted",
            );
          }
          using recoveryWorkspace = await readGitHubPublicationWorktreeOwner({
            ...session,
            allowExistingPullRequest: true,
            expected: {
              worktreeId: retained.worktree_id,
              repositoryFingerprint: retained.repository_fingerprint,
              branch,
            },
          });
          assertRequest();
          recoveryWorkspace.assertCurrent();
          const publicationOwner = resolved.context.githubPublicationService;
          if (!publicationOwner) {
            throw new Error("Native publication recovery owner is unavailable");
          }
          // This resumes the already accepted request under its original custody.
          // The owner’s placement, snapshot, requester and recovery gates remain authoritative.
          await publicationOwner.resumeSessionRequests(
            () => {
              assertRequest();
              recoveryWorkspace.assertCurrent();
              return false;
            },
            undefined,
            retained.request_id,
          );
          assertRequest();
          retained = await readSharedGitHubPublication(
            session,
            { requestId: retained.request_id },
            selected.readCurrent,
          );
          assertRequest();
          if (!retained) {
            throw unavailable();
          }
        }
        currentPublication = retained ? projectGitHubPublicationResult(retained) : undefined;
        pendingPublication =
          currentPublication?.status === "requested" || currentPublication?.status === "publishing";
        if (pendingPublication) {
          return {
            head,
            complete: true,
            terminal: false,
            pendingPublication: true,
            publication: currentPublication,
            pendingRequestId: currentPublication?.requestId,
            scan: previous?.scan,
            actionable: false,
            findings: [],
          };
        }
        const attempt = isRecord(previous?.attempt) ? previous.attempt : undefined;
        const attemptedFindings = Array.isArray(attempt?.findings)
          ? attempt.findings.filter(isRecord)
          : [];
        // Observation failures are scheduler occurrences too. Read the exact payload
        // receipt, not lastRunStatus (which a later failed native read can replace).
        let outcome: Record<string, unknown> | undefined;
        const attemptAtMs = attempt?.atMs;
        if (typeof attemptAtMs === "number") {
          const history = await withGatewayToolCallerIdentity(
            {
              ...getGatewayToolCallerIdentity(),
              agentId: target.agentId,
              sessionKey: target.sessionKey,
              cronSelfManagementJobId: params.job.id,
            },
            () =>
              callGatewayTool(
                "cron.runs",
                {},
                {
                  id: params.job.id,
                  runId: `cron:${params.job.id}:${attemptAtMs}`,
                  limit: 1,
                },
                { requireAgentRuntimeIdentity: true },
              ),
          );
          assertRequest();
          if (!isRecord(history) || !Array.isArray(history.entries)) {
            throw unavailable();
          }
          outcome = history.entries.find(
            (entry) =>
              isRecord(entry) && entry.runAtMs === attemptAtMs && entry.triggerFired === true,
          );
        }
        const settled = Boolean(outcome);
        // Do not replace an attempt whose outcome was never durably observed.
        // Run history can expire (or fail to persist) before our next tick.
        const outcomeUnavailable = Boolean(
          attempt && !settled && previous?.observedAtMs !== attempt.atMs,
        );
        const result = isRecord(outcome?.result) ? outcome.result : undefined;
        const attemptedPublication = isRecord(attempt?.publication)
          ? attempt.publication
          : undefined;
        const publicationFailed =
          currentPublication?.status === "failed" &&
          currentPublication.requestId !== attemptedPublication?.requestId;
        const retryable =
          settled &&
          (outcome?.status !== "ok" ||
            (result && ["blocked", "needs_attention"].includes(String(result.outcome))) ||
            publicationFailed);
        // Scratch is an explicit invocation-bound judgment, not the final reply or a claim of success.
        const scratch = await resolved.context.cron.readScratch(params.job.id, {
          assertCurrent: assertRequest,
        });
        assertRequest();
        let judgment: Record<string, unknown> | undefined;
        if (
          settled &&
          outcome?.status === "ok" &&
          scratch.scratch &&
          scratch.scratch.updatedAtMs >= Number(attempt?.atMs) &&
          result &&
          Number(outcome?.ts) >= scratch.scratch.updatedAtMs
        ) {
          try {
            const value: unknown = JSON.parse(scratch.scratch.content);
            if (
              isRecord(value) &&
              isRecord(value.prAutoFix) &&
              value.prAutoFix.url === url &&
              value.prAutoFix.attempt === attempt?.fingerprint &&
              Array.isArray(value.prAutoFix.findings)
            ) {
              judgment = value.prAutoFix;
            }
          } catch {
            /* Free-form scratch is never a disposition. */
          }
        }
        const dispositions = Array.isArray(previous?.dispositions)
          ? previous.dispositions.filter(isRecord)
          : [];
        // Quiet receipts describe successful unresolved turns, never resolution. Keep
        // them separately so another batch cannot replay persistent praise/no-op input.
        const quietFindings = Array.isArray(previous?.quietFindings)
          ? previous.quietFindings.filter(isRecord)
          : [];
        const quietChecks = Array.isArray(previous?.quietChecks)
          ? previous.quietChecks.filter(
              (revision): revision is string => typeof revision === "string",
            )
          : [];
        if (settled && !retryable && !pendingPublication) {
          for (const item of attemptedFindings) {
            if (!quietFindings.some((f) => f.revision === item.revision)) {
              quietFindings.push({ revision: item.revision });
            }
          }
          if (typeof attempt?.checks === "string" && !quietChecks.includes(attempt.checks)) {
            quietChecks.push(attempt.checks);
          }
        }
        // This is the native recipe's own persisted cursor, not model-provided success.
        const producerId =
          published?.pull_request_url === url &&
          raw.user.type === "Bot" &&
          raw.user.id === published.identity_account_id
            ? published.identity_account_id
            : undefined;
        const { scan, complete, inventoryComplete, freshNodes, exactHeadChecks, reopenedFindings } =
          await readPrAutoFixFeedback({
            previous,
            head,
            owner,
            repo,
            number,
            reader,
            pullRequest,
            producerId,
            humanAuthorId:
              raw.user.type === "User" &&
              typeof raw.user.id === "number" &&
              Number.isSafeInteger(raw.user.id) &&
              raw.user.id > 0
                ? raw.user.id
                : undefined,
            retryable,
            attemptedFindings,
            dispositions,
            quietFindings,
          });
        const fresh = pullRequestState(
          await reader.readJson(reader.endpoint),
          pullRequest,
          binding,
          reader.inspection?.result.author.accountId,
        );
        if (fresh.headCommit !== head || fresh.state !== state.state) {
          throw unavailable();
        }
        assertRequest();
        const acceptedPublication =
          currentPublication?.status === "published" ? currentPublication : undefined;
        const verifiedPublication =
          acceptedPublication &&
          acceptedPublication.url === url &&
          acceptedPublication.headCommit === head &&
          acceptedPublication.requestId !==
            (isRecord(attempt?.publication) ? attempt.publication.requestId : undefined) &&
          attempt?.head !== head;
        const decisions = Array.isArray(judgment?.findings)
          ? judgment.findings.filter(isRecord)
          : [];
        let changedFiles: string[] = [];
        if (
          complete &&
          verifiedPublication &&
          exactHeadChecks &&
          decisions.some((d) => d.status === "addressed")
        ) {
          const files = await reader.readJson(
            "repos/" + pullRequest.repository + "/commits/" + head + "?per_page=100",
            {
              jq: ".files | map(.filename)",
            },
          );
          if (
            !Array.isArray(files) ||
            !files.every((file): file is string => typeof file === "string")
          ) {
            throw unavailable();
          }
          // Exactly a full page cannot establish a complete changed-file inventory.
          if (files.length < 100) {
            changedFiles = files;
          }
        }
        const confirmed: Record<string, unknown>[] = [];
        if (complete) {
          for (const item of attemptedFindings) {
            // Reopening invalidates this attempt’s already-consumed evidence too.
            // A retained old judgment/publication cannot immediately restore it.
            if (reopenedFindings.has(String(item.id))) {
              continue;
            }
            const current = freshNodes.find((node) => node.id === item.id);
            const pr = current?.pullRequest ?? current?.issue;
            if (
              !current ||
              !isRecord(pr) ||
              pr.number !== number ||
              !isRecord(pr.repository) ||
              pr.repository.nameWithOwner !== pullRequest.repository ||
              fingerprint([current.id, current.updatedAt]) !== item.revision
            ) {
              continue;
            }
            const decision = decisions.find(
              (d) => d.id === item.id && d.revision === item.revision,
            );
            const explicit =
              decision &&
              typeof decision.reason === "string" &&
              decision.reason.trim() &&
              typeof decision.quote === "string" &&
              decision.quote.trim() &&
              typeof current.body === "string" &&
              current.body.includes(decision.quote);
            const threadResolved =
              typeof item.threadId === "string" &&
              freshNodes.some((node) => node.id === item.threadId && node.isResolved === true);
            const addressed =
              acceptedPublication &&
              verifiedPublication &&
              exactHeadChecks &&
              (threadResolved ||
                (explicit &&
                  decision.status === "addressed" &&
                  judgment?.publicationRequestId === acceptedPublication.requestId &&
                  judgment?.head === head &&
                  typeof decision.path === "string" &&
                  changedFiles.includes(decision.path)));
            const notActionable =
              explicit && decision.status === "not_actionable" && judgment?.head === head;
            if (addressed || notActionable) {
              confirmed.push({
                id: item.id,
                revision: item.revision,
                threadId: item.threadId,
                ...(item.threadId ? { threadResolved } : {}),
                status: addressed ? "addressed" : "not_actionable",
                head,
                reason: explicit
                  ? String(decision.reason).slice(0, 240)
                  : "Native thread resolution and exact-head CI after the accepted publication",
                ...(addressed ? { requestId: acceptedPublication.requestId } : {}),
                ...(explicit
                  ? {
                      quote: String(decision.quote).slice(0, 160),
                      ...(typeof decision.path === "string"
                        ? { path: decision.path.slice(0, 160) }
                        : {}),
                    }
                  : {}),
              });
            }
          }
        }
        for (const decision of confirmed) {
          if (!dispositions.some((d) => d.revision === decision.revision)) {
            dispositions.push(decision);
          }
        }
        const outstanding = scan.findings.filter(
          (f) => !dispositions.some((d) => d.revision === f.revision),
        );
        // CI deduplication is independent of feedback batching. A successful no-op
        // on [comment A, check X] must not dispatch unchanged X after A goes quiet.
        const checks = scan.failures ? fingerprint([head, scan.checkDigest]) : null;
        const actionableChecks = checks && !quietChecks.includes(checks) ? checks : null;
        const disposition = attemptedFindings.length
          ? {
              status: attemptedFindings.every((f) =>
                dispositions.some((d) => d.revision === f.revision),
              )
                ? "reviewed"
                : "blocked",
              findings: attemptedFindings,
              confirmed: confirmed.map(({ id, revision, status }) => ({ id, revision, status })),
              reason:
                "Only fresh exact-revision judgments or native resolution with publication/CI evidence qualify",
            }
          : undefined;
        return {
          head,
          complete,
          terminal: false,
          inventoryComplete,
          scan: inventoryComplete
            ? null
            : { ...scan, findings: [], count: 0, digest: fingerprint([]) },
          publication: currentPublication,
          pendingPublication,
          pendingRequestId: pendingPublication ? currentPublication?.requestId : null,
          disposition,
          dispositions,
          quietFindings,
          quietChecks,
          settled,
          outcomeUnavailable,
          reopened: reopenedFindings.size > 0,
          retryable,
          atMs: params.job.state.runningAtMs,
          actionable: outstanding.length > 0 || Boolean(actionableChecks),
          checks: actionableChecks,
          fingerprint: fingerprint([outstanding.map((f) => f.revision), actionableChecks]),
          findings: outstanding,
          findingCount: scan.count,
          unresolvedQuietCount:
            quietFindings.filter((f) => !dispositions.some((d) => d.revision === f.revision))
              .length + (checks && quietChecks.includes(checks) ? 1 : 0),
          previewIncomplete: !inventoryComplete || scan.count > scan.findings.length,
          failingChecks: scan.failures,
          state: state.state,
        };
      } finally {
        admitted.release();
      }
    },
  );
}
