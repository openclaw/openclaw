import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type, type Static } from "typebox";
import {
  GitHubPublicationBodySchema,
  SessionGitHubPullRequestInspectResultSchema,
  type SessionGitHubActionParams,
} from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
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

export const GitHubToolCommentParamsSchema = Type.Object(
  {
    action: Type.Literal("create_comment"),
    sessionKey: Type.String({ minLength: 1 }),
    agentId: Type.String({ minLength: 1 }),
    issueNumber: SessionGitHubPullRequestInspectResultSchema.properties.number,
    body: GitHubPublicationBodySchema,
  },
  { additionalProperties: false },
);
export type GitHubToolCommentParams = Static<typeof GitHubToolCommentParamsSchema>;

/** Project posts use the registered repository, never a checkout remote or a tool-supplied URL. */
export async function postSessionGitHubProjectItem(
  options: HandlerOptions & {
    params:
      | Extract<SessionGitHubActionParams, { action: "create_issue" }>
      | GitHubToolCommentParams;
  },
) {
  const { params } = options;
  const isComment = params.action === "create_comment";
  const nothingPosted = isComment ? "Nothing was posted." : "Nothing was filed.";
  const caller = getGatewayToolCallerIdentity();
  if (
    caller &&
    (caller.sessionKey !== params.sessionKey ||
      (params.agentId && normalizeAgentId(params.agentId) !== normalizeAgentId(caller.agentId)))
  ) {
    throw new Error(
      `${isComment ? "Commenting" : "Issue creation"} must use the current conversation.`,
    );
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
    throw new Error(
      isComment
        ? "Comment from an active conversation in the intended registered GitHub project. No worktree is needed."
        : "File the issue from an active conversation in the intended registered GitHub project. No worktree is needed.",
    );
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
    throw new Error(
      `${isComment ? "Posting a GitHub comment" : "Filing a GitHub issue"} requires write access to this conversation.`,
    );
  }
  const host = resolveConfiguredGitHubHost(getConfig());
  const unavailable = new Error(
    `This conversation has no registered GitHub repository available to this requester. ${nothingPosted}`,
  );
  const registry = await selectStoredProjectRegistry(entry.projectId);
  const origin = registry?.project.originUrl;
  const target = origin && !URL.parse(origin)?.port && parseProjectGitUrl(origin, host);
  if (!registry || !target) {
    throw unavailable;
  }
  const repository = new URL(target.url).pathname.slice(1, -4);
  const assertSessionCurrent = () => {
    authority.assertCurrent();
    const latest = selected.readCurrent().entry;
    if (!latest || latest.projectId !== entry.projectId || latest.archivedAt !== undefined) {
      throw unavailable;
    }
  };
  const identity = await prepareCurrentGitHubPublicationIdentity(agentId, assertSessionCurrent);
  const assertPublisherCurrent = () => {
    assertSessionCurrent();
    if (
      resolveConfiguredGitHubHost(getConfig()) !== host ||
      (identity.host ?? "github.com") !== host ||
      !matchesCurrentGitHubPublicationIdentity({ agentId, identity })
    ) {
      throw new Error(
        `The selected GitHub account does not match the project's GitHub host. ${nothingPosted}`,
      );
    }
  };
  const recordComment = isComment
    ? await requestGitHubCommentApproval(
        options,
        {
          ...params,
          host,
          repository,
          account: identity.account,
          agentId,
          sessionKey: canonicalKey,
        },
        assertPublisherCurrent,
      )
    : undefined;
  // No browser/native fallback and no retry: a lost POST response may hide a created item.
  const unconfirmed = () => {
    recordComment?.("unconfirmed");
    return new Error(
      isComment
        ? `The GitHub comment is unconfirmed; it may already have been posted. Read https://${host}/${repository}/issues/${params.issueNumber} before posting again.`
        : `GitHub issue creation is unconfirmed. Check https://${host}/${repository}/issues before submitting again.`,
    );
  };
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
        [
          ...githubPublicationApiArgs(
            isComment
              ? `repos/${repository}/issues/${params.issueNumber}/comments`
              : `repos/${repository}/issues`,
            "POST",
            host,
          ),
          "--jq",
          isComment
            ? "{id, url: .html_url, body, authorId: .user.id}"
            : "{number, url: .html_url, authorId: .user.id}",
        ],
        {
          env: identity.env,
          input: JSON.stringify(
            isComment ? { body: params.body } : { title: params.title, body: params.body ?? "" },
          ),
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
        throw unconfirmed();
      }
      recordComment?.("not-posted");
      throw error;
    });
  if (result.code !== 0 || result.error) {
    const status = /\(HTTP (4\d{2})\)/u.exec(result.stderr.toString("utf8"))?.[1];
    if (status && status !== "408" && status !== "499") {
      recordComment?.("rejected");
      throw new Error(
        isComment
          ? `GitHub rejected the comment (HTTP ${status}). Check that #${params.issueNumber} exists in ${repository} and the selected account can comment there.`
          : `GitHub rejected issue creation (HTTP ${status}). Check that issues are enabled and the selected account can file them.`,
      );
    }
    throw unconfirmed();
  }
  let posted: unknown;
  try {
    posted = JSON.parse(result.stdout.toString("utf8"));
  } catch {
    throw unconfirmed();
  }
  if (
    !isRecord(posted) ||
    posted.authorId !== identity.account.accountId ||
    typeof posted.url !== "string"
  ) {
    throw unconfirmed();
  }
  if (isComment) {
    if (
      typeof posted.id !== "number" ||
      !Number.isSafeInteger(posted.id) ||
      posted.id < 1 ||
      posted.body !== params.body
    ) {
      throw unconfirmed();
    }
    const root = `https://${host}/${repository}/`.toLowerCase();
    const suffix = `/${params.issueNumber}#issuecomment-${posted.id}`;
    const url = posted.url.toLowerCase();
    if (url !== `${root}issues${suffix}` && url !== `${root}pull${suffix}`) {
      throw unconfirmed();
    }
    recordComment?.("posted", posted.url);
    return { status: "posted" as const, url: posted.url };
  }
  if (
    !Number.isSafeInteger(posted.number) ||
    typeof posted.number !== "number" ||
    posted.number < 1 ||
    posted.url.toLowerCase() !== `https://${host}/${repository}/issues/${posted.number}`
  ) {
    throw unconfirmed();
  }
  return { status: "created" as const, url: posted.url };
}

