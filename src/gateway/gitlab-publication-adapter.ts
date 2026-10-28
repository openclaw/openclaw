import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { cancelUnreadResponseBody, readResponseWithLimit } from "../infra/http-body.js";

export type GitLabPublicationTarget = {
  issuer: string;
  projectId: number;
  projectPath: string;
  gitUrl: string;
  webUrl: string;
  baseBranch: string;
};

export type GitLabPublicationIdentity = {
  issuer: string;
  accountId: number;
  login: string;
  name: string;
  commitEmail: string;
};

export type GitLabPublicationCredentials = {
  /** The owner resolves a current token only inside this private effect closure. */
  withToken<T>(run: (token: string) => Promise<T>): Promise<T>;
};

export type GitLabPublicationRequest = {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
};

export function createGitLabPublicationApi(params: {
  target: GitLabPublicationTarget;
  credentials: GitLabPublicationCredentials;
  assertCurrent: () => void;
  fetchImpl?: typeof fetch;
}) {
  const issuer = new URL(params.target.issuer);
  if (
    issuer.protocol !== "https:" ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash
  ) {
    throw new Error("GitLab publication issuer must be an HTTPS origin.");
  }
  const base = new URL("api/v4/", issuer.href.endsWith("/") ? issuer : issuer.href + "/");
  const request = async (input: GitLabPublicationRequest): Promise<unknown> => {
    params.assertCurrent();
    return await params.credentials.withToken(async (token) => {
      params.assertCurrent();
      const url = new URL(input.path, base);
      if (url.origin !== issuer.origin || !url.pathname.startsWith(base.pathname)) {
        throw new Error("GitLab publication API path escaped its issuer.");
      }
      const reply = await (params.fetchImpl ?? fetch)(url, {
        method: input.method,
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(input.body ? { "Content-Type": "application/json" } : {}),
        },
        ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      });
      params.assertCurrent();
      if (!reply.ok) {
        // Response bodies may contain private project details; never copy them into receipts.
        await cancelUnreadResponseBody(reply);
        throw new Error(`GitLab publication API returned HTTP ${reply.status}.`);
      }
      const bytes = await readResponseWithLimit(reply, 4 * 1024 * 1024, { timeoutMs: 60_000 });
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      params.assertCurrent();
      return value;
    });
  };
  return { request };
}

export function assertGitLabPublicationProject(value: unknown, target: GitLabPublicationTarget) {
  const issuer = new URL(target.issuer);
  const gitUrl = new URL(target.gitUrl);
  const webUrl = new URL(target.webUrl);
  if (
    !Number.isSafeInteger(target.projectId) ||
    target.projectId < 1 ||
    !isRecord(value) ||
    value.id !== target.projectId ||
    value.path_with_namespace !== target.projectPath ||
    value.web_url !== target.webUrl ||
    value.http_url_to_repo !== target.gitUrl ||
    typeof value.default_branch !== "string" ||
    !value.default_branch ||
    gitUrl.protocol !== "https:" ||
    gitUrl.origin !== issuer.origin ||
    !gitUrl.pathname.startsWith(
      issuer.pathname.endsWith("/") ? issuer.pathname : issuer.pathname + "/",
    ) ||
    gitUrl.username ||
    gitUrl.password ||
    gitUrl.search ||
    gitUrl.hash ||
    webUrl.protocol !== "https:" ||
    webUrl.origin !== issuer.origin ||
    !webUrl.pathname.startsWith(
      issuer.pathname.endsWith("/") ? issuer.pathname : issuer.pathname + "/",
    ) ||
    webUrl.username ||
    webUrl.password ||
    webUrl.search ||
    webUrl.hash
  ) {
    throw new Error("GitLab publication project identity changed.");
  }
}

export function assertGitLabPublicationActor(value: unknown, identity: GitLabPublicationIdentity) {
  if (
    !isRecord(value) ||
    value.id !== identity.accountId ||
    value.username !== identity.login ||
    value.name !== identity.name ||
    value.commit_email !== identity.commitEmail ||
    !identity.name.trim() ||
    !identity.commitEmail.trim() ||
    /[\r\n<>]/u.test(identity.name + identity.commitEmail)
  ) {
    throw new Error("GitLab publication account identity changed.");
  }
}

export type GitLabMergeRequest = {
  iid: number;
  webUrl: string;
  state: "opened" | "closed" | "merged";
  sourceProjectId: number;
  targetProjectId: number;
  sourceBranch: string;
  targetBranch: string;
  sha: string | null;
  authorId: number;
  description: string;
};

export function parseGitLabMergeRequest(value: unknown): GitLabMergeRequest {
  const sha =
    isRecord(value) && (value.sha === "" || value.sha === null)
      ? null
      : isRecord(value)
        ? value.sha
        : undefined;
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.iid) ||
    Number(value.iid) < 1 ||
    typeof value.web_url !== "string" ||
    !value.web_url ||
    (value.state !== "opened" && value.state !== "closed" && value.state !== "merged") ||
    !Number.isSafeInteger(value.source_project_id) ||
    !Number.isSafeInteger(value.target_project_id) ||
    typeof value.source_branch !== "string" ||
    typeof value.target_branch !== "string" ||
    (sha !== null && (typeof sha !== "string" || !/^[a-f0-9]{40}$/u.test(sha))) ||
    !isRecord(value.author) ||
    !Number.isSafeInteger(value.author.id) ||
    typeof value.description !== "string"
  ) {
    throw new Error("GitLab publication merge request response is invalid.");
  }
  return {
    iid: Number(value.iid),
    webUrl: value.web_url,
    state: value.state,
    sourceProjectId: Number(value.source_project_id),
    targetProjectId: Number(value.target_project_id),
    sourceBranch: value.source_branch,
    targetBranch: value.target_branch,
    sha,
    authorId: Number(value.author.id),
    description: value.description,
  };
}
