import { vi } from "vitest";
import type { UserProfile } from "../state/user-profiles.types.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { sharingPolicyClient } from "./session-sharing.test-utils.js";

export function createSessionRowEventPeer(
  profile: Pick<UserProfile, "id" | "displayName">,
  connId: string,
  now: number,
) {
  const send = vi.fn();
  const client = {
    ...sharingPolicyClient({ user: profile.id }),
    connId,
    usesSharedGatewayAuth: false,
    authenticatedUserProfile: {
      profileId: profile.id,
      displayName: profile.displayName,
      avatarRevision: "1",
      hasAvatar: false,
      updatedAt: now,
    },
    socket: {
      readyState: 1,
      bufferedAmount: 0,
      send,
      close: vi.fn(),
      terminate: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      once: vi.fn(),
    },
  } satisfies GatewayWsClient;
  prepareGatewayRecipientProfile(client);
  return { client, send };
}
