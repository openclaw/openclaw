// Computes deterministic phase anchors for Doctor-migrated heartbeat jobs.
import { createHash } from "node:crypto";
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveStateDir } from "../config/state-dir.js";
import { loadDeviceIdentityIfPresent, loadOrCreateDeviceIdentity } from "./device-identity.js";

/** Doctor previews and migrations retain their synchronous one-shot admission. */
export function resolveHeartbeatSchedulerSeed(
  explicitSeed?: string,
  options: { env?: NodeJS.ProcessEnv; readOnly?: boolean } = {},
) {
  const normalized = normalizeOptionalString(explicitSeed);
  if (normalized) {
    return normalized;
  }
  const env = options.env ?? process.env;
  try {
    const identity = options.readOnly
      ? loadDeviceIdentityIfPresent({ env })
      : loadOrCreateDeviceIdentity({ env });
    if (identity) {
      return identity.deviceId;
    }
  } catch {
    // Read-only Doctor previews never create identity state; absent state
    // still receives a deterministic monitor anchor.
  }
  return fallbackSchedulerSeed(env);
}

function fallbackSchedulerSeed(env: NodeJS.ProcessEnv): string {
  return createHash("sha256").update(resolveStateDir(env)).digest("hex");
}

export function resolveHeartbeatPhaseMs(params: {
  schedulerSeed: string;
  agentId: string;
  intervalMs: number;
}) {
  const intervalMs = resolveIntegerOption(params.intervalMs, 1, { min: 1 });
  const digest = createHash("sha256").update(`${params.schedulerSeed}:${params.agentId}`).digest();
  return digest.readUInt32BE(0) % intervalMs;
}
