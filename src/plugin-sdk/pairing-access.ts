import type { ChannelId } from "../channels/plugins/types.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { normalizeAccountId } from "../routing/session-key.js";

type PairingApi = PluginRuntime["channel"]["pairing"];
type ScopedUpsertInput = Omit<
  Parameters<PairingApi["upsertPairingRequest"]>[0],
  "channel" | "accountId"
>;

export function createScopedPairingAccess(params: {
  core: PluginRuntime;
  channel: ChannelId;
  accountId: string;
}) {
  const resolvedAccountId = normalizeAccountId(params.accountId);
  return {
    accountId: resolvedAccountId,
    readAllowFromStore: () =>
      params.core.channel.pairing.readAllowFromStore({
        channel: params.channel,
        accountId: resolvedAccountId,
      }),
    readStoreForDmPolicy: (provider: ChannelId, accountId: string) =>
      params.core.channel.pairing.readAllowFromStore({
        channel: provider,
        accountId: normalizeAccountId(accountId),
      }),
    upsertPairingRequest: (input: ScopedUpsertInput) =>
      params.core.channel.pairing.upsertPairingRequest({
        channel: params.channel,
        accountId: resolvedAccountId,
        ...input,
      }),
  };
}
