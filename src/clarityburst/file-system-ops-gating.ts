/**
 * File System Operations Gating Wrapper for ClarityBurst
 *
 * This module provides utilities for wrapping filesystem calls with ClarityBurst
 * FILE_SYSTEM_OPS execution-boundary gating. All filesystem mutations must pass through
 * the gate before execution.
 *
 * Pattern:
 *   await applyFileSystemOpsGateAndWrite(path, data, options);
 *
 * The gate will:
 * 1. Extract operation type and target path from parameters
 * 2. Route through ClarityBurst FILE_SYSTEM_OPS gate
 * 3. Throw ClarityBurstAbstainError if the gate abstains (CONFIRM or CLARIFY)
 * 4. Execute the fs operation if the gate approves (PROCEED)
 * 5. Log the decision with contractId, outcome, and target path
 */

import * as fsPromises from "fs/promises";
import { ClarityBurstAbstainError } from "./errors.js";
import { applyFileSystemOverrides, type FileSystemContext } from "./decision-override.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const gatingLog = createSubsystemLogger("clarityburst-file-system-ops-gating");

/**
 * Type guard to check if result is an abstain outcome
 */
function isAbstainOutcome(
  result: any
): result is { outcome: "ABSTAIN_CONFIRM" | "ABSTAIN_CLARIFY"; reason?: string; instructions?: string; contractId?: string | null } {
  return result && (result.outcome === "ABSTAIN_CONFIRM" || result.outcome === "ABSTAIN_CLARIFY");
}

/**
 * Apply FILE_SYSTEM_OPS gate and execute writeFile
 *
 * This is the primary wrapper for writeFile calls that should be gated.
 * It applies the ClarityBurst FILE_SYSTEM_OPS gate immediately before the file
 * is written to disk.
 *
 * @param filePath - The target file path
 * @param data - The data to write
 * @param encoding - Optional encoding (default: "utf-8")
 * @returns Promise that resolves when file is written if gate approves
 * @throws ClarityBurstAbstainError if the gate returns ABSTAIN_CONFIRM or ABSTAIN_CLARIFY
 *
 * @example
 * ```typescript
 * await applyFileSystemOpsGateAndWrite("/tmp/config.json", JSON.stringify(config), "utf-8");
 * ```
 */
export async function applyFileSystemOpsGateAndWrite(
  filePath: string,
  data: string | Buffer,
  options?: BufferEncoding | { mode?: number; encoding?: BufferEncoding; flag?: string }
): Promise<void> {
  // Calculate file size in bytes
  const fileSize = typeof data === 'string'
    ? Buffer.byteLength(data, 'utf8')
    : data.length;

  // Create context for the FILE_SYSTEM_OPS gate
  const context: FileSystemContext = {
    stageId: "FILE_SYSTEM_OPS",
    operation: "write",
    path: filePath,
    fileSize,
    userConfirmed: false,
  };

  // Apply the FILE_SYSTEM_OPS gate
  const gateResult = await applyFileSystemOverrides(context);

  // Log the gating decision
  gatingLog.debug("FILE_SYSTEM_OPS gate decision", {
    contractId: gateResult.contractId,
    outcome: gateResult.outcome,
    operation: "write",
    path: filePath,
  });

  // If gate abstains, throw the appropriate error
  if (isAbstainOutcome(gateResult)) {
    const error = new ClarityBurstAbstainError({
      stageId: "FILE_SYSTEM_OPS",
      outcome: gateResult.outcome,
      reason: gateResult.reason ?? "PACK_POLICY_INCOMPLETE",
      contractId: gateResult.contractId ?? null,
      instructions: gateResult.instructions ?? `File write to ${filePath} blocked by ClarityBurst FILE_SYSTEM_OPS gate.`,
    });
    gatingLog.warn("FILE_SYSTEM_OPS gate blocked write", {
      contractId: gateResult.contractId,
      reason: gateResult.reason,
      path: filePath,
    });
    throw error;
  }

  // Gate approved: execute the writeFile
  gatingLog.debug("FILE_SYSTEM_OPS gate approved write", {
    contractId: gateResult.contractId,
    path: filePath,
  });

  return fsPromises.writeFile(filePath, data, options as any);
}

/**
 * Apply FILE_SYSTEM_OPS gate and execute appendFile
 *
 * This wrapper applies the ClarityBurst gate before appending to a file.
 *
 * @param filePath - The target file path
 * @param data - The data to append
 * @param encoding - Optional encoding (default: "utf-8")
 * @returns Promise that resolves when data is appended if gate approves
 * @throws ClarityBurstAbstainError if the gate abstains
 *
 * @example
 * ```typescript
 * await applyFileSystemOpsGateAndAppend("/tmp/log.txt", "new log entry\n", "utf-8");
 * ```
 */
