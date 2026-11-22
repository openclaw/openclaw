import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionGitHubActionParams } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { resolveConfiguredGitHubHost } from "../agents/github-host.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
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
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

/** Issue filing uses the registered project, never a checkout remote or a tool-supplied URL. */
export async function createSessionGitHubIssue(
  options: Omit<GatewayRequestHandlerOptions, "params"> & {
    params: Extract<SessionGitHubActionParams, { action: "create_issue" }>;
  },
) {
  const { params } = options;
  const caller = getGatewayToolCallerIdentity();
  if (
    caller &&
    (caller.sessionKey !== params.sessionKey ||
      (params.agentId && normalizeAgentId(params.agentId) !== normalizeAgentId(caller.agentId)))
  ) {
    throw new Error("Issue creation must use the current conversation.");
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
      "File the issue from an active conversation in the intended registered GitHub project. No worktree is needed.",
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
    throw new Error("Filing a GitHub issue requires write access to this conversation.");
  }
  const host = resolveConfiguredGitHubHost(getConfig());
  const unavailable = new Error(
    "This conversation has no registered GitHub repository available to this requester. Nothing was filed.",
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
  // No browser/native fallback and no retry: a lost POST response may hide a created issue.
  const unconfirmed = new Error(
    `GitHub issue creation is unconfirmed. Check https://${host}/${repository}/issues before submitting again.`,
  );
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
          ),
          { fresh: true },
        ))
      ) {
        throw unavailable;
      }
      return await runPublicationCommand(
        [
          ...githubPublicationApiArgs(`repos/${repository}/issues`, "POST", host),
          "--jq",
          "{number, url: .html_url, authorId: .user.id}",
        ],
        {
          env: identity.env,
          input: JSON.stringify({ title: params.title, body: params.body ?? "" }),
          beforeRun: () => {
            current.assertCurrent();
            assertSessionCurrent();
            if (
              resolveConfiguredGitHubHost(getConfig()) !== host ||
              (identity.host ?? "github.com") !== host ||
              !matchesCurrentGitHubPublicationIdentity({ agentId, identity })
            ) {
              throw new Error(
                "The selected GitHub account does not match the project's GitHub host. Nothing was filed.",
              );
            }
            dispatched = true;
          },
        },
      );
    })
    .catch((error: unknown) => {
      throw dispatched ? unconfirmed : error;
    });
  if (result.code !== 0 || result.error) {
    const status = /\(HTTP (4\d{2})\)/u.exec(result.stderr.toString("utf8"))?.[1];
    if (status && status !== "408" && status !== "499") {
      throw new Error(
        `GitHub rejected issue creation (HTTP ${status}). Check that issues are enabled and the selected account can file them.`,
      );
    }
    throw unconfirmed;
  }
  let issue: unknown;
  try {
    issue = JSON.parse(result.stdout.toString("utf8"));
  } catch {
    throw unconfirmed;
  }
  if (
    !isRecord(issue) ||
    !Number.isSafeInteger(issue.number) ||
    typeof issue.number !== "number" ||
    issue.number < 1 ||
    issue.authorId !== identity.account.accountId ||
    typeof issue.url !== "string" ||
    issue.url.toLowerCase() !== `https://${host}/${repository}/issues/${issue.number}`
  ) {
    throw unconfirmed;
  }
  return { status: "created" as const, url: issue.url };
}
