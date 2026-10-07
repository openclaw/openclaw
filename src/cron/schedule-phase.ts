// Computes deterministic phase anchors for ordinary scheduled jobs.
import { createHash } from "node:crypto";
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";

export function resolveSchedulePhaseMs(params: {
  schedulerSeed: string;
  agentId: string;
  intervalMs: number;
}) {
  const intervalMs = resolveIntegerOption(params.intervalMs, 1, { min: 1 });
  const digest = createHash("sha256").update(`${params.schedulerSeed}:${params.agentId}`).digest();
  return digest.readUInt32BE(0) % intervalMs;
}
