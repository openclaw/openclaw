import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { writeCronJobScratchByKey } from "./scratch-store.js";
import {
  loadCronJobsStoreWithConfigJobs,
  loadCronJobsStoreWithConfigJobsReadOnly,
  saveCronJobsStore,
} from "./store.js";
import { prepareMutableCronStoreKey } from "./store/paths.js";
import type { CronStoreFile } from "./types.js";

type CronScratchTestWriteParams = Omit<
  Parameters<typeof writeCronJobScratchByKey>[0],
  "storeKey"
> & { storePath: string };

export async function writeCronJobScratch(params: CronScratchTestWriteParams) {
  const captured = { ...params };
  const context = captureOpenClawStateWorkerContext(captured.options);
  const storeKey = await prepareMutableCronStoreKey(
    captured.storePath,
    context,
    captured.options?.env,
  );
  return writeCronJobScratchByKey({ ...captured, storeKey }, { context });
}

function cronFixture(state: OpenClawTestState) {
  const storePath = state.statePath("cron", "jobs.json");
  const databasePath = resolveOpenClawStateSqlitePath(state.env);
  const read = () => loadCronJobsStoreWithConfigJobsReadOnly(storePath, state.env);
  return {
    ...state,
    storePath,
    databasePath,
    load: () => loadCronJobsStoreWithConfigJobs(storePath),
    save: (store: CronStoreFile, options?: Parameters<typeof saveCronJobsStore>[2]) =>
      saveCronJobsStore(storePath, store, options),
    read: (preserve = false) => (preserve ? withArtifactPreservingStateReads(read) : read()),
    bytes: () => fs.readFile(databasePath),
    close: () => closeOpenClawStateDatabaseByPathAsync(databasePath),
    async createDatabase(sql = "CREATE TABLE marker(value TEXT)") {
      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      const db = new DatabaseSync(databasePath);
      try {
        db.exec(sql);
      } finally {
        db.close();
      }
    },
  };
}

export function withCronStore<T>(
  label: string,
  run: (state: ReturnType<typeof cronFixture>) => Promise<T>,
  env?: Record<string, string | undefined>,
) {
  return withOpenClawTestState({ label, env }, (state) => run(cronFixture(state)));
}
