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
    context.broadcastToConnIds(
      "users.prefs.changed",
      { profileId: canonicalProfileId, keys },
      connIds,
    );
  }
}