export async function applyFileSystemOpsGateAndAppend(
  filePath: string,
  data: string | Buffer,
  encoding?: BufferEncoding
): Promise<void> {
  // Calculate file size in bytes
  const fileSize = typeof data === 'string'
    ? Buffer.byteLength(data, encoding ?? 'utf8')
    : data.length;

  const context: FileSystemContext = {
    stageId: "FILE_SYSTEM_OPS",
    operation: "append",
    path: filePath,
    fileSize,
    userConfirmed: false,
  };

  const gateResult = await applyFileSystemOverrides(context);

  gatingLog.debug("FILE_SYSTEM_OPS gate decision", {
    contractId: gateResult.contractId,
    outcome: gateResult.outcome,
    operation: "append",
    path: filePath,
  });

  if (isAbstainOutcome(gateResult)) {
    const error = new ClarityBurstAbstainError({
      stageId: "FILE_SYSTEM_OPS",
      outcome: gateResult.outcome,
      reason: gateResult.reason ?? "PACK_POLICY_INCOMPLETE",
      contractId: gateResult.contractId ?? null,
      instructions: gateResult.instructions ?? `File append to ${filePath} blocked by ClarityBurst FILE_SYSTEM_OPS gate.`,
    });
    gatingLog.warn("FILE_SYSTEM_OPS gate blocked append", {
      contractId: gateResult.contractId,
      reason: gateResult.reason,
      path: filePath,
    });
    throw error;
  }

  gatingLog.debug("FILE_SYSTEM_OPS gate approved append", {
    contractId: gateResult.contractId,
    path: filePath,
  });

  return fsPromises.appendFile(filePath, data, encoding);
}

/**
 * Apply FILE_SYSTEM_OPS gate and execute rm/unlink
 *
 * This wrapper applies the ClarityBurst gate before deleting a file or directory.
 *
 * @param filePath - The target file or directory path
 * @param recursive - Whether to recursively delete directories
 * @returns Promise that resolves when file/directory is deleted if gate approves
 * @throws ClarityBurstAbstainError if the gate abstains
 *
 * @example
 * ```typescript
 * await applyFileSystemOpsGateAndRm("/tmp/oldfile.txt", false);
 * await applyFileSystemOpsGateAndRm("/tmp/olddir", true);
 * ```
 */
export async function applyFileSystemOpsGateAndRm(filePath: string, recursive: boolean = false): Promise<void> {
  const context: FileSystemContext = {
    stageId: "FILE_SYSTEM_OPS",
    operation: "delete",
    path: filePath,
    userConfirmed: false,
  };

  const gateResult = await applyFileSystemOverrides(context);

  gatingLog.debug("FILE_SYSTEM_OPS gate decision", {
    contractId: gateResult.contractId,
    outcome: gateResult.outcome,
    operation: "delete",
    path: filePath,
    recursive,
  });

  if (isAbstainOutcome(gateResult)) {
    const error = new ClarityBurstAbstainError({
      stageId: "FILE_SYSTEM_OPS",
      outcome: gateResult.outcome,
      reason: gateResult.reason ?? "PACK_POLICY_INCOMPLETE",
      contractId: gateResult.contractId ?? null,
      instructions: gateResult.instructions ?? `File delete of ${filePath} blocked by ClarityBurst FILE_SYSTEM_OPS gate.`,
    });
    gatingLog.warn("FILE_SYSTEM_OPS gate blocked delete", {
      contractId: gateResult.contractId,
      reason: gateResult.reason,
      path: filePath,
    });
    throw error;
  }

  gatingLog.debug("FILE_SYSTEM_OPS gate approved delete", {
    contractId: gateResult.contractId,
    path: filePath,
  });

  return fsPromises.rm(filePath, { recursive, force: false });
}

/**
 * Apply FILE_SYSTEM_OPS gate and execute rename
 *
 * This wrapper applies the ClarityBurst gate before renaming a file or directory.
 *
 * @param oldPath - The current file/directory path
 * @param newPath - The new file/directory path
 * @returns Promise that resolves when rename is complete if gate approves
 * @throws ClarityBurstAbstainError if the gate abstains
 *
 * @example
 * ```typescript
 * await applyFileSystemOpsGateAndRename("/tmp/oldname.txt", "/tmp/newname.txt");
 * ```
 */
