import { buildControlUiSessionPath } from "../../packages/session-url-contract/src/index.js";
import { parseControlUiSessionPath } from "../../packages/session-url-contract/src/parse.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";

export type {
  SessionDiscussionInfo,
  SessionDiscussionProvider,
  SessionDiscussionState,
} from "../plugins/session-discussion-registry.js";
export { buildControlUiSessionPath, parseControlUiSessionPath };
export { registerSessionDiscussionProvider } from "../plugins/session-discussion-registry.js";

/** Return a source-relative link only when ordinary current routing preserves this stored address. */
export async function prepareStoredSessionControlUiPathResolver() {
  const { resolveSessionStoreIdentity } = await import("../gateway/session-store-key.js");
  const { resolveRequestedSessionAgentId } = await import("../gateway/session-request-agent.js");
  const { resolveSessionSubscriptionKey } = await import("../gateway/session-subscription-keys.js");
  return (params: {
    config: ReturnType<PluginRuntime["config"]["current"]>;
    agentId: string;
    sessionKey: string;
  }): string | undefined => {
    // Link eligibility shares Gateway routing; keep that policy graph out of SDK startup.
    const { agentId, sessionKey } = params;
    // SAFETY: plugins hold the readonly runtime snapshot; the routing resolvers below only read it.
    const cfg = params.config as OpenClawConfig;
    try {
      const requested = resolveRequestedSessionAgentId(cfg, sessionKey, agentId, "read");
      if (!requested.ok) {
        return undefined;
      }
      const target = resolveSessionStoreIdentity({ cfg, agentId: requested.agentId, sessionKey });
      if (target.agentId !== agentId || target.canonicalKey !== sessionKey) {
        return undefined;
      }
      // The legacy raw-global stream shares this qualified address even when both stored rows exist.
      if (sessionKey === resolveSessionSubscriptionKey("global", agentId)) {
        return undefined;
      }
      const path = buildControlUiSessionPath({
        namespace: "chat",
        sessionKey,
        mainKey: cfg.session?.mainKey,
        exactKey: true,
      });
      const route = path ? parseControlUiSessionPath(path, "", cfg.session?.mainKey) : null;
      return route?.kind === "literal" &&
        route.agentId === agentId &&
        route.sessionKey === sessionKey
        ? (path ?? undefined)
        : undefined;
    } catch {
      // Unresolvable or retired ownership is an intentional unavailable link, never a guessed home.
      return undefined;
    }
  };
}
