import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionGitHubActionParams } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { resolveConfiguredGitHubHost } from "../agents/github-host.js";
import type { PreparedGitHubPublicationIdentity } from "../agents/github-tool-identity.types.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import {
  sanitizeExecApprovalDisplayText,
  sanitizeExecApprovalWarningTextWithStatus,
} from "../infra/exec-approval-text-sanitize.js";
import {
  truncatePluginApprovalDetail,
  type PluginApprovalRequestPayload,
} from "../infra/plugin-approvals.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseProjectGitUrl } from "../projects/project-git-url.js";
import { selectStoredProjectRegistry } from "../projects/project-registry.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import {
  matchesCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationIdentity,
  prepareGitHubPublicationSession,
} from "./github-publication-availability.js";
import {
  githubPublicationApiArgs,
  runPublicationCommand,
} from "./github-publication-git-transport.js";
import {
  captureGitHubPublicationActionAuthority,
  prepareGitHubPublicationRequesterV2,
} from "./github-publication-requester.js";
import { SESSION_WRITE_SCOPE } from "./operator-scopes.js";
import { canRequesterUseProject, projectRequesterForProfile } from "./project-access.js";
import { handlePendingApprovalRequestWithDelivery } from "./server-methods/approval-request-delivery.js";
import { bindApprovalRequesterMetadata } from "./server-methods/approval-shared.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

type HandlerOptions = Omit<GatewayRequestHandlerOptions, "params">;
type ProjectTarget = {
  host: string;
  repository: string;
  agentId: string;
  sessionKey: string;
  identity: PreparedGitHubPublicationIdentity;
};
type ProjectPost = {
  noun: string;
  nothing: string;
  inactive: string;
  writeRequired: string;
  path: (repository: string) => string;
  input: string;
  jq: string;
  approve?: (target: ProjectTarget, assertCurrent: () => void) => Promise<void>;
  confirm: (result: unknown, target: ProjectTarget) => string | undefined;
};
type ProjectPostOutcome = { target: ProjectTarget } & (
  | { outcome: "created"; url: string }
  | { outcome: "unconfirmed" }
  | { outcome: "rejected"; status: string }
);

