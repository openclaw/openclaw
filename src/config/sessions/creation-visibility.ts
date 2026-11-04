import {
  parseAgentSessionKey,
  parseSessionDeliveryRoute,
} from "../../sessions/session-key-utils.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import type { SessionEntry } from "./types.js";

/** Creation-only policy. Mutable display/origin fields never authorize automatic sharing. */
export function resolveSessionCreationVisibility(
  cfg: OpenClawConfig,
  sessionKey: string,
  parent?: Pick<SessionEntry, "access" | "visibility">,
): Pick<SessionEntry, "visibility" | "access"> {
  const access = cfg.session?.sharing?.accessPolicy
    ? { mode: "source" as const }
    : parent?.visibility === "draft" || (parent?.access && parent.access.mode !== "unrestricted")
      ? { mode: "creator" as const }
      : undefined;
  const defaults = cfg.session?.sharing?.creationDefaults;
  if (!defaults) {
    return access ? { access } : {};
  }
  const agent = parseAgentSessionKey(sessionKey);
  const route = parseSessionDeliveryRoute(sessionKey);
  // Only an exact, explicitly approved group route may escape the private default.
  // Unknown keys (including web chats and child sessions) fail closed. A thread
  // suffix uses its group's route; opaque topic IDs still require an exact peerId.
  const approved =
    agent &&
    route &&
    (route.peerKind === "group" || route.peerKind === "channel") &&
    defaults.sharedGroups?.some(
      (group) =>
        group.agentId === agent.agentId &&
        group.channel === route.channel &&
        (group.chatType ?? "group") === route.peerKind &&
        group.accountId === route.accountId &&
        group.peerId === route.peerId,
    );
  return { visibility: approved ? "shared" : defaults.visibility, ...(access ? { access } : {}) };
}
