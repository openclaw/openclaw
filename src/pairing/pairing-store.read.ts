import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import { resolveAllowFromAccountId, safeChannelKey } from "./pairing-store-keys.js";
import type { PairingChannel } from "./pairing-store.types.js";

/** Prepare current allowlist facts; the channel owner still admits the message. */
export async function readChannelAllowFromStore(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): Promise<string[]> {
  const resolvedAccountId = resolveAllowFromAccountId(accountId);
  const channelKey = safeChannelKey(channel);
  const context = captureOpenClawStateReadWorkerContext({ env });
  const result = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "pairing.allowFrom", input: { channel: channelKey, accountId: resolvedAccountId } },
    { context, current: true },
  );
  // Boot and Doctor own initialization. Absence grants no pairing permission.
  if (result === undefined) {
    // Keep the native empty-map lookup's refusal of inherited account keys.
    const allowFrom: Record<string, string[]> = {};
    return (allowFrom[resolvedAccountId] ?? []).slice();
  }
  if (result.ok && result.type === "pairing.allowFrom") {
    return result.entries;
  }
  throw new Error("Unexpected channel pairing allowlist result");
}
