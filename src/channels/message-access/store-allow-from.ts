import type { PairingChannel } from "../../pairing/pairing-store.types.js";
import type { ResolveChannelMessageIngressParams } from "./runtime-types.js";
import type {
  ChannelIngressChannelId,
  ChannelIngressPolicyInput,
  ChannelIngressStateInput,
} from "./types.js";

/**
 * Read pairing-store allowlist entries when a direct-message policy permits
 * store fallback.
 */
export async function readChannelIngressStoreAllowFromForDmPolicy(params: {
  provider: PairingChannel;
  accountId: string;
  dmPolicy?: string | null;
  shouldRead?: boolean | null;
  readStore?: (provider: PairingChannel, accountId: string) => Promise<string[]>;
}): Promise<string[]> {
  if (
    params.shouldRead === false ||
    params.dmPolicy === "allowlist" ||
    params.dmPolicy === "open"
  ) {
    return [];
  }
  const readStore =
    params.readStore ??
    (async (provider: PairingChannel, accountId: string) => {
      // Pairing store loads channel adapters for legacy normalization; keep that
      // registry edge lazy so pure ingress policy imports stay acyclic.
      const { readChannelAllowFromStore } = await import("../../pairing/pairing-store.js");
      return await readChannelAllowFromStore(provider, process.env, accountId);
    });
  return await readStore(params.provider, params.accountId).catch(() => []);
}

function shouldReadStore(params: {
  conversationKind: ChannelIngressStateInput["conversation"]["kind"];
  dmPolicy: ChannelIngressPolicyInput["dmPolicy"];
}): boolean {
  return (
    params.conversationKind === "direct" &&
    params.dmPolicy !== "allowlist" &&
    params.dmPolicy !== "open"
  );
}

export async function readChannelIngressStoreAllowFrom(
  params: ResolveChannelMessageIngressParams & { channelId: ChannelIngressChannelId },
): Promise<Array<string | number>> {
  if (
    !shouldReadStore({
      conversationKind: params.conversation.kind,
      dmPolicy: params.policy.dmPolicy,
    })
  ) {
    return [];
  }
  const entries = params.readStoreAllowFrom
    ? await params
        .readStoreAllowFrom({
          channelId: params.channelId,
          accountId: params.accountId,
          dmPolicy: params.policy.dmPolicy,
        })
        .catch(() => [])
    : params.useDefaultPairingStore
      ? await readChannelIngressStoreAllowFromForDmPolicy({
          provider: params.channelId,
          accountId: params.accountId,
          dmPolicy: params.policy.dmPolicy,
        })
      : [];
  return [...(entries ?? [])];
}
