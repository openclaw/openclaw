import { readChannelAllowFromStore } from "../../pairing/pairing-store.read.js";
import type { PairingChannel } from "../../pairing/pairing-store.types.js";
import type { ResolveChannelMessageIngressParams } from "./runtime-types.js";

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
    ((provider: PairingChannel, accountId: string) =>
      readChannelAllowFromStore(provider, process.env, accountId));
  return await readStore(params.provider, params.accountId).catch(() => []);
}

export async function readChannelIngressStoreAllowFrom(
  params: ResolveChannelMessageIngressParams,
): Promise<Array<string | number>> {
  if (
    params.conversation.kind !== "direct" ||
    params.policy.dmPolicy === "allowlist" ||
    params.policy.dmPolicy === "open"
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