/** Issue and comment posts use the registered project, never a checkout remote or a tool-supplied URL. */
async function postToRegisteredGitHubProject(
  options: HandlerOptions,
  params: { sessionKey: string; agentId?: string },
  post: ProjectPost,
): Promise<ProjectPostOutcome> {
  const caller = getGatewayToolCallerIdentity();
  if (
    caller &&
    (caller.sessionKey !== params.sessionKey ||
      (params.agentId && normalizeAgentId(params.agentId) !== normalizeAgentId(caller.agentId)))
  ) {
    throw new Error(`${post.noun} must use the current conversation.`);
  }
  const getConfig = options.context.getCommittedRuntimeConfig ?? options.context.getRuntimeConfig;
  using selected = await prepareGitHubPublicationSession(params.sessionKey, {
    agentId: caller?.agentId ?? params.agentId,
    cfg: getConfig(),
    fields: ["sessionId", "lifecycleRevision", "archivedAt", "projectId"],
    assertCurrent: () => options.sessionMutationAuthorization?.assertCurrent(),
  });
  const { entry, agentId, canonicalKey } = selected.readCurrent();
  if (!entry?.projectId || entry.archivedAt !== undefined) {
    throw new Error(post.inactive);
  }
  const admitted = await prepareGitHubPublicationRequesterV2(options, {
    agentId,
    sessionKey: canonicalKey,
  });
  using _ = { [Symbol.dispose]: admitted.release };
  const authority = captureGitHubPublicationActionAuthority(admitted.requester);
  if (
    !roleScopesAllow({
      role: "operator",
      requestedScopes: [SESSION_WRITE_SCOPE],
      allowedScopes: authority.scopes,
    })
  ) {
    throw new Error(post.writeRequired);
  }
  const host = resolveConfiguredGitHubHost(getConfig());
  const unavailable = new Error(
    `This conversation has no registered GitHub repository available to this requester. ${post.nothing}`,
  );
  const registry = await selectStoredProjectRegistry(entry.projectId);
  const origin = registry?.project.originUrl;
  const parsed = origin && !URL.parse(origin)?.port && parseProjectGitUrl(origin, host);
  if (!registry || !parsed) {
    throw unavailable;
  }
  const repository = new URL(parsed.url).pathname.slice(1, -4);
  const assertSessionCurrent = () => {
    authority.assertCurrent();
    const latest = selected.readCurrent().entry;
    if (!latest || latest.projectId !== entry.projectId || latest.archivedAt !== undefined) {
      throw unavailable;
    }
  };
  const identity = await prepareCurrentGitHubPublicationIdentity(agentId, assertSessionCurrent);
  const target = { host, repository, agentId, sessionKey: canonicalKey, identity };
  const assertPublisherCurrent = () => {
    assertSessionCurrent();
    if (
      resolveConfiguredGitHubHost(getConfig()) !== host ||
      (identity.host ?? "github.com") !== host ||
      !matchesCurrentGitHubPublicationIdentity({ agentId, identity })
    ) {
      throw new Error(
        `The selected GitHub account does not match the project's GitHub host. ${post.nothing}`,
      );
    }
  };
  await post.approve?.(target, assertPublisherCurrent);
  // No browser/native fallback and no retry: a lost POST response may hide a created item.
  let dispatched = false;
  const result = await registry
    .withCurrent(async (current) => {
      const project = current.project;
      if (
        !project ||
        project.originUrl !== origin ||
        project.repoRoot !== registry.project.repoRoot ||
        project.source !== registry.project.source ||
        !(await canRequesterUseProject(
          getConfig(),
          project,
          projectRequesterForProfile(
            getConfig(),
            authority.scopes,
            admitted.requester.snapshot.actor.kind === "operator"
              ? admitted.requester.snapshot.actor.profileId
              : undefined,
            admitted.requester.snapshot.openclawIdPrincipal,
          ),
          { fresh: true },
        ))
      ) {
        throw unavailable;
      }
      return await runPublicationCommand(
        [...githubPublicationApiArgs(post.path(repository), "POST", host), "--jq", post.jq],
        {
          env: identity.env,
          input: post.input,
          beforeRun: () => {
            current.assertCurrent();
            assertPublisherCurrent();
            dispatched = true;
          },
        },
      );
    })
    .catch((error: unknown) => {
      if (dispatched) {
        return undefined;
      }
      throw error;
    });
  if (!result) {
    return { target, outcome: "unconfirmed" };
  }
  if (result.code !== 0 || result.error) {
    const status = /\(HTTP (4\d{2})\)/u.exec(result.stderr.toString("utf8"))?.[1];
    return status && status !== "408" && status !== "499"
      ? { target, outcome: "rejected", status }
      : { target, outcome: "unconfirmed" };
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout.toString("utf8"));
  } catch {
    return { target, outcome: "unconfirmed" };
  }
  const url = post.confirm(value, target);
  return url ? { target, outcome: "created", url } : { target, outcome: "unconfirmed" };
}

