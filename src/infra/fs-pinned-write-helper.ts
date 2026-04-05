import { spawn } from "node:child_process";
import { once } from "node:events";
import fsSync, { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FileIdentityStat } from "./file-identity.js";

const SUPPORTS_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in fsConstants;
const FALLBACK_WRITE_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);

export type PinnedWriteInput =
  | { kind: "buffer"; data: string | Buffer; encoding?: BufferEncoding }
  | { kind: "stream"; stream: Readable };

const LOCAL_PINNED_WRITE_PYTHON = [
  "import errno",
  "import os",
  "import secrets",
  "import stat",
  "import sys",
  "",
  "root_path = sys.argv[1]",
  "relative_parent = sys.argv[2]",
  "basename = sys.argv[3]",
  'mkdir_enabled = sys.argv[4] == "1"',
  "file_mode = int(sys.argv[5], 8)",
  "",
  "DIR_FLAGS = os.O_RDONLY",
  "if hasattr(os, 'O_DIRECTORY'):",
  "    DIR_FLAGS |= os.O_DIRECTORY",
  "if hasattr(os, 'O_NOFOLLOW'):",
  "    DIR_FLAGS |= os.O_NOFOLLOW",
  "",
  "WRITE_FLAGS = os.O_WRONLY | os.O_CREAT | os.O_EXCL",
  "if hasattr(os, 'O_NOFOLLOW'):",
  "    WRITE_FLAGS |= os.O_NOFOLLOW",
  "",
  "def open_dir(path_value, dir_fd=None):",
  "    return os.open(path_value, DIR_FLAGS, dir_fd=dir_fd)",
  "",
  "def walk_parent(root_fd, rel_parent, mkdir_enabled):",
  "    current_fd = os.dup(root_fd)",
  "    try:",
  "        for segment in [part for part in rel_parent.split('/') if part and part != '.']:",
  "            if segment == '..':",
  "                raise OSError(errno.EPERM, 'path traversal is not allowed', segment)",
  "            try:",
  "                next_fd = open_dir(segment, dir_fd=current_fd)",
  "            except FileNotFoundError:",
  "                if not mkdir_enabled:",
  "                    raise",
  "                os.mkdir(segment, 0o777, dir_fd=current_fd)",
  "                next_fd = open_dir(segment, dir_fd=current_fd)",
  "            os.close(current_fd)",
  "            current_fd = next_fd",
  "        return current_fd",
  "    except Exception:",
  "        os.close(current_fd)",
  "        raise",
  "",
  "def create_temp_file(parent_fd, basename, mode):",
  "    prefix = '.' + basename + '.'",
  "    for _ in range(128):",
  "        candidate = prefix + secrets.token_hex(6) + '.tmp'",
  "        try:",
  "            fd = os.open(candidate, WRITE_FLAGS, mode, dir_fd=parent_fd)",
  "            return candidate, fd",
  "        except FileExistsError:",
  "            continue",
  "    raise RuntimeError('failed to allocate pinned temp file')",
  "",
  "root_fd = open_dir(root_path)",
  "parent_fd = None",
  "temp_fd = None",
  "temp_name = None",
  "try:",
  "    parent_fd = walk_parent(root_fd, relative_parent, mkdir_enabled)",
  "    temp_name, temp_fd = create_temp_file(parent_fd, basename, file_mode)",
  "    while True:",
  "        chunk = sys.stdin.buffer.read(65536)",
  "        if not chunk:",
  "            break",
  "        os.write(temp_fd, chunk)",
  "    os.fsync(temp_fd)",
  "    os.close(temp_fd)",
  "    temp_fd = None",
  "    os.replace(temp_name, basename, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)",
  "    temp_name = None",
  "    os.fsync(parent_fd)",
  "    result_stat = os.stat(basename, dir_fd=parent_fd, follow_symlinks=False)",
  "    print(f'{result_stat.st_dev}|{result_stat.st_ino}')",
  "finally:",
  "    if temp_fd is not None:",
  "        os.close(temp_fd)",
  "    if temp_name is not None and parent_fd is not None:",
  "        try:",
  "            os.unlink(temp_name, dir_fd=parent_fd)",
  "        except FileNotFoundError:",
  "            pass",
  "    if parent_fd is not None:",
  "        os.close(parent_fd)",
  "    os.close(root_fd)",
].join("\n");

