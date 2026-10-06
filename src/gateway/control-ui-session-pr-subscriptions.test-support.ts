import { parseAgentSessionKey } from "../routing/session-key.js";
import { createControlUiSessionPullRequestSubscriptions } from "./control-ui-session-pr-subscriptions.js";

type SubscriptionDeps = Parameters<typeof createControlUiSessionPullRequestSubscriptions>[0];

/** Resource-owner fixtures supply a stable visible target; access fixtures use the real reader. */
export function createTestControlUiSessionPrSubscriptions(
  deps: Omit<SubscriptionDeps, "prepareRead"> & Partial<Pick<SubscriptionDeps, "prepareRead">>,
) {
  return createControlUiSessionPullRequestSubscriptions({
    prepareRead: async (_connId, session) => {
      const parsed = parseAgentSessionKey(session.sessionKey);
      const target = {
        params: {
          sessionKey: session.sessionKey,
          agentId: session.agentId ?? parsed?.agentId ?? "main",
        },
        identity: JSON.stringify(session),
        readSource: { agentId: session.agentId ?? parsed?.agentId ?? "main", path: "unused" },
        source: null,
      };
      return async () => target;
    },
    ...deps,
  });
}
