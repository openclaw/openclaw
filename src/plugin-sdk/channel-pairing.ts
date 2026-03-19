import type { ChannelId } from "../channels/plugins/types.js";
import { issuePairingChallenge } from "../pairing/pairing-challenge.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { createScopedPairingAccess } from "./pairing-access.js";

export { createScopedPairingAccess } from "./pairing-access.js";

type ScopedPairingAccess = ReturnType<typeof createScopedPairingAccess>;

export type ChannelPairingController = ScopedPairingAccess & {
  issueChallenge: (
    params: Omit<Parameters<typeof issuePairingChallenge>[0], "channel" | "upsertPairingRequest">,
  ) => ReturnType<typeof issuePairingChallenge>;
};

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

export function createChannelPairingController(params: {
  core: PluginRuntime;
  channel: ChannelId;
  accountId: string;
}): ChannelPairingController {
  const access = createScopedPairingAccess(params);
  return {
    ...access,
    issueChallenge: createChannelPairingChallengeIssuer({
      channel: params.channel,
      upsertPairingRequest: access.upsertPairingRequest,
    }),
  };
}
