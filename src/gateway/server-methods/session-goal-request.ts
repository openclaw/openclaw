import { createHmac } from "node:crypto";
import { loadOrCreateProcessDeviceIdentityAsync } from "../../infra/device-identity-async.js";

/** Stable, keyed receipts do not retain another copy or an offline digest of prompt material. */
export async function fingerprintSessionGoalRequest(
  value: Record<string, unknown> | readonly unknown[],
): Promise<string> {
  const canonical = JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : item,
  );
  const identity = await loadOrCreateProcessDeviceIdentityAsync();
  return createHmac("sha256", identity.privateKeyPem)
    .update("openclaw.session-goal.v1\0")
    .update(canonical)
    .digest("hex");
}
