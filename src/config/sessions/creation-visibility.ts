import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import type { SessionEntry } from "./types.js";

/** Creation-only ACL; collaboration visibility remains with its existing owners. */
export function resolveSessionCreationVisibility(
  cfg: OpenClawConfig,
  sessionKey: string,
  parent?: Pick<SessionEntry, "access" | "visibility">,
  options?: { attendedProfileOperator?: boolean },
): Pick<SessionEntry, "visibility" | "access"> {
  const access = cfg.session?.sharing?.accessPolicy
    ? { mode: "source" as const }
    : parent?.visibility === "draft" || (parent?.access && parent.access.mode !== "unrestricted")
      ? { mode: "creator" as const }
      : cfg.session?.sharing?.controlUiDefaultAccess === "creator" &&
          options?.attendedProfileOperator === true &&
          parseAgentSessionKey(sessionKey)?.rest.startsWith("dashboard:")
        ? { mode: "creator" as const }
        : undefined;
  return access ? { access } : {};
}
