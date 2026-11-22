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
import { decodeGitHubPublicationRequester } from "../state/github-publication-requester.js";
import { readGitHubPublicationSessionLifecycleInWorker } from "../state/github-publication-session-lifecycles.js";
import {
  currentGitHubPublicationConfig,
  matchesCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationIdentity,
  prepareGitHubPublicationSession,
} from "./github-publication-availability.js";
import { findGitHubPullRequestContributor } from "./github-publication-contributors.js";
import { captureOwnGitHubPullRequestReader } from "./github-publication-inspect-reader.js";
import { createGitHubPublicationJsonReader } from "./github-publication-json-read.js";
import { matchesGitHubPublicationIdentityRow } from "./github-publication-receipt.js";
import {
  captureGitHubPublicationActionAuthority,
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
}): Promise<{
  result: Inspection;
  details: Awaited<ReturnType<typeof readOwnGitHubPullRequest>>["details"];
  assertCurrent: () => void;
  ownPublication: boolean;
  publishedHeadCommit?: string;
  requirePublicRepositories: boolean;
}> {
  const authority = captureGitHubPublicationActionAuthority(params.requester);
  const assertRequester = () => {
    params.assertCurrent();
    authority.assertCurrent();
  };
  assertRequester();
  const actor = params.requester.snapshot.actor;
  if (!authority.operatorWrite && actor.kind !== "operator") {
    throw new Error("Inspecting your PR requires your verified linked GitHub account.");
  }
  // Updating an imported PR must not create guest author eligibility.
  const published = await readSharedGitHubPublication(params.session, {
    status: "published",
    authorEligibilityOnly: true,
  });
  assertRequester();
  const inspected = await readOwnGitHubPullRequest({
    pullRequestUrl: params.pullRequestUrl,
    agentId: params.session.agentId,
    reader: captureOwnGitHubPullRequestReader(
      actor.kind === "operator" ? actor.profileId : undefined,
      () => resolveConfiguredGitHubHost(currentGitHubPublicationConfig()),
      published?.pull_request_url && published.identity_account_id !== null
        ? {
            url: published.pull_request_url,
            publisher: {
              agent_id: published.agent_id,
              identity_source: published.identity_source,
              identity_profile_id: published.identity_profile_id,
              identity_account_id: published.identity_account_id,
              identity_login: published.identity_login,
            },
          }
        : undefined,
      authority.operatorWrite ? authority.assertOperatorWrite : undefined,
    ),
    assertCurrent: assertRequester,
    requireAuthorship: Boolean(params.requester.snapshot.participation),
    verifyPublication: params.requester.snapshot.participation
      ? async (body, url) => {
          // The creation marker identifies the original receipt; later updates cannot lend ownership.
          for (const match of body.matchAll(/<!-- openclaw-publication:([a-f0-9-]{36}) -->/gu)) {
            const created = await readSharedGitHubPublication(params.session, {
              requestId: match[1]!,
            });
            assertRequester();
            if (created?.status !== "published" || created.pull_request_url !== url) {
              continue;
            }
            const original = decodeGitHubPublicationRequester(
              "requester_authority_json" in created
                ? created.requester_authority_json
                : (
                    await readGitHubPublicationSessionLifecycleInWorker({
                      publicationKind: "shared",
                      requestId: created.request_id,
                    })
                  )?.requester_authority_json,
            );
            assertRequester();
            return (
              original?.actor.kind === "operator" &&
              actor.kind === "operator" &&
              original.actor.profileId === actor.profileId
            );
          }
          return false;
        }
      : undefined,
  });
  return {
    result: inspected.result,
    details: inspected.details,
    assertCurrent: inspected.assertCurrent,
    ownPublication: inspected.ownPublication,
    requirePublicRepositories: inspected.requirePublicRepositories,
    ...(inspected.ownPublication && published?.head_commit
      ? { publishedHeadCommit: published.head_commit }
      : {}),
  };
}

/** Execution authorizes reuse before observing another request's PR as this request's result. */
export async function assertParticipantPullRequestReuse(
  requester: GitHubPublicationRequesterPolicyV2 | undefined,
  pullRequestUrl: string,
  assertCurrent: () => void,
) {
  if (requester?.snapshot.participation) {
    await inspectOwnGitHubPullRequest({
      pullRequestUrl,
      session: requester.snapshot.participation.target,
      requester,
      assertCurrent,
    });
  }
}

