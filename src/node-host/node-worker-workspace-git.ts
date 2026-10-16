import fsp from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { WorkerWorkspaceManifestEntry } from "../gateway/worker-environments/workspace-manifest.js";
import { runCommandWithTimeout, runExec } from "../process/exec.js";
import {
  runWorkspaceCommand,
  TRANSFER_TIMEOUT_MS,
  workspaceCommandEnv,
} from "./node-worker-workspace-commands.js";

/**
 * Stream-parse `git ls-files --stage -z` without buffering the full listing.
 * Completeness comes from a clean Git exit; retained state is bounded to gitlink
 * paths plus the caller's wanted checkout paths.
 */
async function readWorkspaceGitIndex(params: {
  workspaceDir: string;
  homeDir: string;
  gitPrefix: string[];
  wantedPaths: ReadonlySet<string>;
  signal?: AbortSignal;
}): Promise<{ gitlinks: string[]; basePaths: Set<string> }> {
  const gitlinks: string[] = [];
  const basePaths = new Set<string>();
  const decoder = new StringDecoder("utf8");
  let pending = "";

  const consumeRecord = (record: string) => {
    if (!record) {
      return;
    }
    const separator = record.indexOf("\t");
    if (separator < 0) {
      return;
    }
    const indexedPath = record.slice(separator + 1);
    if (record.startsWith("160000 ")) {
      gitlinks.push(indexedPath);
      return;
    }
    if (params.wantedPaths.has(indexedPath)) {
      basePaths.add(indexedPath);
    }
  };

  const result = await runCommandWithTimeout(
    ["git", ...params.gitPrefix, "-C", params.workspaceDir, "ls-files", "--stage", "-z"],
    {
      cwd: params.workspaceDir,
      baseEnv: workspaceCommandEnv(params.homeDir),
      timeoutMs: TRANSFER_TIMEOUT_MS,
      signal: params.signal,
      // Discard retained stdout; records are consumed through the observer.
      outputCapture: { stdout: "discard", stderr: "tail" },
      maxOutputBytes: { stdout: Number.MAX_SAFE_INTEGER, stderr: 128 * 1024 },
      onOutputChunk: (chunk, stream) => {
        if (stream !== "stdout") {
          return;
        }
        pending += decoder.write(chunk);
        let separator = pending.indexOf("\0");
        while (separator >= 0) {
          consumeRecord(pending.slice(0, separator));
          pending = pending.slice(separator + 1);
          separator = pending.indexOf("\0");
        }
      },
    },
  );
  pending += decoder.end();
  if (pending) {
    consumeRecord(pending);
  }
  if (result.termination !== "exit" || result.code !== 0) {
    throw new Error(`workspace transfer apply failed: ${(result.stderr || "").trim()}`);
  }
  return { gitlinks, basePaths };
}

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
  const wantedPaths = new Set(params.entries.map((entry) => entry.path));
  const { gitlinks, basePaths } = await readWorkspaceGitIndex({
    workspaceDir: params.workspaceDir,
    homeDir: params.manifestHome,
    gitPrefix,
    wantedPaths,
    signal: params.signal,
  });
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
