import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import type { UserChannelIdentity } from "../state/user-profiles.types.js";
import {
  readLinkedChannelSenderCandidate,
  requiresLinkedChannelSenderDisplayRead,
  type LinkedChannelSenderDisplay,
  type LinkedChannelSenderDisplayResolver,
} from "./chat-display-projection.linked-senders.js";
import {
  resolveCurrentUserProfileDisplay,
  type CurrentUserProfileDisplay,
  type CurrentUserProfileDisplayResolver,
} from "./current-user-profile-display.js";

export type { LinkedChannelSenderDisplayResolver } from "./chat-display-projection.linked-senders.js";
export type LinkedChannelSenderDisplayPreparation = (
  messages: readonly unknown[],
) => Promise<LinkedChannelSenderDisplayResolver>;

/** A page-local presentation snapshot, never requester, ownership, or tool authority. */
export async function prepareLinkedChannelSenderDisplay(
  messages: readonly unknown[],
  options: {
    resolveDisplay?: CurrentUserProfileDisplayResolver;
    readLink?: (identity: UserChannelIdentity) => string | undefined | Promise<string | undefined>;
  } = {},
): Promise<LinkedChannelSenderDisplayResolver> {
  if (!messages.some(requiresLinkedChannelSenderDisplayRead)) {
    return () => undefined;
  }
  // History kernels receive this operation from their admitted caller; channel
  // link storage is loaded only when that caller has not supplied its own reader.
  const resolveDisplay = options.resolveDisplay ?? resolveCurrentUserProfileDisplay;
  const readLink =
    options.readLink ??
    (await import("../state/user-channel-identity-operations.js"))
      .readCanonicalUserChannelIdentityProfileId;
  const profiles = new Map<string, CurrentUserProfileDisplay>();
  const links = new Map<string, Promise<string | undefined>>();
  const displays = new Map<string, LinkedChannelSenderDisplay>();
  await Promise.all(
    messages.map(async (message) => {
      const candidate = readLinkedChannelSenderCandidate(message);
      if (!candidate) {
        return;
      }
      let display = profiles.get(candidate.profileId);
      if (!display) {
        display = resolveDisplay(candidate.profileId);
        profiles.set(candidate.profileId, display);
      }
      if (display.kind !== "resolved" || display.profileId === GATEWAY_OWNER_PROFILE_ID) {
        return;
      }
      const key = JSON.stringify(candidate.identity);
      let linked = links.get(key);
      if (!linked) {
        linked = Promise.resolve(readLink(candidate.identity));
        links.set(key, linked);
      }
      if ((await linked) === display.profileId) {
        displays.set(JSON.stringify(candidate), display);
      }
    }),
  );
  return (message) => {
    const candidate = readLinkedChannelSenderCandidate(message);
    return candidate ? displays.get(JSON.stringify(candidate)) : undefined;
  };
}
