import type fs from "node:fs";
import path from "node:path";
import { withFileLock } from "../infra/file-lock.js";
import { replaceFileAtomic } from "../infra/replace-file.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";

const CONFIG_WRITE_COMMIT_LOCK_OPTIONS = {
  retries: { retries: 240, factor: 1.1, minTimeout: 25, maxTimeout: 500, randomize: true },
  stale: 300_000,
} as const;
const configWriteCommitQueue = new KeyedAsyncQueue();

export async function createWorkspacePluginDirectory(
  fsModule: typeof fs,
  pluginPath: string,
): Promise<string[]> {
  const firstCreated = await fsModule.promises.mkdir(pluginPath, {
    recursive: true,
    mode: 0o700,
  });
  if (!firstCreated) {
    return [];
  }
  const created: string[] = [];
  for (let current = path.resolve(pluginPath); ; current = path.dirname(current)) {
    created.push(current);
    if (current === path.resolve(firstCreated)) {
      return created;
    }
  }
}

export async function removeEmptyWorkspacePluginDirectories(
  fsModule: typeof fs,
  createdPaths: readonly string[],
): Promise<void> {
  for (const createdPath of createdPaths) {
    await fsModule.promises.rmdir(createdPath).catch(() => {});
  }
}

export async function commitConfigFileWrite(params: {
  configPath: string;
  content: string;
  fsModule: typeof fs;
  beforeRename: () => Promise<void>;
}) {
  // All writers share this short commit lock. It closes the await window between
  // the final snapshot fence, cron handoff, and atomic rename without serializing preflight.
  return await configWriteCommitQueue.enqueue(
    params.configPath,
    async () =>
      await withFileLock(
        `${params.configPath}.commit`,
        CONFIG_WRITE_COMMIT_LOCK_OPTIONS,
        async () =>
          await replaceFileAtomic({
            filePath: params.configPath,
            content: params.content,
            dirMode: 0o700,
            mode: 0o600,
            tempPrefix: path.basename(params.configPath),
            copyFallbackOnPermissionError: true,
            fileSystem: params.fsModule,
            beforeRename: params.beforeRename,
          }),
      ),
  );
}