export async function createSessionGitHubIssue(
  options: HandlerOptions & {
    params: Extract<SessionGitHubActionParams, { action: "create_issue" }>;
  },
) {
  const { params } = options;
  const posted = await postToRegisteredGitHubProject(options, params, {
    noun: "Issue creation",
    nothing: "Nothing was filed.",
    inactive:
      "File the issue from an active conversation in the intended registered GitHub project. No worktree is needed.",
    writeRequired: "Filing a GitHub issue requires write access to this conversation.",
    path: (repository) => `repos/${repository}/issues`,
    input: JSON.stringify({ title: params.title, body: params.body ?? "" }),
    jq: "{number, url: .html_url, authorId: .user.id}",
    confirm: (issue, { host, repository, identity }) =>
      isRecord(issue) &&
      Number.isSafeInteger(issue.number) &&
      typeof issue.number === "number" &&
      issue.number >= 1 &&
      issue.authorId === identity.account.accountId &&
      typeof issue.url === "string" &&
      issue.url.toLowerCase() === `https://${host}/${repository}/issues/${issue.number}`
        ? issue.url
        : undefined,
  });
  if (posted.outcome === "created") {
    return { status: "created" as const, url: posted.url };
  }
  if (posted.outcome === "rejected") {
    throw new Error(
      `GitHub rejected issue creation (HTTP ${posted.status}). Check that issues are enabled and the selected account can file them.`,
    );
  }
  throw new Error(
    `GitHub issue creation is unconfirmed. Check https://${posted.target.host}/${posted.target.repository}/issues before submitting again.`,
  );
}

const COMMENT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/** The approver sees the exact repository, number, account and text that the Gateway posts. */
async function requestGitHubCommentApproval(
  options: HandlerOptions,
  target: ProjectTarget,
  params: { issueNumber: number; body: string },
  assertCurrent: () => void,
): Promise<{ id: string; approver: string | null }> {
  const manager = options.context.pluginApprovalManager;
  if (!manager) {
    throw new Error("GitHub comment approval is unavailable. Nothing was posted.");
  }
  const repositoryLabel = `${target.host}/${target.repository}`;
  const shown = sanitizeExecApprovalWarningTextWithStatus(params.body);
  const detail = [
    `Repository: ${repositoryLabel}`,
    `Issue or PR: #${params.issueNumber}`,
    `Account: @${target.identity.account.login}`,
    "",
    "Comment body:",
    `| ${shown.text.replaceAll("\n", "\n| ")}`,
  ].join("\n");
  if (shown.truncated || shown.oversized || truncatePluginApprovalDetail(detail) !== detail) {
    throw new Error(
      "The comment cannot be shown in full for approval. Shorten it; nothing was posted.",
    );
  }
  const toolCallId = randomUUID();
  const payload: PluginApprovalRequestPayload = {
    pluginId: "github",
    title: "Post GitHub comment?",
    description: sanitizeExecApprovalDisplayText(
      `Post this comment on ${repositoryLabel}#${params.issueNumber} as @${target.identity.account.login}?`,
    ).slice(0, 512),
    detail,
    severity: "warning",
    scope: null,
    toolName: "github_publish",
    toolCallId,
    agentId: target.agentId,
    sessionKey: target.sessionKey,
    runId: null,
    allowedDecisions: ["allow-once", "deny"],
    actions: [
      { kind: "decision", decision: "allow-once", label: "Post once", command: "allow-once" },
      { kind: "decision", decision: "deny", label: "Deny", command: "deny" },
    ],
    turnSourceChannel: null,
    turnSourceTo: null,
    turnSourceAccountId: null,
    turnSourceThreadId: null,
  };
  assertCurrent();
  const record = manager.create(payload, COMMENT_APPROVAL_TIMEOUT_MS, "plugin:" + randomUUID());
  record.approvalAuthority = () => {
    assertCurrent();
    return true;
  };
  record.approvalSignals = options.signal ? [options.signal] : [];
  bindApprovalRequesterMetadata({ record, client: options.client });
  const { decision } = await manager.register(record, COMMENT_APPROVAL_TIMEOUT_MS);
  await handlePendingApprovalRequestWithDelivery({
    approvalKind: "plugin",
    manager,
    record,
    respond: () => {},
    context: options.context,
    twoPhase: false,
    forwardRequest: options.context.forwardPluginApprovalRequest,
    getIosPushDelivery: () => options.context.pluginApprovalIosPushDelivery,
  });
  const approved = manager.projectDecisionIfActive(record.id, await decision);
  const approval = { id: record.id, approver: record.resolvedBy ?? null };
  if (approved !== "allow-once") {
    recordGitHubComment(target, params.issueNumber, approval, "denied");
    throw new Error(
      "The comment was not approved (denied, cancelled, or expired). Nothing was posted.",
    );
  }
  assertCurrent();
  if (!(await manager.consumeAllowOnce(record.id, "github.comment:" + toolCallId))) {
    throw new Error("The comment approval is no longer available. Nothing was posted.");
  }
  return approval;
}

