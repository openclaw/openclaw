import fs, { type Stats } from "node:fs";
import path from "node:path";
import { openRootFileSync, type RootFileOpenFailure } from "./boundary-file-read.js";

export type RootJsonObjectReadResult =
  | { ok: true; raw: Record<string, unknown>; stat: Stats }
  | { ok: false; reason: "open"; failure: RootFileOpenFailure }
  | { ok: false; reason: "not-file" | "not-object" | "parse"; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readRootJsonObjectSync(params: {
  rootDir: string;
  rootRealPath?: string;
  relativePath: string;
  boundaryLabel: string;
  rejectHardlinks?: boolean;
  requireFile?: boolean;
}): RootJsonObjectReadResult {
  const absolutePath = path.resolve(params.rootDir, params.relativePath);
  const opened = openRootFileSync({
    absolutePath,
    rootPath: params.rootDir,
    ...(params.rootRealPath !== undefined ? { rootRealPath: params.rootRealPath } : {}),
    boundaryLabel: params.boundaryLabel,
    rejectHardlinks: params.rejectHardlinks,
  });
  if (!opened.ok) {
    return { ok: false, reason: "open", failure: opened };
  }

  try {
    const stat = fs.fstatSync(opened.fd);
    if (params.requireFile === true && !stat.isFile()) {
      return { ok: false, reason: "not-file", error: `${params.relativePath} must be a file` };
    }
    const raw = JSON.parse(fs.readFileSync(opened.fd, "utf-8")) as unknown;
    if (!isRecord(raw)) {
      return {
        ok: false,
        reason: "not-object",
        error: `${params.relativePath} must contain a JSON object`,
      };
    }
    return { ok: true, raw, stat };
  } catch (error) {
    return {
      ok: false,
      reason: "parse",
      error: `failed to parse ${params.relativePath}: ${String(error)}`,
    };
  } finally {
    fs.closeSync(opened.fd);
  }
}
