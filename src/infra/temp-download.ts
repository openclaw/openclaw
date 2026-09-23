// Creates private temporary workspaces for downloads.
import "./fs-safe-defaults.js";
import path from "node:path";
import {
  buildRandomTempFilePath as buildRandomTempFilePathBase,
  sanitizeTempFileName,
} from "@openclaw/fs-safe/advanced";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { tempWorkspace } from "./private-temp-workspace.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

const logger = createSubsystemLogger("infra:temp-download");

export { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";
export { sanitizeTempFileName };

// Download targets expose both a default path and a name-safe file builder so
// callers can keep all transient files inside the same workspace.
type TempDownloadTarget = {
  dir: string;
  path: string;
  file(fileName?: string): string;
  cleanup: () => Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

function resolveTempRoot(tmpDir?: string): string {
  return tmpDir ?? resolvePreferredOpenClawTmpDir();
}

function sanitizeTempPrefix(prefix: string): string {
  const normalized = prefix.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "tmp";
}

/** Build a stable temp path shape while keeping caller-controlled text filename-safe. */
export function buildRandomTempFilePath(params: {
  prefix: string;
  extension?: string;
  tmpDir?: string;
  now?: number;
  uuid?: string;
}): string {
  const rootDir = resolveTempRoot(params.tmpDir);
  const filePath = buildRandomTempFilePathBase({
    ...params,
    rootDir,
    uuid: params.uuid?.trim() || undefined,
  });
  return path.join(rootDir, path.basename(filePath));
}

export async function createTempDownloadTarget(params: {
  prefix: string;
  fileName?: string;
  tmpDir?: string;
}): Promise<TempDownloadTarget> {
  const workspace = await tempWorkspace({
    rootDir: resolveTempRoot(params.tmpDir),
    prefix: sanitizeTempPrefix(params.prefix),
  });
  const fileName = params.fileName;
  const file = (nextName?: string) =>
    workspace.path(sanitizeTempFileName(nextName ?? fileName ?? "download.bin"));
  const cleanup = async () => {
    try {
      await workspace.cleanup();
    } catch (err) {
      logger.warn(`temp-path cleanup failed: ${String(err)}`, { error: err });
    }
  };
  return {
    dir: workspace.dir,
    path: file(),
    file,
    cleanup,
    [Symbol.asyncDispose]: cleanup,
  };
}

/** Run with a private temp download path and always attempt workspace cleanup. */
export async function withTempDownloadPath<T>(
  params: {
    prefix: string;
    fileName?: string;
    tmpDir?: string;
  },
  fn: (tmpPath: string) => Promise<T>,
): Promise<T> {
  const target = await createTempDownloadTarget(params);
  try {
    return await fn(target.path);
  } finally {
    await target.cleanup();
  }
}
