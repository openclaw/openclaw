import type { SessionsPatchParams } from "../../packages/gateway-protocol/src/index.js";
import { prepareAuthProfileProvider } from "../agents/auth-profiles/store-runtime.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";

/** A model choice without `@profile` keeps a compatible pin, so resolve its provider first. */
export async function preparePinnedAccount(
  params: { patch: SessionsPatchParams; existingEntry?: SessionEntry },
  agentDir: string,
) {
  const pinnedProfile =
    "model" in params.patch && params.existingEntry?.authProfileOverride?.trim();
  return pinnedProfile && !splitTrailingAuthProfile(params.patch.model ?? "").profile
    ? await prepareAuthProfileProvider({ agentDir, profileId: pinnedProfile })
    : undefined;
}

/** Return the session to automatic account order without changing its model. */
export function clearPatchedAccount(next: SessionEntry, patch: SessionsPatchParams) {
  if (patch.authProfile !== null || !next.authProfileOverride) {
    return;
  }
  delete next.authProfileOverride;
  delete next.authProfileOverrideSource;
  delete next.authProfileOverrideCompactionCount;
  delete next.fallbackNotice;
  next.liveModelSwitchPending = true;
}