const LOCAL_PINNED_UNLINK_PYTHON = [
  "import os",
  "import sys",
  "",
  "root_path = sys.argv[1]",
  "relative_parent = sys.argv[2]",
  "basename = sys.argv[3]",
  "",
  "DIR_FLAGS = os.O_RDONLY",
  "if hasattr(os, 'O_DIRECTORY'):",
  "    DIR_FLAGS |= os.O_DIRECTORY",
  "if hasattr(os, 'O_NOFOLLOW'):",
  "    DIR_FLAGS |= os.O_NOFOLLOW",
  "",
  "def open_dir(path_value, dir_fd=None):",
  "    return os.open(path_value, DIR_FLAGS, dir_fd=dir_fd)",
  "",
  "def walk_parent(root_fd, rel_parent):",
  "    current_fd = os.dup(root_fd)",
  "    try:",
  "        for segment in [part for part in rel_parent.split('/') if part and part != '.']:",
  "            if segment == '..':",
  "                raise OSError('path traversal is not allowed')",
  "            next_fd = open_dir(segment, dir_fd=current_fd)",
  "            os.close(current_fd)",
  "            current_fd = next_fd",
  "        return current_fd",
  "    except Exception:",
  "        os.close(current_fd)",
  "        raise",
  "",
  "root_fd = open_dir(root_path)",
  "parent_fd = None",
  "try:",
  "    parent_fd = walk_parent(root_fd, relative_parent)",
  "    os.unlink(basename, dir_fd=parent_fd)",
  "    os.fsync(parent_fd)",
  "finally:",
  "    if parent_fd is not None:",
  "        os.close(parent_fd)",
  "    os.close(root_fd)",
].join("\n");

const PINNED_WRITE_PYTHON_CANDIDATES = [
  process.env.OPENCLAW_PINNED_WRITE_PYTHON,
  "/usr/bin/python3",
  "/opt/homebrew/bin/python3",
  "/usr/local/bin/python3",
].filter((value): value is string => Boolean(value));

let cachedPinnedWritePython = "";

function canExecute(binPath: string): boolean {
  try {
    fsSync.accessSync(binPath, fsSync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePinnedWritePython(): string {
  if (cachedPinnedWritePython) {
    return cachedPinnedWritePython;
  }
  for (const candidate of PINNED_WRITE_PYTHON_CANDIDATES) {
    if (canExecute(candidate)) {
      cachedPinnedWritePython = candidate;
      return cachedPinnedWritePython;
    }
  }
  cachedPinnedWritePython = "python3";
  return cachedPinnedWritePython;
}

function parsePinnedIdentity(stdout: string): FileIdentityStat {
  const line = stdout
    .trim()
    .split(/\r?\n/)
    .map((value) => value.trim())
    .findLast(Boolean);
  if (!line) {
    throw new Error("Pinned write helper returned no identity");
  }
  const [devRaw, inoRaw] = line.split("|");
  const dev = Number.parseInt(devRaw ?? "", 10);
  const ino = Number.parseInt(inoRaw ?? "", 10);
  if (!Number.isFinite(dev) || !Number.isFinite(ino)) {
    throw new Error(`Pinned write helper returned invalid identity: ${line}`);
  }
  return { dev, ino };
}

function trackSpawnLifecycle(child: ReturnType<typeof spawn>): {
  exitPromise: Promise<[number | null, NodeJS.Signals | null]>;
  errorPromise: Promise<never>;
  getSpawnError: () => Error | null;
} {
  let spawnError: Error | null = null;
  const exitPromise = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
  const errorPromise = new Promise<never>((_, reject) => {
    child.once("error", (error) => {
      spawnError = error instanceof Error ? error : new Error(String(error));
      reject(spawnError);
    });
  });
  return {
    exitPromise,
    errorPromise,
    getSpawnError: () => spawnError,
  };
}

function createPinnedUnlinkSpawnError(error: Error): Error {
  return new Error(`Pinned unlink helper failed to start: ${error.message}`, {
    cause: error,
  });
}

export async function runPinnedWriteHelper(params: {
  rootPath: string;
  relativeParentPath: string;
  basename: string;
  mkdir: boolean;
  mode: number;
  input: PinnedWriteInput;
}): Promise<FileIdentityStat> {
  const child = spawn(
    resolvePinnedWritePython(),
    [
      "-c",
      LOCAL_PINNED_WRITE_PYTHON,
      params.rootPath,
      params.relativeParentPath,
      params.basename,
      params.mkdir ? "1" : "0",
      (params.mode || 0o600).toString(8),
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding?.("utf8");
  child.stderr.setEncoding?.("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const { exitPromise, errorPromise, getSpawnError } = trackSpawnLifecycle(child);
  let inputStarted = false;
  try {
    if (!child.stdin) {
      const identity = await runPinnedWriteFallback(params);
      await exitPromise.catch(() => {});
      return identity;
    }

    if (params.input.kind === "buffer") {
      const input = params.input;
      inputStarted = true;
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          child.stdin.once("error", reject);
          if (typeof input.data === "string") {
            child.stdin.end(input.data, input.encoding ?? "utf8", () => resolve());
            return;
          }
          child.stdin.end(input.data, () => resolve());
        }),
        errorPromise,
      ]);
    } else {
      inputStarted = true;
      await Promise.race([pipeline(params.input.stream, child.stdin), errorPromise]);
    }

    const [code, signal] = await Promise.race([exitPromise, errorPromise]);
    if (code !== 0) {
      throw new Error(
        stderr.trim() ||
          `Pinned write helper failed with code ${code ?? "null"} (${signal ?? "?"})`,
      );
    }
    return parsePinnedIdentity(stdout);
  } catch (error) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Best-effort cleanup only.
    }
    await exitPromise.catch(() => {});

    if (getSpawnError() && (params.input.kind === "buffer" || !inputStarted)) {
      return await runPinnedWriteFallback(params);
    }

    throw error;
  }
}

