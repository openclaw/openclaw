import type fs from "node:fs";
import path from "node:path";
import { replaceFileAtomic, replaceFileAtomicSync } from "@openclaw/fs-safe/atomic";
import {
  commitRecoveryFileIfCurrent,
  type ConfigRecoveryEffect,
} from "./io.observe-recovery-effects.js";
import type { NormalizedConfigIoDeps } from "./io.read.types.js";

export function createRecoveryCommitEffect(params: {
  deps: Pick<NormalizedConfigIoDeps, "fs">;
  configPath: string;
  raw: string;
  beforeCommit?: () => void;
}): ConfigRecoveryEffect<boolean> {
  const options = {
    filePath: params.configPath,
    content: params.raw,
    dirMode: 0o700,
    mode: 0o600,
    tempPrefix: path.basename(params.configPath),
    fileSystem: params.deps.fs,
  };
  return {
    sync: () => {
      replaceFileAtomicSync(options);
      return true;
    },
    async: (health) =>
      commitRecoveryFileIfCurrent({
        health,
        beforeCommit: params.beforeCommit,
        write: (assertCurrent) =>
          replaceFileAtomic({
            ...options,
            // Every rename attempt must revalidate; copy fallback has no final guard.
            copyFallbackOnPermissionError: false,
            fileSystem: {
              promises: {
                ...params.deps.fs.promises,
                rename: (source: fs.PathLike, destination: fs.PathLike) => {
                  assertCurrent();
                  return params.deps.fs.promises.rename(source, destination);
                },
              },
            },
          }),
      }),
  };
}
