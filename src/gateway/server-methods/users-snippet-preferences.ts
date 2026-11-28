import { hasCurrentPersonalGatewaySource } from "./gateway-personal-caller.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { prepareAuthenticatedProfile } from "./users-profile-access.js";

/** Catalog bodies are available to the person's draft UI, never a synthetic agent request. */
export async function prepareSnippetPreferenceAccess(options: GatewayRequestHandlerOptions) {
  const assertSource = () => {
    options.signal?.throwIfAborted();
    options.sessionMutationAuthorization?.assertCurrent();
    if (!hasCurrentPersonalGatewaySource(options.client, options.context)) {
      throw new Error("Voice snippets require a current signed-in personal connection.");
    }
  };
  assertSource();
  const profile = await prepareAuthenticatedProfile(options);
  const assertCurrent = () => {
    assertSource();
    profile.assertCurrent();
    if (!profile.profileId) {
      throw new Error("Sign in with a durable profile to use voice snippets.");
    }
  };
  assertCurrent();
  return assertCurrent;
}
