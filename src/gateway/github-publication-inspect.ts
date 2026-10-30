import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import {
  GITHUB_PULL_REQUEST_LOGIN_PATTERN,
  type SessionGitHubActionParams,
  type SessionGitHubPullRequestInspectResult,
} from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import {
  resolveConfiguredGitHubHost,
  resolveConfiguredGitHubApiBaseUrl,
} from "../agents/github-host.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  currentGitHubPublicationConfig,
  matchesCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationIdentity,
  prepareGitHubPublicationSession,
} from "./github-publication-availability.js";
import {
  githubPublicationApiArgs,
  runPublicationCommand,
} from "./github-publication-git-transport.js";
import { captureOwnGitHubPullRequestReader } from "./github-publication-inspect-reader.js";
import {
  prepareGitHubPublicationRequesterV2,
  type GitHubPublicationRequesterPolicyV2,
} from "./github-publication-requester.js";
import type { PublicationSessionIdentity } from "./github-publication-session.types.js";
import { readSharedGitHubPublication } from "./github-publication-shared-read.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

type Inspection = SessionGitHubPullRequestInspectResult;
const unavailable = () =>
  new Error(
    "The PR could not be verified as yours with current repository access. Check its URL and your linked GitHub account.",
  );
const commitPattern = /^[a-f0-9]{40}$/u;
const loginPattern = new RegExp(GITHUB_PULL_REQUEST_LOGIN_PATTERN, "u");

function isGitHubLogin(value: string): boolean {
  return loginPattern.test(value);
}

function isRepositoryName(value: string): boolean {
  const [owner, name, extra] = value.split("/");
  return (
    owner !== undefined &&
    isGitHubLogin(owner) &&
    name !== undefined &&
    /^[A-Za-z0-9._-]{1,100}$/u.test(name) &&
    name !== "." &&
    name !== ".." &&
    !/\.(?:git|atom)$/iu.test(name) &&
    extra === undefined
  );
}

function parsePullRequestUrl(value: string, host: string) {
  const url = URL.parse(value);
  const match =
    url &&
    /^\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)(?:\/(?:changes|files|checks|commits(?:\/[a-f0-9]{40})?))?\/?$/u.exec(
      url.pathname,
    );
  let repository: string | undefined;
  try {
    repository = match ? decodeURIComponent(match[1]!) : undefined;
  } catch {
    repository = undefined;
  }
  const number = Number(match?.[2]);
  if (
    !url ||
    url.protocol !== "https:" ||
    url.host !== host ||
    url.username ||
    url.password ||
    !repository ||
    !isRepositoryName(repository) ||
    !Number.isSafeInteger(number) ||
    number < 1
  ) {
    throw new Error(`Supply a pull request URL on the configured GitHub host (${host}).`);
  }
  return { repository, number };
}

function repositoryFacts(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    value.id < 1 ||
    typeof value.full_name !== "string" ||
    !isRepositoryName(value.full_name) ||
    typeof value.private !== "boolean"
  ) {
    throw unavailable();
  }
  return {
    id: value.id,
    name: value.full_name,
    private: value.private,
  };
}

function refFacts(
  value: unknown,
  repository: ReturnType<typeof repositoryFacts>,
): Inspection["base"] {
  if (
    !isRecord(value) ||
    typeof value.ref !== "string" ||
    !value.ref ||
    value.ref.length > 256 ||
    containsAsciiControlCharacter(value.ref) ||
    value.ref.includes(" ") ||
    typeof value.sha !== "string" ||
    !commitPattern.test(value.sha) ||
    !isRecord(value.repo) ||
    value.repo.id !== repository.id ||
    value.repo.full_name !== repository.name
  ) {
    throw unavailable();
  }
  return {
    repository: repository.name,
    repositoryId: repository.id,
    branch: value.ref,
    commit: value.sha,
  };
}

