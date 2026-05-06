import fs from "node:fs";
import path from "node:path";
import { isRecord } from "../utils.js";
import { type RootFileOpenFailure } from "./boundary-file-read.js";
import "./fs-safe-defaults.js";
export {
  JsonFileReadError,
  readJson,
  readJson as readJsonFileStrict,
  readJsonIfExists,
  readJsonIfExists as readDurableJsonFile,
  readJsonSync,
  tryReadJson,
  tryReadJson as readJsonFile,
  tryReadJsonSync,
  tryReadJsonSync as readJsonFileSync,
  writeJson,
  writeJson as writeJsonAtomic,
  writeJsonSync,
} from "@openclaw/fs-safe/json";
export { writeTextAtomic } from "@openclaw/fs-safe/atomic";
export { createAsyncLock } from "@openclaw/fs-safe/advanced";

export type RootReadJsonSyncResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "open"; failure: RootFileOpenFailure }
  | { ok: false; reason: "read" | "parse" | "invalid"; error: string };

export function readRootJsonSync<T = unknown>(params: {
  rootDir: string;
  relativePath: string;
  boundaryLabel?: string;
  rejectHardlinks?: boolean;
  rootRealPath?: string;
  parse?: (raw: string) => any;
  validate?: (raw: any) => raw is T;
}): RootReadJsonSyncResult<T> {
  const rootDir = path.normalize(path.resolve(params.rootDir));
  const absolutePath = path.normalize(path.resolve(rootDir, params.relativePath));

  if (!absolutePath.startsWith(rootDir + path.sep) && absolutePath !== rootDir) {
    return { ok: false, reason: "open", failure: { ok: false, reason: "validation" } };
  }

  let text: string;
  try {
    text = fs.readFileSync(absolutePath, "utf8");
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      return { ok: false, reason: "open", failure: { ok: false, reason: "validation" } };
    }
    return { ok: false, reason: "read", error: String(err) };
  }

  try {
    const value = params.parse ? params.parse(text) : JSON.parse(text);
    if (params.validate && !params.validate(value)) {
      return { ok: false, reason: "invalid", error: "Validation failed" };
    }
    return { ok: true, value: value as T };
  } catch (err) {
    return { ok: false, reason: "parse", error: String(err) };
  }
}

export function readRootJsonObjectSync(
  params: Parameters<typeof readRootJsonSync>[0],
): RootReadJsonSyncResult<Record<string, unknown>> {
  const result = readRootJsonSync(params);
  if (!result.ok) return result;
  if (!isRecord(result.value)) {
    return { ok: false, reason: "invalid", error: "JSON is not an object" };
  }
  return { ok: true, value: result.value };
}

export function readRootStructuredFileSync<T>(
  params: Parameters<typeof readRootJsonSync>[0],
): RootReadJsonSyncResult<T> {
  const result = readRootJsonSync(params);
  if (!result.ok) return result;
  if (!isRecord(result.value)) {
    return { ok: false, reason: "invalid", error: "JSON is not an object" };
  }
  return { ok: true, value: result.value as T };
}
