import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import {
  readChannelPairingStateSnapshot,
  writeChannelPairingStateSnapshot,
} from "./pairing-store-sqlite.test-helpers.js";
import {
  addChannelAllowFromStoreEntry,
  approveChannelPairingCode,
  approveChannelPairingRequest,
  dismissChannelPairingRequest,
  listChannelPairingRequests,
  readChannelAllowFromStore,
  removeChannelAllowFromStoreEntry,
  upsertChannelPairingRequest,
} from "./pairing-store.js";

type Approval = Omit<
  Parameters<typeof approveChannelPairingCode>[0],
  "channel" | "env" | "code"
> & {
  code?: string;
  resolveApprovalStoreEntry?: NonNullable<
    Parameters<typeof approveChannelPairingCode>[0]["pairingAdapter"]
  >["resolveApprovalStoreEntry"];
};

export function pairingStoreFixture(
  channel: string,
  env: NodeJS.ProcessEnv,
  accountId = DEFAULT_ACCOUNT_ID,
) {
  const scope = { channel, env, accountId };
  return {
    read: (sourceEnv = env) => readChannelPairingStateSnapshot(channel, sourceEnv),
    write: (state: Parameters<typeof writeChannelPairingStateSnapshot>[1]) =>
      writeChannelPairingStateSnapshot(channel, state, env),
    list: (account?: string, assertCurrent?: () => void) =>
      listChannelPairingRequests(channel, env, account, assertCurrent),
    allow: (account = accountId) => readChannelAllowFromStore(channel, env, account),
    upsert: (id: string, account = accountId, meta?: Record<string, string>) =>
      upsertChannelPairingRequest({ ...scope, id, accountId: account, meta }),
    add: (entry: string, targetEnv = env) =>
      addChannelAllowFromStoreEntry({ ...scope, entry, env: targetEnv }),
    remove: (entry: string) => removeChannelAllowFromStoreEntry({ ...scope, entry }),
    dismiss: (requestId: string) => dismissChannelPairingRequest({ ...scope, requestId }),
    approveRequest: (requestId: string, account: string, requestChannel = channel) =>
      approveChannelPairingRequest({
        ...scope,
        requestId,
        accountId: account,
        channel: requestChannel,
      }),
    approve: ({ resolveApprovalStoreEntry, ...options }: Approval = {}) =>
      approveChannelPairingCode({
        channel,
        env,
        code: "ABCDEFGH",
        pairingAdapter: { idLabel: "peer", resolveApprovalStoreEntry },
        ...options,
      }),
  };
}