/** Read-only observation. Callers must retain admission and revalidate before using or disclosing it. */
export async function inspectOwnGitHubPullRequest(params: {
  pullRequestUrl: string;
  session: PublicationSessionIdentity;
  requester: GitHubPublicationRequesterPolicyV2;
  assertCurrent: () => void;
}): Promise<{ result: Inspection; assertCurrent: () => void; publishedHeadCommit?: string }> {
  params.assertCurrent();
  params.requester.assertCurrent();
  const actor = params.requester.snapshot.actor;
  if (actor.kind !== "operator") {
    throw new Error("Inspecting your PR requires your verified linked GitHub account.");
  }
  // This conversation's own publication makes its publisher the PR's accepted author.
  const published = await readSharedGitHubPublication(params.session, { status: "published" });
  params.assertCurrent();
  const inspected = await readOwnGitHubPullRequest({
    pullRequestUrl: params.pullRequestUrl,
    agentId: params.session.agentId,
    reader: captureOwnGitHubPullRequestReader(actor.profileId, () =>
      resolveConfiguredGitHubHost(currentGitHubPublicationConfig()),
    ),
    publication:
      published?.pull_request_url && published.identity_account_id !== null
        ? { url: published.pull_request_url, accountId: published.identity_account_id }
        : undefined,
    assertCurrent: () => {
      params.assertCurrent();
      params.requester.assertCurrent();
    },
  });
  return {
    result: inspected.result,
    assertCurrent: inspected.assertCurrent,
    ...(inspected.ownPublication && published?.head_commit
      ? { publishedHeadCommit: published.head_commit }
      : {}),
  };
}

/** The same own-PR inspection serves admitted read-only consumers without publication grants. */
export async function readOwnGitHubPullRequest(params: {
  pullRequestUrl: string;
  agentId: string;
  reader: ReturnType<typeof captureOwnGitHubPullRequestReader>;
  /** The PR this conversation published, with the publisher account that authored it. */
  publication?: { url: string; accountId: number };
  assertCurrent: () => void;
}) {
  const { host, accountIds: admittedIds } = params.reader;
  const target = parsePullRequestUrl(params.pullRequestUrl, host);
  const assertRequester = () => {
    params.assertCurrent();
    params.reader.assertCurrent();
  };
  const identity = await prepareCurrentGitHubPublicationIdentity(params.agentId, assertRequester);
  const config = currentGitHubPublicationConfig();
  const apiBaseUrl = resolveConfiguredGitHubApiBaseUrl(config);
  const hasReadEndpoint =
    host === "github.com" || Boolean(config.gateway?.github?.apiBaseUrl?.trim());
  const assertIdentityCurrent = () => {
    params.reader.assertCurrent();
    if (
      (identity.host ?? "github.com") !== host ||
      resolveConfiguredGitHubApiBaseUrl(currentGitHubPublicationConfig()) !== apiBaseUrl ||
      !matchesCurrentGitHubPublicationIdentity({ agentId: params.agentId, identity })
    ) {
      throw new Error("The GitHub publisher changed; retry inspection.");
    }
  };
  const assertCurrent = () => {
    assertRequester();
    assertIdentityCurrent();
  };
  assertCurrent();
  const read = async (endpoint: string): Promise<unknown> => {
    assertCurrent();
    const response = await runPublicationCommand(githubPublicationApiArgs(endpoint, "GET", host), {
      env: identity.env,
      beforeRun: assertCurrent,
    }).catch(() => {
      assertCurrent();
      throw unavailable();
    });
    assertCurrent();
    if (response.code !== 0) {
      return undefined;
    }
    try {
      return JSON.parse(response.stdout.toString("utf8"));
    } catch {
      throw unavailable();
    }
  };
  const hasAccess = async (repository: string, accountId: number, login: string) => {
    const permission = await read(
      `repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`,
    );
    return (
      isRecord(permission) &&
      isRecord(permission.user) &&
      permission.user.id === accountId &&
      ["read", "triage", "write", "maintain", "admin"].includes(String(permission.permission))
    );
  };
  const baseRepository = repositoryFacts(await read(`repos/${target.repository}`));
  // Shared reader access alone must never disclose a private PR's existence or author.
  const privateReaders = new Set<number>();
  if (baseRepository.private) {
    for (const accountId of admittedIds) {
      const user = await read(`user/${accountId}`);
      const login =
        isRecord(user) && typeof user.login === "string" && isGitHubLogin(user.login)
          ? user.login
          : undefined;
      if (
        isRecord(user) &&
        user.id === accountId &&
        login &&
        (await hasAccess(baseRepository.name, accountId, login))
      ) {
        privateReaders.add(accountId);
      }
    }
    if (!privateReaders.size) {
      throw unavailable();
    }
  }
  const pr = await read(`repos/${baseRepository.name}/pulls/${target.number}`);
  const { publication } = params;
  const ownPublication =
    publication !== undefined &&
    isRecord(pr) &&
    isRecord(pr.user) &&
    publication.url === pr.html_url &&
    publication.accountId === pr.user.id;
  if (
    !isRecord(pr) ||
    !isRecord(pr.user) ||
    typeof pr.user.id !== "number" ||
    (baseRepository.private && !privateReaders.has(pr.user.id) && !ownPublication) ||
    typeof pr.user.login !== "string" ||
    !isGitHubLogin(pr.user.login) ||
    pr.number !== target.number ||
    pr.html_url !== `https://${host}/${baseRepository.name}/pull/${target.number}` ||
    (pr.state !== "open" && pr.state !== "closed") ||
    typeof pr.draft !== "boolean" ||
    typeof pr.merged !== "boolean" ||
    !isRecord(pr.head)
  ) {
    throw unavailable();
  }
  if (!admittedIds.includes(pr.user.id) && !ownPublication) {
    throw new Error(
      "This PR is not authored by a GitHub account linked to you. inspect_pr checks your PR authorship, not the managed publisher's credentials. For a new PR, use publish. A bot-authored PR from another session cannot be imported with inspect_pr or prepare_pr; continue it in the session that published it.",
    );
  }
  const base = refFacts(pr.base, baseRepository);
  let headRepository: ReturnType<typeof repositoryFacts> | undefined;
  if (pr.head.repo !== null) {
    const candidate = repositoryFacts(pr.head.repo);
    headRepository =
      candidate.id === baseRepository.id
        ? baseRepository
        : repositoryFacts(await read(`repos/${candidate.name}`));
    if (
      headRepository.id !== candidate.id ||
      headRepository.name !== candidate.name ||
      (headRepository.private &&
        headRepository.id !== baseRepository.id &&
        !(await hasAccess(headRepository.name, pr.user.id, pr.user.login)))
    ) {
      throw unavailable();
    }
  }
  const head = headRepository ? refFacts(pr.head, headRepository) : null;
  const result: Inspection = {
    url: pr.html_url,
    host,
    number: target.number,
    author: { accountId: pr.user.id, login: pr.user.login },
    state: pr.merged ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "open",
    base,
    head,
  };
  assertCurrent();
  return {
    result,
    ownPublication,
    assertCurrent,
    assertIdentityCurrent,
    details: pr,
    // Enterprise credentials must not inherit the public API's default destination.
    credential:
      identity.env.GH_TOKEN && hasReadEndpoint
        ? { token: identity.env.GH_TOKEN, apiBaseUrl, assertCurrent: assertIdentityCurrent }
        : undefined,
  };
}

