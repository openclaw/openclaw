import {
  parseAgentSessionKey,
  parseThreadSessionSuffix,
} from "../../sessions/session-key-utils.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import type { SessionEntry } from "./types.js";

export type SessionAccessEntry = Pick<SessionEntry, "access" | "createdActor">;

/** Only canonical route identifiers authorize; presentation origin and members do not. */
export function resolveSessionAccess(
  cfg: OpenClawConfig | undefined,
  sessionKey: string | undefined,
  entry: Pick<SessionEntry, "access">,
): SessionEntry["access"] {
  if (entry.access && entry.access.mode !== "source") {
    return entry.access;
  }
  const policy = cfg?.session?.sharing?.accessPolicy;
  if (!policy && entry.access?.mode !== "source") {
    return undefined;
  }
  const thread = parseThreadSessionSuffix(sessionKey);
  const parsed = parseAgentSessionKey(thread.baseSessionKey ?? sessionKey);
  let audience: string[] | undefined;
  if (parsed) {
    for (const group of policy?.groups ?? []) {
      if (
        parsed.agentId !== group.agentId ||
        (group.channel === "telegram" &&
          thread.baseSessionKey !== sessionKey &&
          (!thread.threadId || !/^\d+$/.test(thread.threadId)))
      ) {
        continue;
      }
      const prefix =
        [group.channel, group.accountId, group.chatType ?? "group"]
          .filter((part) => part !== undefined)
          .join(":") + ":";
      if (!parsed.rest.startsWith(prefix)) {
        continue;
      }
      const peer = parsed.rest.slice(prefix.length);
      if (
        [group.peerId, ...(group.peerAliases ?? [])].some(
          (id) =>
            peer === id ||
            (group.channel === "telegram" &&
              peer.startsWith(id + ":topic:") &&
              /^\d+$/.test(peer.slice(id.length + 7))),
        )
      ) {
        if (audience) {
          return { mode: "creator" };
        }
        audience = group.profileIds;
      }
    }
  }
  if (audience) {
    return { mode: "audience", profileIds: audience };
  }
  // Removing configuration cannot turn a persisted source binding into an open conversation.
  return { mode: "creator" };
}

/** Reuse the creator predicate so canonical profile aliases share the same authority. */
export function canReadSessionAccess(
  cfg: OpenClawConfig | undefined,
  sessionKey: string | undefined,
  entry: SessionAccessEntry,
  profileMatches: (actor: SessionEntry["createdActor"]) => boolean,
): boolean {
  if (profileMatches(entry.createdActor)) {
    return true;
  }
  const access = resolveSessionAccess(cfg, sessionKey, entry);
  return (
    !access ||
    access.mode === "unrestricted" ||
    (access.mode === "audience" &&
      access.profileIds.some((id) => profileMatches({ type: "human", source: "profile", id })))
  );
}
