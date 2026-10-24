import { buildControlUiSessionPath } from "../../packages/session-url-contract/src/index.js";
import { parseControlUiSessionPath } from "../../packages/session-url-contract/src/parse.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type {
  SessionDiscussionInfo,
  SessionDiscussionProvider,
  SessionDiscussionState,
} from "../plugins/session-discussion-registry.js";
export { buildControlUiSessionPath, parseControlUiSessionPath };
export { registerSessionDiscussionProvider } from "../plugins/session-discussion-registry.js";

/** Return a source-relative link only when ordinary current routing preserves this stored address. */
export async function resolveStoredSessionControlUiPath(params: {
  config: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}): Promise<string | undefined> {
  // Link eligibility shares Gateway routing; keep that policy graph out of SDK startup.
  const { resolveSessionStoreIdentity } = await import("../gateway/session-store-key.js");
  const { config: cfg, agentId, sessionKey } = params;
  try {
    const { resolveRequestedSessionAgentId } = await import("../gateway/session-request-agent.js");
    const requested = resolveRequestedSessionAgentId(cfg, sessionKey, agentId);
    if (!requested.ok) {
      return undefined;
    }
    const target = resolveSessionStoreIdentity({ cfg, agentId: requested.agentId, sessionKey });
    if (target.agentId !== agentId || target.canonicalKey !== sessionKey) {
      return undefined;
    }
    const { resolveSessionSubscriptionKey } =
      await import("../gateway/session-subscription-keys.js");
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
    return route?.kind === "literal" && route.agentId === agentId && route.sessionKey === sessionKey
      ? (path ?? undefined)
      : undefined;
  } catch {
    // Unresolvable or retired ownership is an intentional unavailable link, never a guessed home.
    return undefined;
  }
}
