import fsp from "node:fs/promises";
import path from "node:path";
import { MAX_WORKSPACE_MANIFEST_BYTES } from "../gateway/worker-environments/workspace-inventory-limits.js";
import type { WorkerWorkspaceManifestEntry } from "../gateway/worker-environments/workspace-manifest.js";
import {
  WorkerWorkspaceGitHistorySchema,
  type WorkerWorkspaceGitHistory,
} from "../gateway/worker-environments/workspace-result-inventory.js";
import { runExec } from "../process/exec.js";
import { NODE_WORKSPACE_GIT_HISTORY_SCRIPT } from "../worker/node-workspace-transfer-protocol.js";
import {
  runWorkspaceCommand,
  TRANSFER_TIMEOUT_MS,
  workspaceCommandEnv,
} from "./node-worker-workspace-commands.js";

export async function initializeNodeWorkerGitWorkspace(params: {
  workspaceDir: string;
  manifestHome: string;
  packPath?: string;
  baseCommit: string;
  entries: WorkerWorkspaceManifestEntry[];
  signal?: AbortSignal;
}): Promise<void> {
  const objectFormat = params.baseCommit.length === 40 ? "sha1" : "sha256";
  const gitPrefix = process.platform === "win32" ? ["-c", "core.longpaths=true"] : [];
  const git = (args: string[], options: { input?: string; maxOutputBytes?: number } = {}) =>
    runWorkspaceCommand({
      workspaceDir: params.workspaceDir,
      homeDir: params.manifestHome,
      argv: ["git", ...gitPrefix, "-C", params.workspaceDir, ...args],
      input: options.input,
      signal: params.signal,
      maxOutputBytes: options.maxOutputBytes,
    });
  await git(["init", "--quiet", `--object-format=${objectFormat}`, "."]);
  if (process.platform === "win32") {
    // Manifest capture and later worker Git commands reuse this private repository.
    await git(["config", "--local", "core.longpaths", "true"]);
  }
  if (params.packPath) {
    const pack = await fsp.open(params.packPath, "r");
    try {
      await runExec("git", [...gitPrefix, "-C", params.workspaceDir, "index-pack", "--stdin"], {
        cwd: params.workspaceDir,
        baseEnv: workspaceCommandEnv(params.manifestHome),
        stdinFileDescriptor: pack.fd,
        signal: params.signal,
        timeoutMs: TRANSFER_TIMEOUT_MS,
        maxBuffer: 256 * 1024,
        logOutput: false,
      });
    } finally {
      await pack.close();
    }
    await fsp.rm(params.packPath, { force: true });
  }
  await fsp.writeFile(path.join(params.workspaceDir, ".git", "shallow"), `${params.baseCommit}\n`);
  const actual = (await git(["rev-parse", "--verify", `${params.baseCommit}^{commit}`])).trim();
  if (actual !== params.baseCommit) {
    throw new Error("workspace transfer Git base does not match the prepared objects");
  }
  await git(["update-ref", "refs/heads/openclaw-worker", params.baseCommit]);
  await git(["symbolic-ref", "HEAD", "refs/heads/openclaw-worker"]);
  await git(["read-tree", params.baseCommit]);
  const index = await git(["ls-files", "--stage", "-z"], {
    maxOutputBytes: MAX_WORKSPACE_MANIFEST_BYTES,
  });
  const gitlinks: string[] = [];
  const basePaths = new Set<string>();
  for (const record of index.split("\0").filter(Boolean)) {
    const separator = record.indexOf("\t");
    if (separator < 0) {
      continue;
    }
    const indexedPath = record.slice(separator + 1);
    if (record.startsWith("160000 ")) {
      gitlinks.push(indexedPath);
    } else {
      basePaths.add(indexedPath);
    }
  }
  if (gitlinks.length > 0) {
    await git(["update-index", "--skip-worktree", "-z", "--stdin"], {
      input: `${gitlinks.join("\0")}\0`,
    });
  }
  const checkoutPaths = params.entries
    .map((entry) => entry.path)
    .filter((entryPath) => basePaths.has(entryPath));
  if (checkoutPaths.length > 0) {
    await git(["checkout-index", "-z", "--stdin"], {
      input: `${checkoutPaths.join("\0")}\0`,
    });
  }
}

/** Capture immutable worker commits and stream their versioned upload trailer. */
export async function prepareNodeWorkerGitResult(params: {
  resultVersion?: 2;
  workspaceDir: string;
  manifestHome: string;
  baseCommit: string | null;
  packPath: string;
  signal?: AbortSignal;
}) {
  if (params.resultVersion !== 2) {
    return undefined;
  }
  let history: WorkerWorkspaceGitHistory | undefined;
  try {
    history = params.baseCommit
      ? WorkerWorkspaceGitHistorySchema.parse(
          JSON.parse(
            await runWorkspaceCommand({
              workspaceDir: params.workspaceDir,
              homeDir: params.manifestHome,
              argv: [
                "node",
                "-e",
                NODE_WORKSPACE_GIT_HISTORY_SCRIPT,
                params.workspaceDir,
                params.baseCommit,
                params.packPath,
              ],
              signal: params.signal,
            }),
          ),
        )
      : undefined;
  } catch {
    params.signal?.throwIfAborted();
    if (params.baseCommit) {
      history = {
        baseCommit: params.baseCommit,
        headCommit: params.baseCommit,
        descendsFromBase: false,
        unavailableReason: "worker Git history is unavailable",
      };
    }
  }
  const packBytes =
    history?.descendsFromBase &&
    !history.unavailableReason &&
    history.headCommit !== history.baseCommit
      ? (await fsp.stat(params.packPath)).size
      : 0;
  const metadata = Buffer.from(JSON.stringify(history ?? null));
  return {
    byteLength: 4 + metadata.byteLength + 8 + packBytes,
    async write(write: (bytes: Buffer) => Promise<void>, signal?: AbortSignal) {
      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(metadata.byteLength);
      await write(header);
      await write(metadata);
      const size = Buffer.allocUnsafe(8);
      size.writeBigUInt64BE(BigInt(packBytes));
      await write(size);
      if (packBytes) {
        await using handle = await fsp.open(params.packPath, "r");
        for await (const value of handle.createReadStream({ autoClose: false, signal })) {
          await write(Buffer.isBuffer(value) ? value : Buffer.from(value));
        }
      }
    },
  };
}
