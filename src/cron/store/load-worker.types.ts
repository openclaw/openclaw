import type { SqliteWorkerReply } from "../../infra/sqlite-worker-contract.js";
import type { LoadedCronStore } from "./types.js";

export type CronStoreWorkerOperations = {
  "cron.loadMutable": {
    input: { storeKey: string };
    output: { repairCommits: number } & (
      | { ok: true; loaded: LoadedCronStore }
      | { ok: false; error: Extract<SqliteWorkerReply, { ok: false }>["error"] }
    );
  };
};
