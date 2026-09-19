import { resolveUserProfileId } from "../../state/user-profiles.js";
import type { GatewayRequestContext } from "./types.js";

export function publishUserPreferencesChanged(
  context: GatewayRequestContext,
  profileId: string,
  keys: string[],
): void {
  if (!keys.length || !context.getClientConnIds) {
    return;
  }
  const canonicalProfileId = resolveUserProfileId(profileId);
  if (!canonicalProfileId) {
    return;
  }
  const connIds = context.getClientConnIds((client) => {
    const connectedProfileId = client.authenticatedUserProfile?.profileId;
    return Boolean(
      connectedProfileId &&
      (connectedProfileId === canonicalProfileId ||
        resolveUserProfileId(connectedProfileId) === canonicalProfileId),
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
