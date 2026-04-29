/**
 * 文件锁类型导出
 * 从plugin-sdk重新导出文件锁相关类型和函数
 */

// 文件锁句柄类型
export type {
  FileLockHandle,
  FileLockOptions,
  FileLockTimeoutError,
} from "../plugin-sdk/file-lock.js";

// 文件锁函数导出
export {
  acquireFileLock,
  drainFileLockStateForTest,
  FILE_LOCK_TIMEOUT_ERROR_CODE,
  resetFileLockStateForTest,
  withFileLock,
} from "../plugin-sdk/file-lock.js";
