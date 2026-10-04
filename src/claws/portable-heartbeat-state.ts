import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronJobsStorePath } from "../cron/store/paths.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { resolveConfigDir } from "../utils.js";
import type { PortableHeartbeatState } from "./portable-heartbeat-state.types.js";

export async function readPortableHeartbeatState(
  agentId: string,
  cfg: OpenClawConfig,
  options: OpenClawStateDatabaseOptions,
): Promise<PortableHeartbeatState> {
  const configured = asOptionalRecord(cfg.cron)?.store;
  const storePath = typeof configured === "string" && configured.trim() ? configured : undefined;
  const reply = await executeExistingOpenClawStateRead(
    { ...options, path: options.database?.path ?? options.path },
    { type: "clawMonitorCleanup.portable", input: { agentId, storePath } },
  );
  if (!reply) {
    return {
      storePath: resolveCronJobsStorePath(
        storePath ?? path.join(resolveConfigDir(options.env), "cron", "jobs.json"),
        options.env,
      ),
      receipt: undefined,
      ref: undefined,
      job: undefined,
      scratch: { currentRevision: 0 },
    };
  }
  if (!reply.ok || reply.type !== "clawMonitorCleanup.portable") {
    throw new Error("Portable automation read did not return its admitted snapshot.");
  }
  return reply.state;
}