export async function applyFileSystemOpsGateAndRename(oldPath: string, newPath: string): Promise<void> {
  const context: FileSystemContext = {
    stageId: "FILE_SYSTEM_OPS",
    operation: "rename",
    path: oldPath, // Log old path as the operation target
    userConfirmed: false,
  };

  const gateResult = await applyFileSystemOverrides(context);

  gatingLog.debug("FILE_SYSTEM_OPS gate decision", {
    contractId: gateResult.contractId,
    outcome: gateResult.outcome,
    operation: "rename",
    oldPath,
    newPath,
  });

  if (isAbstainOutcome(gateResult)) {
    const error = new ClarityBurstAbstainError({
      stageId: "FILE_SYSTEM_OPS",
      outcome: gateResult.outcome,
      reason: gateResult.reason ?? "PACK_POLICY_INCOMPLETE",
      contractId: gateResult.contractId ?? null,
      instructions: gateResult.instructions ?? `File rename from ${oldPath} to ${newPath} blocked by ClarityBurst FILE_SYSTEM_OPS gate.`,
    });
    gatingLog.warn("FILE_SYSTEM_OPS gate blocked rename", {
      contractId: gateResult.contractId,
      reason: gateResult.reason,
      oldPath,
      newPath,
    });
    throw error;
  }

  gatingLog.debug("FILE_SYSTEM_OPS gate approved rename", {
    contractId: gateResult.contractId,
    oldPath,
    newPath,
  });

  return fsPromises.rename(oldPath, newPath);
}

/**
 * Apply FILE_SYSTEM_OPS gate and execute mkdir
 *
 * This wrapper applies the ClarityBurst gate before creating a directory.
 *
 * @param dirPath - The directory path to create
 * @param recursive - Whether to create parent directories (default: true)
 * @returns Promise that resolves when directory is created if gate approves
 * @throws ClarityBurstAbstainError if the gate abstains
 *
 * @example
 * ```typescript
 * await applyFileSystemOpsGateAndMkdir("/tmp/newdir", true);
 * ```
 */
export async function applyFileSystemOpsGateAndMkdir(dirPath: string, recursive: boolean = true): Promise<void> {
  const context: FileSystemContext = {
    stageId: "FILE_SYSTEM_OPS",
    operation: "mkdir",
    path: dirPath,
    userConfirmed: false,
  };

  const gateResult = await applyFileSystemOverrides(context);

  gatingLog.debug("FILE_SYSTEM_OPS gate decision", {
    contractId: gateResult.contractId,
    outcome: gateResult.outcome,
    operation: "mkdir",
    path: dirPath,
    recursive,
  });

  if (isAbstainOutcome(gateResult)) {
    const error = new ClarityBurstAbstainError({
      stageId: "FILE_SYSTEM_OPS",
      outcome: gateResult.outcome,
      reason: gateResult.reason ?? "PACK_POLICY_INCOMPLETE",
      contractId: gateResult.contractId ?? null,
      instructions: gateResult.instructions ?? `Directory creation for ${dirPath} blocked by ClarityBurst FILE_SYSTEM_OPS gate.`,
    });
    gatingLog.warn("FILE_SYSTEM_OPS gate blocked mkdir", {
      contractId: gateResult.contractId,
      reason: gateResult.reason,
      path: dirPath,
    });
    throw error;
  }

  gatingLog.debug("FILE_SYSTEM_OPS gate approved mkdir", {
    contractId: gateResult.contractId,
    path: dirPath,
  });

  await fsPromises.mkdir(dirPath, { recursive });
}

/**
 * Apply FILE_SYSTEM_OPS gate and execute copyFile
 *
 * This wrapper applies the ClarityBurst gate before copying a file.
 *
 * @param src - The source file path
 * @param dest - The destination file path
 * @returns Promise that resolves when file is copied if gate approves
 * @throws ClarityBurstAbstainError if the gate abstains
 *
 * @example
 * ```typescript
 * await applyFileSystemOpsGateAndCopy("/tmp/original.txt", "/tmp/backup.txt");
 * ```
 */
export async function applyFileSystemOpsGateAndCopy(src: string, dest: string): Promise<void> {
  const context: FileSystemContext = {
    stageId: "FILE_SYSTEM_OPS",
    operation: "copy",
    path: src,
    userConfirmed: false,
  };

  const gateResult = await applyFileSystemOverrides(context);

  gatingLog.debug("FILE_SYSTEM_OPS gate decision", {
    contractId: gateResult.contractId,
    outcome: gateResult.outcome,
    operation: "copy",
    src,
    dest,
  });

  if (isAbstainOutcome(gateResult)) {
    const error = new ClarityBurstAbstainError({
      stageId: "FILE_SYSTEM_OPS",
      outcome: gateResult.outcome,
      reason: gateResult.reason ?? "PACK_POLICY_INCOMPLETE",
      contractId: gateResult.contractId ?? null,
      instructions: gateResult.instructions ?? `File copy from ${src} to ${dest} blocked by ClarityBurst FILE_SYSTEM_OPS gate.`,
    });
    gatingLog.warn("FILE_SYSTEM_OPS gate blocked copy", {
      contractId: gateResult.contractId,
      reason: gateResult.reason,
      src,
      dest,
    });
    throw error;
  }

  gatingLog.debug("FILE_SYSTEM_OPS gate approved copy", {
    contractId: gateResult.contractId,
    src,
    dest,
  });

  return fsPromises.copyFile(src, dest);
}
