import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { resolveRequestedSessionAgentInput } from "./session-request-agent.js";
import { withSessionSharingTarget } from "./session-sharing-policy.js";
import { captureSessionMutationRouting } from "./session-sharing-preparation.js";
import { prepareSessionSharingProfiles } from "./session-sharing-read.js";
import {
  resolveChatSendAuthorizationParams,
  resolveDirectSessionTargets,
  resolveTalkSessionTargetInput,
} from "./session-sharing-target-input.js";
import { resolveSessionMutationAuthorization } from "./session-sharing.js";
import { prepareTalkSessionTarget } from "./talk/session-target.js";

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
  const talk = resolveTalkSessionTargetInput(
    params.method,
    params.requestParams,
    params.client?.connId,
  );
  if (talk && !params.preparedTalkSessionTarget) {
    try {
      params = {
        ...params,
        preparedTalkSessionTarget:
          talk.kind === "relay"
            ? talk.target
            : await prepareTalkSessionTarget(params.context.getRuntimeConfig(), talk.sessionKey),
      };
    } catch (error) {
      return {
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          String(error instanceof Error ? error.message : error),
        ),
      };
    }
    params.assertInvocationCurrent?.();
  }
  const targets = params.preparedTalkSessionTarget
    ? [
        {
          sessionKey: params.preparedTalkSessionTarget.canonicalKey,
          agentId: params.preparedTalkSessionTarget.agentId,
        },
      ]
    : resolveDirectSessionTargets(params.method, params.requestParams);
  if (targets.length !== 1) {
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
