export type { FileLockHandle, FileLockOptions } from "../plugin-sdk/file-lock.js";
export {
  acquireFileLock,
  drainFileLockStateForTest,
  resetFileLockStateForTest,
  withFileLock,
} from "../plugin-sdk/file-lock.js";
