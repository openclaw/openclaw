import "./fs-safe-defaults.js";
import {
  buildRandomTempFilePath as buildRandomTempFilePathInRoot,
  sanitizeTempFileName,
  type TempFile,
  tempFile,
  withTempFile,
} from "@openclaw/fs-safe/advanced";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

const logger = createSubsystemLogger("infra:temp-download");

export { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";
export { sanitizeTempFileName };

type TempDownloadTarget = TempFile;

function resolveTempRoot(tmpDir?: string): string {
  return tmpDir ?? resolvePreferredOpenClawTmpDir();
}

export function buildRandomTempFilePath(params: {
  prefix: string;
  extension?: string;
  tmpDir?: string;
  now?: number;
  uuid?: string;
}): string {
  return buildRandomTempFilePathInRoot({
    rootDir: resolveTempRoot(params.tmpDir),
    prefix: params.prefix,
    extension: params.extension,
    now: params.now,
    uuid: params.uuid,
  });
}

export async function createTempDownloadTarget(params: {
  prefix: string;
  fileName?: string;
  tmpDir?: string;
}): Promise<TempDownloadTarget> {
  return await tempFile({
    rootDir: resolveTempRoot(params.tmpDir),
    prefix: params.prefix,
    fileName: params.fileName,
    onCleanupError: (err) => {
      logger.warn(`temp-path cleanup failed: ${String(err)}`, { error: err });
    },
  });
}

export async function withTempDownloadPath<T>(
  params: {
    prefix: string;
    fileName?: string;
    tmpDir?: string;
  },
  fn: (tmpPath: string) => Promise<T>,
): Promise<T> {
  return await withTempFile(
    {
      rootDir: resolveTempRoot(params.tmpDir),
      prefix: params.prefix,
      fileName: params.fileName,
      onCleanupError: (err) => {
        logger.warn(`temp-path cleanup failed: ${String(err)}`, { error: err });
      },
    },
    fn,
  );
}