export async function runPinnedUnlinkHelper(params: {
  rootPath: string;
  relativeParentPath: string;
  basename: string;
}): Promise<void> {
  const child = spawn(
    resolvePinnedWritePython(),
    ["-c", LOCAL_PINNED_UNLINK_PYTHON, params.rootPath, params.relativeParentPath, params.basename],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stderr = "";
  child.stderr.setEncoding?.("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const { exitPromise, errorPromise, getSpawnError } = trackSpawnLifecycle(child);
  try {
    const [code, signal] = await Promise.race([exitPromise, errorPromise]);
    if (code !== 0) {
      throw new Error(
        stderr.trim() ||
          `Pinned unlink helper failed with code ${code ?? "null"} (${signal ?? "?"})`,
      );
    }
  } catch (error) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Best-effort cleanup only.
    }
    await exitPromise.catch(() => {});
    const spawnError = getSpawnError();
    if (spawnError) {
      throw createPinnedUnlinkSpawnError(spawnError);
    }
    throw error;
  }
}

async function runPinnedWriteFallback(params: {
  rootPath: string;
  relativeParentPath: string;
  basename: string;
  mkdir: boolean;
  mode: number;
  input: PinnedWriteInput;
}): Promise<FileIdentityStat> {
  const parentPath = params.relativeParentPath
    ? path.join(params.rootPath, ...params.relativeParentPath.split("/"))
    : params.rootPath;
  if (params.mkdir) {
    await fs.mkdir(parentPath, { recursive: true });
  }
  const targetPath = path.join(parentPath, params.basename);
  const tempPath = path.join(parentPath, `.${params.basename}.fallback.tmp`);
  // Remove any pre-existing temp file to allow O_EXCL to succeed on retry.
  await fs.unlink(tempPath).catch(() => {});
  // Open with O_CREAT | O_EXCL | O_NOFOLLOW to reject symlinks at the temp path,
  // preventing a pre-placed symlink from redirecting writes outside the root.
  const handle = await fs.open(tempPath, FALLBACK_WRITE_FLAGS, params.mode);
  try {
    if (params.input.kind === "buffer") {
      await handle.writeFile(params.input.data, {
        encoding: params.input.encoding ?? "utf8",
      });
    } else {
      await pipeline(params.input.stream, handle.createWriteStream());
    }
  } finally {
    await handle.close().catch(() => {});
  }
  await fs.rename(tempPath, targetPath);
  const stat = await fs.stat(targetPath);
  return { dev: stat.dev, ino: stat.ino };
}