export async function performSessionGitHubInspection(
  options: Omit<GatewayRequestHandlerOptions, "params"> & {
    params: Extract<SessionGitHubActionParams, { action: "inspect_pr" }>;
  },
): Promise<void> {
  const { params } = options;
  const caller = getGatewayToolCallerIdentity();
  if (
    caller &&
    (params.sessionKey !== caller.sessionKey ||
      (params.agentId && normalizeAgentId(params.agentId) !== normalizeAgentId(caller.agentId)))
  ) {
    throw new Error("GitHub inspection must use the current conversation.");
  }
  using selected = await prepareGitHubPublicationSession(params.sessionKey, {
    agentId: caller?.agentId ?? params.agentId,
    assertCurrent: () => options.sessionMutationAuthorization?.assertCurrent(),
  });
  const loaded = selected.readCurrent();
  if (!loaded.entry?.sessionId) {
    throw new Error("The GitHub inspection session is unavailable.");
  }
  const session = { agentId: loaded.agentId, sessionKey: loaded.canonicalKey };
  const admitted = await prepareGitHubPublicationRequesterV2(options, session);
  using _ = { [Symbol.dispose]: admitted.release };
  const inspected = await inspectOwnGitHubPullRequest({
    pullRequestUrl: params.pullRequestUrl,
    session: { ...session, sessionId: loaded.entry.sessionId },
    requester: admitted.requester,
    assertCurrent: () => {
      selected.readCurrent();
    },
  });
  inspected.assertCurrent();
  options.respond(true, inspected.result);
}
