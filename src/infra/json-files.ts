import { readRegularFileSync } from "@openclaw/fs-safe/advanced";
import { writeTextAtomic as writeFsSafeTextAtomic } from "@openclaw/fs-safe/atomic";
import {
  tryReadJsonSync,
  writeJson as writeFsSafeJson,
  writeJsonSync as writeFsSafeJsonSync,
} from "@openclaw/fs-safe/json";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";

export {
  JsonFileReadError,
  readJson,
  readJsonIfExists,
  readJsonIfExists as readDurableJsonFile, // Sanctioned domain alias.
  readJsonSync,
  readRootJsonObjectSync,
  tryReadJson,
  tryReadJson as readJsonFile, // Sanctioned domain alias.
  tryReadJsonSync,
} from "@openclaw/fs-safe/json";

export const writeJson: typeof writeFsSafeJson = async (filePath, value, options) =>
  writeFsSafeJson(filePath, value, {
    ...options,
    allowDrvfsRenameRecovery: options?.allowDrvfsRenameRecovery ?? true,
  });

export { writeJson as writeJsonAtomic }; // Sanctioned domain alias.

export const writeJsonSync: typeof writeFsSafeJsonSync = (filePath, value, options) =>
  writeFsSafeJsonSync(filePath, value, {
    ...options,
    allowDrvfsRenameRecovery: options?.allowDrvfsRenameRecovery ?? true,
  });

export { createAsyncLock } from "@openclaw/fs-safe/advanced";

export function tryReadJsonObjectSync(filePath: string): Record<string, unknown> | null {
  return asNullableRecord(tryReadJsonSync(filePath));
}

// Native plugin manifests are documented as JSON5-capable; strict readers would
// silently reject comments, trailing commas, and unquoted keys on install.
export function tryReadJson5ObjectSync(filePath: string): Record<string, unknown> | null {
  try {
    const { buffer } = readRegularFileSync({ filePath });
    return asNullableRecord(parseJsonWithJson5Fallback(buffer.toString("utf8")));
  } catch {
    return null;
  }
}

export const writeTextAtomic: typeof writeFsSafeTextAtomic = async (filePath, content, options) => {
  // The public SDK treats empty prefixes as defaults and ignores unrelated options.
  await writeFsSafeTextAtomic(filePath, content, {
    mode: options?.mode,
    dirMode: options?.dirMode,
    trailingNewline: options?.trailingNewline,
    durable: options?.durable,
    beforeRename: options?.beforeRename || undefined,
    tempPrefix: options?.tempPrefix || undefined,
    allowDrvfsRenameRecovery: options?.allowDrvfsRenameRecovery ?? true,
  });
};
