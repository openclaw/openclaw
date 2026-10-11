import { resolveRequestedSessionAgentInput } from "./session-request-agent.js";
import { withSessionSharingTarget } from "./session-sharing-policy.js";
import { captureSessionMutationRouting } from "./session-sharing-preparation.js";
import { prepareSessionSharingProfiles } from "./session-sharing-read.js";
import {
  resolveChatSendAuthorizationParams,
  resolveDirectSessionTargets,
} from "./session-sharing-target-input.js";
import { resolveSessionMutationAuthorization } from "./session-sharing.js";

/** Read participation in the worker while retaining its owner through authorization. */
export async function resolveSessionMutationAuthorizationAsync(
  request: Parameters<typeof resolveSessionMutationAuthorization>[0] & {
    assertInvocationCurrent?: () => void;
  },
) {
  let params = request;
  params.assertInvocationCurrent?.();
  if (params.method === "chat.send") {
    const normalized = resolveChatSendAuthorizationParams(
      params.context.getRuntimeConfig(),
      params.requestParams,
    );
    if (!normalized.ok) {
      return { error: normalized.error };
    }
    params = { ...params, requestParams: normalized.value };
  }
  const targets = resolveDirectSessionTargets(params.method, params.requestParams);
  if (params.method !== "chat.send" || targets.length !== 1) {
    return resolveSessionMutationAuthorization(params);
  }
  const target = targets[0]!;
  const input = resolveRequestedSessionAgentInput(target.sessionKey, target.agentId);
  if (!input.ok) {
    return { error: input.error };
  }
  const cfg = params.context.getRuntimeConfig();
  const assertRoutingCurrent = captureSessionMutationRouting(cfg, undefined, [target]);
  const preparedProfiles = await prepareSessionSharingProfiles(params.client);
  params.assertInvocationCurrent?.();
  return withSessionSharingTarget(
    { cfg, sessionKey: target.sessionKey, agentId: input.value },
    (read) => {
      const selectedSource = read.selection?.source;
      const selection = read.selection &&
        selectedSource && {
          ...read.selection,
          source: {
            ...selectedSource,
            assertCurrent() {
              selectedSource.assertCurrent();
              assertRoutingCurrent(params.context.getRuntimeConfig());
            },
          },
        };
      const assertCurrent = () => {
        params.assertInvocationCurrent?.();
        preparedProfiles.readCurrent();
        read.assertCurrent();
        assertRoutingCurrent(params.context.getRuntimeConfig());
      };
      assertCurrent();
      return resolveSessionMutationAuthorization({
        ...params,
        preparedProfiles,
        preparedSharing: { ...read, selection, assertCurrent },
      });
    },
  );
}