/** The approver sees the exact repository, number, account and text that the Gateway posts. */
async function requestGitHubCommentApproval(
  options: HandlerOptions,
  target: Omit<GitHubToolCommentParams, "action"> & {
    host: string;
    repository: string;
    account: PreparedGitHubPublicationIdentity["account"];
  },
  assertCurrent: () => void,
) {
  const manager = options.context.pluginApprovalManager;
  if (!manager) {
    throw new Error("GitHub comment approval is unavailable. Nothing was posted.");
  }
  const repositoryLabel = `${target.host}/${target.repository}`;
  const shown = sanitizeExecApprovalWarningTextWithStatus(target.body);
  const detail = [
    `Repository: ${repositoryLabel}`,
    `Issue or PR: #${target.issueNumber}`,
    `Account: @${target.account.login}`,
    "",
    "Comment body:",
    `| ${shown.text.replaceAll("\n", "\n| ")}`,
  ].join("\n");
  if (shown.truncated || shown.oversized || truncatePluginApprovalDetail(detail) !== detail) {
    throw new Error(
      "The comment cannot be shown in full for approval. Shorten it; nothing was posted.",
    );
  }
  const timeoutMs = 5 * 60 * 1000;
  const toolCallId = randomUUID();
  const payload: PluginApprovalRequestPayload = {
    pluginId: "github",
    title: "Post GitHub comment?",
    description: sanitizeExecApprovalDisplayText(
      `Post this comment on ${repositoryLabel}#${target.issueNumber} as @${target.account.login}?`,
    ).slice(0, 512),
    detail,
    severity: "warning",
    toolName: "github_publish",
    toolCallId,
    agentId: target.agentId,
    sessionKey: target.sessionKey,
    allowedDecisions: ["allow-once", "deny"],
  };
  assertCurrent();
  const record = manager.create(payload, timeoutMs, `plugin:${toolCallId}`);
  record.approvalAuthority = () => {
    assertCurrent();
    return true;
  };
  record.approvalSignals = options.signal ? [options.signal] : [];
  bindApprovalRequesterMetadata({ record, client: options.client });
  const { decision } = await manager.register(record, timeoutMs);
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
  const recordOutcome = (
    outcome: "denied" | "not-posted" | "posted" | "rejected" | "unconfirmed",
    url?: string,
  ) => {
    try {
      createSubsystemLogger("gateway/github-publication").info("GitHub comment", {
        outcome,
        approvalId: record.id,
        approver: record.resolvedBy ?? null,
        account: target.account.login,
        accountId: target.account.accountId,
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        repository: target.repository,
        issueNumber: target.issueNumber,
        ...(url ? { url } : {}),
      });
    } catch {
      // A diagnostic sink cannot change the comment outcome.
    }
  };
  if (approved !== "allow-once") {
    recordOutcome("denied");
    throw new Error(
      "The comment was not approved (denied, cancelled, or expired). Nothing was posted.",
    );
  }
  assertCurrent();
  if (!(await manager.consumeAllowOnce(record.id, "github.comment:" + toolCallId))) {
    throw new Error("The comment approval is no longer available. Nothing was posted.");
  }
  return recordOutcome;
}
