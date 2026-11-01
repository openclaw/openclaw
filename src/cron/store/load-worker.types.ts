import type { SqliteWorkerReply } from "../../infra/sqlite-worker-contract.js";
import type { CronJobConfigRevisionResult } from "../config-revision.js";
import type { LoadedCronStore } from "./types.js";

export type CronStoreWorkerOperations = {
  "cron.loadMutable": {
    input: { storeKey?: string; defaultStorePath?: string; includeConfigRevisions?: boolean };
    output: { storeKey: string; repairCommits: number } & (
      | {
          ok: true;
          loaded: LoadedCronStore & { configRevisions: Map<string, CronJobConfigRevisionResult> };
        }
      | { ok: false; error: Extract<SqliteWorkerReply, { ok: false }>["error"] }
    );
  };
};
