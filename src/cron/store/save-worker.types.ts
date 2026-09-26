import type { CronStoreFile } from "../types.js";
import type { CronSaveError } from "./save-error.js";
import type {
  CronStoreChangesOptions,
  CronStoreSaveOptions,
  PreparedCronStoreChanges,
} from "./save.types.js";

export type CronStoreWriteResult<Value> = { committed: boolean } & (
  | { ok: true; value: Value }
  | { ok: false; error: CronSaveError }
);

export type CronStoreSaveWorkerOperations = {
  "cron.save": {
    input: { storeKey: string; store: CronStoreFile; options?: CronStoreSaveOptions };
    output: CronStoreWriteResult<undefined>;
  };
  "cron.saveChanges": {
    input: {
      storeKey: string;
      changes: PreparedCronStoreChanges;
      options?: CronStoreChangesOptions;
    };
    output: CronStoreWriteResult<CronStoreFile>;
  };
};
