import type { ConfigWriteResult, readConfigFileSnapshotForWrite, writeConfigFile } from "./io.js";

export type ConfigMutationIO = {
  env?: NodeJS.ProcessEnv;
  readConfigFileSnapshotForWrite: typeof readConfigFileSnapshotForWrite;
  writeConfigFile: (
    ...args: Parameters<typeof writeConfigFile>
  ) => Promise<ConfigWriteResult | void>;
};