/** Metadata only: never the comment body, command output, or credential. */
function recordGitHubComment(
  target: ProjectTarget,
  issueNumber: number,
  approval: { id: string; approver: string | null },
  outcome: "denied" | "not-posted" | "posted" | "rejected" | "unconfirmed",
  url?: string,
) {
  try {
    createSubsystemLogger("gateway/github-publication").info("GitHub comment", {
      outcome,
      approvalId: approval.id,
      approver: approval.approver,
      account: target.identity.account.login,
      accountId: target.identity.account.accountId,
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      repository: target.repository,
      issueNumber,
      ...(url ? { url } : {}),
    });
  } catch {
    // A diagnostic sink cannot change the comment outcome.
  }
}

export async function createSessionGitHubComment(
  options: HandlerOptions & {
    params: Extract<SessionGitHubActionParams, { action: "create_comment" }>;
  },
) {
  const { params } = options;
  let approved:
    | { target: ProjectTarget; approval: { id: string; approver: string | null } }
    | undefined;
  let posted: ProjectPostOutcome;
  try {
    posted = await postToRegisteredGitHubProject(options, params, {
      noun: "Commenting",
      nothing: "Nothing was posted.",
      inactive:
        "Comment from an active conversation in the intended registered GitHub project. No worktree is needed.",
      writeRequired: "Posting a GitHub comment requires write access to this conversation.",
      path: (repository) => `repos/${repository}/issues/${params.issueNumber}/comments`,
      input: JSON.stringify({ body: params.body }),
      jq: "{id, url: .html_url, body, authorId: .user.id}",
      approve: async (target, assertCurrent) => {
        approved = {
          target,
          approval: await requestGitHubCommentApproval(options, target, params, assertCurrent),
        };
      },
      confirm: (comment, { host, repository, identity }) => {
        if (
          !isRecord(comment) ||
          typeof comment.id !== "number" ||
          !Number.isSafeInteger(comment.id) ||
          comment.id < 1 ||
          comment.body !== params.body ||
          comment.authorId !== identity.account.accountId ||
          typeof comment.url !== "string"
        ) {
          return undefined;
        }
        const thread = `https://${host}/${repository}/`.toLowerCase();
        const suffix = `/${params.issueNumber}#issuecomment-${comment.id}`;
        const url = comment.url.toLowerCase();
        return url === `${thread}issues${suffix}` || url === `${thread}pull${suffix}`
          ? comment.url
          : undefined;
      },
    });
  } catch (error) {
    if (approved) {
      recordGitHubComment(approved.target, params.issueNumber, approved.approval, "not-posted");
    }
    throw error;
  }
  if (!approved) {
    throw new Error("The comment was not approved. Nothing was posted.");
  }
  const { target, approval } = approved;
  if (posted.outcome === "created") {
    recordGitHubComment(target, params.issueNumber, approval, "posted", posted.url);
    return { status: "posted" as const, url: posted.url };
  }
  recordGitHubComment(target, params.issueNumber, approval, posted.outcome);
  if (posted.outcome === "rejected") {
    throw new Error(
      `GitHub rejected the comment (HTTP ${posted.status}). Check that #${params.issueNumber} exists in ${target.repository} and the selected account can comment there.`,
    );
  }
  throw new Error(
    `The GitHub comment is unconfirmed; it may already have been posted. Read https://${target.host}/${target.repository}/issues/${params.issueNumber} before posting again.`,
  );
}
