import { upsertChannelPairingRequest } from "../../pairing/pairing-store.js";
import type { DiscordDmCommandAccess } from "./dm-command-auth.js";

export async function handleDiscordDmCommandDecision(params: {
  dmAccess: DiscordDmCommandAccess;
  accountId: string;
  sender: {
    id: string;
    tag?: string;
    name?: string;
  };
  onPairingCreated: (code: string) => Promise<void>;
  onUnauthorized: () => Promise<void>;
  upsertPairingRequest?: typeof upsertChannelPairingRequest;
}): Promise<boolean> {
  if (params.dmAccess.decision === "allow") {
    return true;
  }

  if (params.dmAccess.decision === "pairing") {
    const upsertPairingRequest = params.upsertPairingRequest ?? upsertChannelPairingRequest;
    const { code, created } = await upsertPairingRequest({
      channel: "discord",
      id: params.sender.id,
      accountId: params.accountId,
      meta: {
        tag: params.sender.tag,
        name: params.sender.name,
      },
    });
    if (created) {
      await params.onPairingCreated(code);
    }
    return false;
  }

  await params.onUnauthorized();
  return false;
}
