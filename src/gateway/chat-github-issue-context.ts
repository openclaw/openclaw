import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveGitHubHost } from "../agents/github-host-runtime.js";
import type { TemplateContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { factoryGitHubRequestDigest } from "./factory-github-proof.js";
import { gitHubPublicApi } from "./github-public-api.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";
import { prepareGatewayProjectGitHubIdentity } from "./project-github-identity.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { prepareSessionMutationFacts } from "./session-sharing-preparation.js";

const URL_CANDIDATE = /https:\/\/[^\s<>"']+/gu;
const BODY_CHARS = 24 * 1024;
const COMMENT_CHARS = 2 * 1024;
const COMMENT_LIMIT = 8;

type IssueTarget = { owner: string; repo: string; number: number; url: string };
type IssueComment = {
  author: string;
  body: string;
  createdAt?: string;
};
type IssueDocument = {
  author: string;
  body: string;
  comments: IssueComment[];
  commentsTotal: number;
  createdAt?: string;
  state?: string;
  title: string;
  updatedAt?: string;
};

function trimUrlPunctuation(value: string): string {
  return value.replace(/[),.;:!?\]}]+$/u, "");
}

function parseSessionGitHubIssueTarget(params: {
  message: string;
  repositoryUrl: string;
  host?: string;
}): IssueTarget | undefined {
  const host = (params.host ?? resolveGitHubHost()).toLowerCase();
  const repository = parseGitHubRemoteUrl(params.repositoryUrl, host);
  if (!repository) {
    return undefined;
  }
  for (const candidate of params.message.match(URL_CANDIDATE) ?? []) {
    try {
      const url = new URL(trimUrlPunctuation(candidate));
      if (
        url.protocol !== "https:" ||
        url.hostname.toLowerCase() !== host ||
        url.port ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        continue;
      }
      const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (segments.length !== 4 || segments[2] !== "issues") {
        continue;
      }
      const target = gitHubPublicApi.parseGitHubTarget({
        kind: "issue",
        owner: segments[0],
        repo: segments[1],
        number: Number(segments[3]),
      });
      if (
        target?.kind === "issue" &&
        target.owner.toLowerCase() === repository.owner.toLowerCase() &&
        target.repo.toLowerCase() === repository.repo.toLowerCase()
      ) {
        return {
          ...target,
          url: `https://${host}/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues/${target.number}`,
        };
      }
    } catch {
      // Ignore non-URL text and unsupported escaped path segments.
    }
  }
  return undefined;
}

