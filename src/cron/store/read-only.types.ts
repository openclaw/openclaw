import type { SqliteWorkerReply } from "../../infra/sqlite-worker-contract.js";
import type { PluginDoctorCronJob } from "../../plugins/doctor-contract-module.js";
import type { CronRunRecord } from "./run-history.types.js";
import type { LoadedCronStore } from "./types.js";

export type CronRunHistorySelector = { runId?: string; runAtMs?: number };
export type CronRunHistoryBinding = {
  binding: string;
  sessionKey: string;
  sessionId: string;
  agentId?: string;
};

export type CronReadOnlyRequest = {
  location: string;
  history?: { jobId?: string; transcript?: CronRunHistorySelector };
  /** Omitted only for Doctor's all-partition raw inventory. */
  storeKey?: string;
  stagingRoot?: string;
};
export type CronReadOnlyResult =
  | {
      ok: true;
      loaded?: LoadedCronStore;
      history?: CronRunRecord[];
      binding?: CronRunHistoryBinding;
      inventory?: PluginDoctorCronJob[];
    }
  | { ok: false; error: Extract<SqliteWorkerReply, { ok: false }>["error"] };
