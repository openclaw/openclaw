import type { SessionGitHubActionParams } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { prepareGitHubPublicationSession } from "./github-publication-availability.js";
import { prepareOwnGitHubPullRequestReader } from "./github-publication-inspect-reader.js";
import { prepareGitHubPublicationRequesterV2 } from "./github-publication-requester.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { readWorkspacePublicationHost } from "./workspace-publication-binding.js";
export async function performSessionGitHubInspection(
  options: Omit<GatewayRequestHandlerOptions, "params"> & {
    params: Extract<SessionGitHubActionParams, { action: "inspect_pr" }>;
  },
): Promise<void> {
  const { params } = options;
  const service = readWorkspacePublicationHost(options.context)?.readApi();
  if (!service) {
    throw new Error("Repository publication service is unavailable.");
  }
  const assertService = () => {
    if (readWorkspacePublicationHost(options.context)?.readApi() !== service) {
      throw new Error("Repository publication service is unavailable.");
    }
  };
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
  const inspected = await service.inspectPullRequest({
    pullRequestUrl: params.pullRequestUrl,
    agentId: session.agentId,
    reader: await prepareOwnGitHubPullRequestReader(admitted.requester, {
      ...session,
      sessionId: loaded.entry.sessionId,
    }),
    assertCurrent: () => {
      assertService();
      selected.readCurrent();
    },
  });
  inspected.assertCurrent();
  options.respond(true, inspected.result);
}
