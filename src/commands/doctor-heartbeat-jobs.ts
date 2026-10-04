import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { cronStoreKey } from "../cron/store/key.js";
import { loadCronRows, rowToCronJob } from "../cron/store/row-codec.js";
import type { CronJobReadRow } from "../cron/store/schema.js";
import type { CronStoredJob } from "../cron/types.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";

const LegacyHeartbeatPayloadSchema = z
  .object({
    kind: z.literal("heartbeat"),
    toolsAllow: z.array(z.string()).optional(),
    toolsAllowIsDefault: z.boolean().optional(),
  })
  .strict();

type LegacyHeartbeatJob = Omit<CronStoredJob, "payload"> & {
  payload: z.infer<typeof LegacyHeartbeatPayloadSchema>;
};

export type DoctorCronJob = CronStoredJob | LegacyHeartbeatJob;

/** Decode retired payloads only inside Doctor; runtime jobs never admit heartbeat. */
export function decodeDoctorHeartbeatJobRows(rows: readonly CronJobReadRow[]): DoctorCronJob[] {
  return rows.flatMap((row): DoctorCronJob[] => {
    const legacyRow =
      row.payload_kind === "heartbeat" || row.declaration_key?.startsWith("heartbeat-task:");
    const definition = safeParseJsonRecord(row.job_json);
    if (!definition) {
      if (legacyRow) {
        throw new Error(
          `Automation ${row.job_id} has invalid stored JSON; its source was retained.`,
        );
      }
      return [];
    }
    const payload = definition.payload;
    if (isRecord(payload) && payload.kind === "heartbeat") {
      const legacyPayload = LegacyHeartbeatPayloadSchema.parse(payload);
      // Reuse the canonical envelope decoder. Only the retired discriminator is
      // translated for validation; the result stays in this migration-only type.
      const decoded = rowToCronJob(row, {
        ...definition,
        payload: { ...legacyPayload, kind: "agentTurn", message: "Legacy heartbeat" },
      });
      if (!decoded) {
        throw new Error(`Legacy automation ${row.job_id} is invalid; its source was retained.`);
      }
      return [
        {
          ...decoded,
          payload: {
            ...legacyPayload,
            ...(decoded.payload.toolsAllow ? { toolsAllow: decoded.payload.toolsAllow } : {}),
          },
        },
      ];
    }
    const decoded = rowToCronJob(row, definition);
    if (!decoded && legacyRow) {
      throw new Error(`Automation ${row.job_id} is invalid; its source was retained.`);
    }
    // Ordinary invalid rows belong to Doctor's backed-up cron repair/quarantine.
    return decoded ? [decoded] : [];
  });
}

export function readDoctorHeartbeatJobs(
  storePath: string,
  env: NodeJS.ProcessEnv,
): DoctorCronJob[] {
  return (
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => decodeDoctorHeartbeatJobRows(loadCronRows(db, cronStoreKey(storePath))),
      { env },
    ) ?? []
  );
}
