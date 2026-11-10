import { GIT_COAUTHOR_IDENTITY_PREFERENCE_KEY } from "../../../packages/gateway-protocol/src/schema/git-coauthor-identity.js";
import { GIT_COAUTHOR_PREFERENCE_KEY } from "../../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { readResidentUserProfileId } from "../../state/user-profile-list.js";
import type { GatewayRequestContext } from "./types.js";

export function publishUserPreferencesChanged(
  context: GatewayRequestContext,
  profileId: string,
  keys: string[],
): void {
  if (!keys.length || !context.getClientConnIds) {
    return;
  }
  const canonicalProfileId = readResidentUserProfileId(profileId);
  if (!canonicalProfileId) {
    return;
  }
  const connIds = context.getClientConnIds((client) => {
    const connectedProfileId = client.authenticatedUserProfile?.profileId;
    return Boolean(
      connectedProfileId &&
      (connectedProfileId === canonicalProfileId ||
        readResidentUserProfileId(connectedProfileId) === canonicalProfileId),
    );
  });
  if (connIds?.size) {
    const changedKeySets = [keys];
    if (
      keys.includes(GIT_COAUTHOR_IDENTITY_PREFERENCE_KEY) &&
      !keys.includes(GIT_COAUTHOR_PREFERENCE_KEY)
    ) {
      // First-address writes can reset consent. Keep full requests within the 32-key event bound.
      changedKeySets.push([GIT_COAUTHOR_PREFERENCE_KEY]);
    }
    for (const changedKeys of changedKeySets) {
      context.broadcastToConnIds(
        "users.prefs.changed",
        { profileId: canonicalProfileId, keys: changedKeys },
        connIds,
      );
    }
  }
}
