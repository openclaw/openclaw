import type { ChannelId } from "../channels/plugins/types.public.js";
export {
  createLoggedPairingApprovalNotifier,
  createPairingPrefixStripper,
  createTextPairingAdapter,
} from "../channels/plugins/pairing-adapters.js";
export {
  readChannelAllowFromStore,
  readChannelAllowFromStoreSync,
} from "../pairing/pairing-store.js";
export { resolveChannelAllowFromPath } from "../pairing/pairing-store.js";
import { issuePairingChallenge } from "../pairing/pairing-challenge.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { createScopedPairingAccess } from "./pairing-access.js";

type ScopedPairingAccess = ReturnType<typeof createScopedPairingAccess>;

/** Pairing helpers scoped to one channel account. */
export type ChannelPairingController = ScopedPairingAccess & {
  /** Issues a challenge through the same normalized channel/account store as read/write helpers. */
  issueChallenge: (
    params: Omit<Parameters<typeof issuePairingChallenge>[0], "channel" | "upsertPairingRequest">,
  ) => ReturnType<typeof issuePairingChallenge>;
};

/** Pre-bind the channel id and storage sink for pairing challenges. */
export function createChannelPairingChallengeIssuer(params: {
  channel: ChannelId;
  upsertPairingRequest: Parameters<typeof issuePairingChallenge>[0]["upsertPairingRequest"];
}) {
  return (
    challenge: Omit<
      Parameters<typeof issuePairingChallenge>[0],
      "channel" | "upsertPairingRequest"
    >,
  ) =>
    issuePairingChallenge({
      channel: params.channel,
      upsertPairingRequest: params.upsertPairingRequest,
      ...challenge,
    });
}

/** Build the full scoped pairing controller used by channel runtime code. */
export function createChannelPairingController(params: {
  core: PluginRuntime;
  channel: ChannelId;
  accountId: string;
}): ChannelPairingController {
  const access = createScopedPairingAccess(params);
  return {
    ...access,
    // Use the scoped upsert sink so challenge issuance preserves normalized account ids.
    issueChallenge: createChannelPairingChallengeIssuer({
      channel: params.channel,
      upsertPairingRequest: access.upsertPairingRequest,
    }),
  };
}