/** Read-only consumers retain linked ownership unless the action owner supplies full-write authority. */
export async function readOwnGitHubPullRequest(params: {
  pullRequestUrl: string;
  agentId: string;
  reader: ReturnType<typeof captureOwnGitHubPullRequestReader>;
  assertCurrent: () => void;
  requireAuthorship?: boolean;
  verifyPublication?: (body: string, url: string) => Promise<boolean>;
}) {
  const { host, accountIds: admittedIds, publication, operatorWrite } = params.reader;
  const target = parsePullRequestUrl(params.pullRequestUrl, host);
  const publicContinuation = !operatorWrite && admittedIds.length === 0;
  if (
    publicContinuation &&
    publication?.url !== `https://${host}/${target.repository}/pull/${target.number}`
  ) {
    throw unavailable();
  }
  const assertRequester = () => {
    params.assertCurrent();
    params.reader.assertCurrent();
  };
  const identity = await prepareCurrentGitHubPublicationIdentity(params.agentId, assertRequester);
  const config = currentGitHubPublicationConfig();
  const apiBaseUrl = resolveConfiguredGitHubApiBaseUrl(config);
  const hasReadEndpoint =
    host === "github.com" || Boolean(config.gateway?.github?.apiBaseUrl?.trim());
  let checkedConfig = config;
  const assertIdentityCurrent = () => {
    params.reader.assertCurrent();
    // Retained readers outlive config/secrets reloads; only an API base change revokes them.
    const currentConfig = currentGitHubPublicationConfig();
    if (
      (identity.host ?? "github.com") !== host ||
      (currentConfig !== checkedConfig &&
        resolveConfiguredGitHubApiBaseUrl(currentConfig) !== apiBaseUrl) ||
      !matchesCurrentGitHubPublicationIdentity({ agentId: params.agentId, identity }) ||
      (publicContinuation &&
        (!publication || !matchesGitHubPublicationIdentityRow(publication.publisher, identity)))
    ) {
      throw new Error("The GitHub publisher changed; retry inspection.");
    }
    checkedConfig = currentConfig;
  };
  const assertCurrent = () => {
    params.assertCurrent();
    assertIdentityCurrent();
  };
  assertCurrent();
  const read = createGitHubPublicationJsonReader({
    host,
    env: identity.env,
    assertCurrent,
    unavailable,
    requireSuccess: false,
  });
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
  const hasAccountAccess = async (repository: string, accountId: number) => {
    const user = await read(`user/${accountId}`);
    return (
      isRecord(user) &&
      user.id === accountId &&
      typeof user.login === "string" &&
      isGitHubLogin(user.login) &&
      (await hasAccess(repository, accountId, user.login))
    );
  };
  const baseRepository = repositoryFacts(await read(`repos/${target.repository}`));
  // Shared reader access alone must never disclose a private PR's existence or author.
  const privateReaders = new Set<number>();
  if (baseRepository.private && !operatorWrite) {
    for (const accountId of admittedIds) {
      if (await hasAccountAccess(baseRepository.name, accountId)) {
        privateReaders.add(accountId);
      }
    }
    if (!privateReaders.size) {
      throw unavailable();
    }
  }
  const pr = await read(`repos/${baseRepository.name}/pulls/${target.number}`);
  const ownPublication =
    publication !== undefined &&
    isRecord(pr) &&
    isRecord(pr.user) &&
    publication.url === pr.html_url &&
    publication.publisher.identity_account_id === pr.user.id &&
    (!params.verifyPublication ||
      (typeof pr.body === "string" && (await params.verifyPublication(pr.body, publication.url))));
  if (
    !isRecord(pr) ||
    !isRecord(pr.user) ||
    typeof pr.user.id !== "number" ||
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
  const needsContribution = !operatorWrite && !admittedIds.includes(pr.user.id) && !ownPublication;
  if (needsContribution && params.requireAuthorship) {
    throw new Error(
      "This PR is not authored by a GitHub account linked to you or your original shared publication.",
    );
  }
  const contributorAccountId =
    needsContribution &&
    pr.user.id === identity.account.accountId &&
    typeof pr.head.sha === "string" &&
    commitPattern.test(pr.head.sha)
      ? await findGitHubPullRequestContributor({
          read,
          repository: baseRepository.name,
          number: target.number,
          headCommit: pr.head.sha,
          accountIds: baseRepository.private ? [...privateReaders] : admittedIds,
        })
      : undefined;
  if (
    baseRepository.private &&
    !operatorWrite &&
    !privateReaders.has(pr.user.id) &&
    !ownPublication &&
    contributorAccountId === undefined
  ) {
    throw unavailable();
  }
  if (needsContribution && contributorAccountId === undefined) {
    throw new Error(
      "This PR is not authored by a GitHub account linked to you, and no linked account was verified as a contributor to this publisher's PR. Continue in the original publication conversation or ask a full-write maintainer to assist.",
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
      (publicContinuation && headRepository.private) ||
      (headRepository.private &&
        !operatorWrite &&
        headRepository.id !== baseRepository.id &&
        !(contributorAccountId !== undefined
          ? await hasAccountAccess(headRepository.name, contributorAccountId)
          : await hasAccess(headRepository.name, pr.user.id, pr.user.login)))
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
    requirePublicRepositories: publicContinuation,
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
