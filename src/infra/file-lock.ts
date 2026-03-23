export type { FileLockHandle, FileLockOptions } from "../plugin-sdk/file-lock.js";
export {
  acquireFileLock,
  resetFileLockStateForTest,
  withFileLock,
} from "../plugin-sdk/file-lock.js";
