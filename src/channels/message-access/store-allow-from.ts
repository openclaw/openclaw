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
    (async (provider: PairingChannel, accountId: string) =>
      await readChannelIngressDefaultPairingStore({ provider, accountId }));
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
): Promise<{ entries: Array<string | number>; readFailed: boolean }> {
  if (
    !shouldReadStore({
      conversationKind: params.conversation.kind,
      dmPolicy: params.policy.dmPolicy,
    })
  ) {
    return { entries: [], readFailed: false };
  }
  const read = params.readStoreAllowFrom
    ? async () =>
        await params.readStoreAllowFrom?.({
          channelId: params.channelId,
          accountId: params.accountId,
          dmPolicy: params.policy.dmPolicy,
        })
    : params.useDefaultPairingStore
      ? async () =>
          await readChannelIngressDefaultPairingStore({
            provider: params.channelId,
            accountId: params.accountId,
          })
      : undefined;
  if (!read) {
    return { entries: [], readFailed: false };
  }
  try {
    return { entries: [...((await read()) ?? [])], readFailed: false };
  } catch {
    // The store rejected rather than resolving empty. Record that here, in the
    // ingress owner, so every reader contract - default, scoped or plugin
    // supplied - reports an unavailable store the same way.
    return { entries: [], readFailed: true };
  }
}

/**
 * Read the default pairing store for channel ingress, preserving a read
 * failure instead of resolving to an empty list.
 *
 * Module-local: `readChannelIngressStoreAllowFrom` classifies the rejection as
 * an unavailable store. Plugins keep using the best-effort reader above.
 */
async function readChannelIngressDefaultPairingStore(params: {
  provider: PairingChannel;
  accountId: string;
}): Promise<string[]> {
  // Pairing store loads channel adapters for legacy normalization; keep that
  // registry edge lazy so pure ingress policy imports stay acyclic.
  const { readChannelAllowFromStore } = await import("../../pairing/pairing-store.js");
  return await readChannelAllowFromStore(params.provider, process.env, params.accountId);
}
