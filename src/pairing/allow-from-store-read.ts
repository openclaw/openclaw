import { resolveAllowFromAccountId } from "./pairing-store-keys.js";
import { readChannelAllowFromStoreSync } from "./pairing-store.js";
import type { PairingChannel } from "./pairing-store.types.js";

export function readChannelAllowFromStoreEntriesSync(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): string[] {
  return readChannelAllowFromStoreSync(channel, env, resolveAllowFromAccountId(accountId));
}

export function clearAllowFromStoreReadCacheForTest(): void {
  // SQLite-backed reads do not keep a process-local file cache.
}
