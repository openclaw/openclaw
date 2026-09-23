import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { readResidentUserProfileId } from "../../state/user-profile-list.js";
import type { GatewayClient } from "./types.js";

/** Bind the requester to its source, then resolve merges when metadata is assembled. */
export async function prepareChatStartupRequester(client: GatewayClient | null) {
  let profileId = client?.authenticatedUserProfile?.profileId;
  const attachedProfileId = profileId;
  if (
    !profileId &&
    (!client?.authenticatedUserId ||
      client.authenticatedGitHubIdentitySync ||
      client.authenticatedUserIsTailscaleProvider)
  ) {
    return () => undefined;
  }
  const context = captureOpenClawStateWorkerContext();
  const options = { path: context.admission.databasePath };
  const email = client?.authenticatedUserId;
  const assertCurrent = () => {
    context.admission.assertCurrent();
    if (
      attachedProfileId
        ? client?.authenticatedUserProfile?.profileId !== attachedProfileId
        : client?.authenticatedUserProfile?.profileId ||
          client?.authenticatedUserId !== email ||
          client?.authenticatedGitHubIdentitySync ||
          client?.authenticatedUserIsTailscaleProvider
    ) {
      throw new Error("Startup requester changed during metadata preparation");
    }
  };
  if (!profileId && email) {
    const { ensureProfileIdForEmail } = await import("../../state/user-profile-email.js");
    profileId = await ensureProfileIdForEmail(email, options, assertCurrent);
  }
  return () => {
    assertCurrent();
    return profileId ? readResidentUserProfileId(profileId, options) : undefined;
  };
}
