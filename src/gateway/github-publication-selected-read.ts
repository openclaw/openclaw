import type { SessionGitHubPublicationPublished } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import type { SessionGitHubPullRequestBinding } from "../config/sessions/types.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import {
  matchesCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationIdentity,
} from "./github-publication-availability.js";
import { inspectOwnGitHubPullRequest } from "./github-publication-inspect.js";
import { createGitHubPublicationJsonReader } from "./github-publication-json-read.js";
import type { GitHubPublicationRequesterPolicyV2 } from "./github-publication-requester.js";

/** Read an already selected target under the native requester's lifetime, never adopt a URL. */
export async function prepareSelectedGitHubPullRequestReader(params: {
  session: { agentId: string; sessionKey: string; sessionId: string };
  pullRequest: Pick<SessionGitHubPublicationPublished, "url" | "repository" | "branch">;
  binding?: SessionGitHubPullRequestBinding;
  requester: GitHubPublicationRequesterPolicyV2;
  assertCurrent: () => void;
}) {
  const { session, pullRequest, binding, requester } = params;
  const assertRequester = () => {
    params.assertCurrent();
    requester.assertCurrent();
  };
  const identity = await prepareCurrentGitHubPublicationIdentity(session.agentId, assertRequester);
  const assertCurrent = () => {
    assertRequester();
    if (!matchesCurrentGitHubPublicationIdentity({ agentId: session.agentId, identity })) {
      throw new Error(
        "The GitHub publisher changed; inspect the current identity before retrying.",
      );
    }
  };
  assertCurrent();
  const url = URL.parse(pullRequest.url);
  const host = identity.host ?? "github.com";
  const prefix = "/" + pullRequest.repository + "/pull/";
  const number = url?.pathname.slice(prefix.length);
  if (
    !url ||
    url.protocol !== "https:" ||
    url.host !== host ||
    (binding && binding.host !== host) ||
    url.username ||
    url.password ||
    !url.pathname.startsWith(prefix) ||
    !number ||
    !/^[1-9][0-9]*$/.test(number) ||
    url.search ||
    url.hash
  ) {
    throw new Error("The publication's GitHub target is invalid.");
  }
  const nativeRead = createGitHubPublicationJsonReader({
    host,
    env: identity.env,
    assertCurrent,
    requireSuccess: true,
    unavailable: () =>
      new Error(
        "GitHub PR state is unavailable; check the publisher's repository access and retry inspect.",
      ),
  });
  const fullWrite = roleScopesAllow({
    role: "operator",
    requestedScopes: ["operator.write"],
    allowedScopes: requester.snapshot.scopes,
  });
  let inspection: Awaited<ReturnType<typeof inspectOwnGitHubPullRequest>> | undefined;
  const readJson: typeof nativeRead = async (endpoint, query) => {
    assertCurrent();
    if (binding && !fullWrite) {
      inspection = await inspectOwnGitHubPullRequest({
        pullRequestUrl: binding.url,
        session,
        requester,
        assertCurrent,
      });
    }
    const result = await nativeRead(endpoint, query);
    inspection?.assertCurrent();
    assertCurrent();
    return result;
  };
  return {
    identity,
    assertCurrent,
    readJson,
    get inspection() {
      return inspection;
    },
    endpoint: "repos/" + pullRequest.repository + "/pulls/" + number,
  };
}