async function loadSessionGitHubIssue(
  target: IssueTarget,
  identity: {
    token: string;
    revalidate: () => Promise<void>;
    assertSelected: () => void;
  },
): Promise<IssueDocument> {
  const repositoryUrl = `${gitHubPublicApi.GITHUB_API_BASE_URL}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  const rejectRedirect = async () => {
    throw new gitHubPublicApi.ControlUiGitHubError(
      409,
      "GitHub repository changed while loading the selected issue",
    );
  };
  const read = async (url: string) =>
    await gitHubPublicApi.readGitHubJsonResponse(
      await gitHubPublicApi.fetchGitHubApi(url, fetch, identity.token, rejectRedirect, identity),
    );
  const value = await read(`${repositoryUrl}/issues/${target.number}`);
  if (!gitHubPublicApi.isRecord(value) || value.pull_request !== undefined) {
    throw new gitHubPublicApi.ControlUiGitHubError(404, "GitHub issue is unavailable");
  }
  const author = gitHubPublicApi.isRecord(value.user)
    ? gitHubPublicApi.readOptionalGitHubString(value.user, "login")
    : undefined;
  const commentsTotal = gitHubPublicApi.optionalNumber(value, "comments");
  if (commentsTotal === undefined || !Number.isSafeInteger(commentsTotal) || commentsTotal < 0) {
    throw new gitHubPublicApi.ControlUiGitHubError(502, "GitHub response omitted comments");
  }
  let comments: IssueComment[] = [];
  if (commentsTotal > 0) {
    const page = await read(
      `${repositoryUrl}/issues/${target.number}/comments?per_page=${COMMENT_LIMIT}`,
    );
    if (!Array.isArray(page)) {
      throw new gitHubPublicApi.ControlUiGitHubError(502, "GitHub comments were not an array");
    }
    comments = page.slice(0, COMMENT_LIMIT).map((comment) => {
      if (!gitHubPublicApi.isRecord(comment)) {
        throw new gitHubPublicApi.ControlUiGitHubError(502, "GitHub comment was not an object");
      }
      const commentAuthor = gitHubPublicApi.isRecord(comment.user)
        ? gitHubPublicApi.readOptionalGitHubString(comment.user, "login")
        : undefined;
      return {
        author: commentAuthor ?? "ghost",
        body: gitHubPublicApi.readOptionalGitHubString(comment, "body") ?? "",
        createdAt: gitHubPublicApi.readOptionalGitHubString(comment, "created_at"),
      };
    });
  }
  return {
    author: author ?? "ghost",
    body: gitHubPublicApi.readOptionalGitHubString(value, "body") ?? "",
    comments,
    commentsTotal,
    createdAt: gitHubPublicApi.readOptionalGitHubString(value, "created_at"),
    state: gitHubPublicApi.readOptionalGitHubString(value, "state"),
    title: gitHubPublicApi.requiredString(value, "title"),
    updatedAt: gitHubPublicApi.readOptionalGitHubString(value, "updated_at"),
  };
}

export async function attachSessionGitHubIssueContext(params: {
  agentId: string;
  assertActive: () => void;
  config: OpenClawConfig;
  context: Pick<GatewayRequestContext, "getRuntimeConfig">;
  client: GatewayClient | null;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision?: string;
  message: string;
  repositoryWorkspaceId?: string;
  templateContext: TemplateContext;
}): Promise<void> {
  if (!params.repositoryWorkspaceId) {
    return;
  }
  params.assertActive();
  const repository = await getSessionRepositoryWorkspaceStore().get(params.repositoryWorkspaceId);
  params.assertActive();
  if (!repository || repository.agentId !== params.agentId) {
    return;
  }
  const target = parseSessionGitHubIssueTarget({
    message: params.message,
    repositoryUrl: repository.url,
  });
  if (!target) {
    return;
  }
  params.assertActive();
  const sessionFacts =
    process.env.FACTORY_AUTH_MODE === "github" &&
    params.config.gateway?.projects?.nativeGitHubSearch === true
      ? await prepareSessionMutationFacts({
          cfg: params.context.getRuntimeConfig(),
          agentId: params.agentId,
          sessionKey: params.sessionKey,
        })
      : undefined;
  const assertActive = () => {
    params.assertActive();
    if (sessionFacts) {
      const currentSession = sessionFacts.readCurrent(params.context.getRuntimeConfig()).target;
      if (
        currentSession?.agentId !== params.agentId ||
        currentSession.canonicalKey !== params.sessionKey ||
        currentSession.entry.sessionId !== params.sessionId ||
        currentSession.entry.repositoryWorkspaceId !== params.repositoryWorkspaceId ||
        (currentSession.entry.lifecycleRevision ?? null) !== (params.lifecycleRevision ?? null)
      ) {
        throw new Error("GitHub issue context session changed during preparation");
      }
    }
  };
  try {
    assertActive();
    const identity = await prepareGatewayProjectGitHubIdentity({
      agentId: params.agentId,
      assertActive,
      config: params.config,
      context: params.context,
      client: params.client,
      sessionKey: params.sessionKey,
      factoryCredential: {
        claim: {
          purpose: "session-issue-read",
          binding: {
            kind: "session",
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            lifecycleRevision: params.lifecycleRevision ?? null,
            requestDigest: factoryGitHubRequestDigest(target.url),
          },
        },
        assertCurrent: assertActive,
      },
    });
    if (!identity) {
      return;
    }
    const document = await identity.start(() => loadSessionGitHubIssue(target, identity));
    identity.assertSelected();
    assertActive();
    const comments = (document.comments ?? []).slice(0, COMMENT_LIMIT).map((comment) => ({
      author: truncateUtf16Safe(comment.author, 256),
      created_at: comment.createdAt,
      body: truncateUtf16Safe(comment.body, COMMENT_CHARS),
      body_truncated: comment.body.length > COMMENT_CHARS || undefined,
    }));
    params.templateContext.ChannelStructuredContext = [
      ...(params.templateContext.ChannelStructuredContext ?? []),
      {
        label: "GitHub issue context (untrusted external content)",
        source: "github",
        type: "github_issue",
        payload: {
          url: target.url,
          repository: `${target.owner}/${target.repo}`,
          number: target.number,
          title: truncateUtf16Safe(document.title, 512),
          state: document.state,
          author: document.author,
          created_at: document.createdAt,
          updated_at: document.updatedAt,
          body: truncateUtf16Safe(document.body, BODY_CHARS),
          body_truncated: document.body.length > BODY_CHARS || undefined,
          comments,
          comments_total: document.commentsTotal,
          comments_truncated: document.commentsTotal > comments.length || undefined,
        },
      },
    ];
  } finally {
    sessionFacts?.release();
  }
}
