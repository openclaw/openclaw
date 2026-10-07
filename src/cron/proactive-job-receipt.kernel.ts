/** Durable provisioning/cutover identity; no session or runner imports. */
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { normalizeAgentId } from "../routing/session-key.js";
import { updateConfigMachineStateInDatabase } from "../state/config-machine-state-write.js";
import { readConfigMachineStateRowInDatabase } from "../state/config-machine-state.js";
import type { DefaultProactiveJobReceipt } from "./proactive-job-receipt.types.js";
import { cronStoreKey } from "./store/key.js";
export type { DefaultProactiveJobReceipt } from "./proactive-job-receipt.types.js";
const DefaultProactiveJobReceiptSchema = z
  .object({
    jobId: z.string().min(1),
    provisionedAtMs: z.number().int().nonnegative(),
    phase: z.enum(["pending", "complete"]),
    convertedJobIds: z.array(z.string().min(1)).optional(),
  })
  .strict();

function decodeDefaultProactiveJobReceipt(value: unknown): DefaultProactiveJobReceipt | undefined {
  if (value === undefined) {
    return undefined;
  }
  const result = DefaultProactiveJobReceiptSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      "Invalid default automation cutover receipt; preserve this state and use a known-good backup or manual repair before retrying. Doctor cannot safely reconstruct it. No automation was recreated.",
    );
  }
  return result.data;
}

function defaultProactiveJobReceiptKey(storePath: string, agentId: string): string {
  return `automation-default:${cronStoreKey(storePath)}:${normalizeAgentId(agentId)}`;
}

export function readDefaultProactiveJobReceiptInDatabase(
  db: DatabaseSync,
  storePath: string,
  agentId: string,
): DefaultProactiveJobReceipt | undefined {
  const row = readConfigMachineStateRowInDatabase(
    db,
    defaultProactiveJobReceiptKey(storePath, agentId),
  );
  return decodeDefaultProactiveJobReceipt(row ? JSON.parse(row.value_json) : undefined);
}

/** Doctor may adopt an existing job; keep this receipt even after the job is deleted. */
export function recordDefaultProactiveJobInDatabase(
  db: DatabaseSync,
  storePath: string,
  agentId: string,
  jobId: string,
  nowMs: number,
  phase: DefaultProactiveJobReceipt["phase"] = "complete",
): void {
  const previous = readDefaultProactiveJobReceiptInDatabase(db, storePath, agentId);
  if (previous && previous.jobId !== jobId) {
    throw new Error(
      `Agent ${agentId} already has a default automation cutover receipt; resolve the conflicting legacy job with Doctor.`,
    );
  }
  if (!previous || (previous.phase !== "complete" && phase === "complete")) {
    updateConfigMachineStateInDatabase<DefaultProactiveJobReceipt>(
      db,
      defaultProactiveJobReceiptKey(storePath, agentId),
      () => ({ ...previous, jobId, provisionedAtMs: previous?.provisionedAtMs ?? nowMs, phase }),
      nowMs,
    );
  }
}

/** Converted tasks share the agent's one cutover; recording identity does not alter job bytes. */
export function recordConvertedProactiveJobInDatabase(
  db: DatabaseSync,
  storePath: string,
  agentId: string,
  jobId: string,
): void {
  const receipt = readDefaultProactiveJobReceiptInDatabase(db, storePath, agentId);
  if (!receipt) {
    throw new Error("Missing proactive cutover receipt");
  }
  if (receipt.convertedJobIds?.includes(jobId)) {
    return;
  }
  updateConfigMachineStateInDatabase<DefaultProactiveJobReceipt>(
    db,
    defaultProactiveJobReceiptKey(storePath, agentId),
    () => ({
      ...receipt,
      convertedJobIds: [...(receipt.convertedJobIds ?? []), jobId],
    }),
    Date.now(),
  );
}
