import { intersectSessionPermissionModes } from "../../agents/session-permission-mode.js";
import { intersectSessionToolOverrides } from "../../config/sessions/session-tool-overrides.js";
import type { SessionEventTarget } from "./session-event-contract.js";

/** A delayed producer can retain restrictions, never replace current session authority. */
export function narrowSessionEventSettings(
  retained: SessionEventTarget["settings"],
  current: SessionEventTarget["settings"],
): NonNullable<SessionEventTarget["settings"]> {
  return {
    permissionMode: intersectSessionPermissionModes(
      retained?.permissionMode,
      current?.permissionMode,
    ),
    toolOverrides: intersectSessionToolOverrides(retained?.toolOverrides, current?.toolOverrides),
  };
}

/** Nested callers intersect ceilings; only an unrestricted same-session owner retains the exemption. */
export function inheritSessionEventToolPolicy(
  identity: {
    agentId: string;
    sessionKey: string;
    sessionEventToolsAllow?: readonly string[];
    sessionEventToolsAllowSessionScoped?: true;
  },
  owner?: {
    agentId: string;
    sessionKey: string;
    sessionEventToolsAllow?: readonly string[];
    sessionEventToolsAllowSessionScoped?: true;
  },
) {
  return {
    sessionEventToolsAllow:
      identity.sessionEventToolsAllow && owner?.sessionEventToolsAllow
        ? identity.sessionEventToolsAllow.filter((name) =>
            owner.sessionEventToolsAllow!.includes(name),
          )
        : (identity.sessionEventToolsAllow ?? owner?.sessionEventToolsAllow),
    sessionEventToolsAllowSessionScoped:
      !owner ||
      (owner.agentId === identity.agentId.trim() &&
        owner.sessionKey === identity.sessionKey.trim() &&
        (!owner.sessionEventToolsAllow || owner.sessionEventToolsAllowSessionScoped))
        ? identity.sessionEventToolsAllowSessionScoped
        : undefined,
  };
}
