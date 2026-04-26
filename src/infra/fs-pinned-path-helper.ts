import { spawn } from "node:child_process";
import fsSync from "node:fs";

const LOCAL_PINNED_PATH_PYTHON = [
  "import errno",
  "import os",
  "import stat",
  "import sys",
  "",
  "operation = sys.argv[1]",
  "root_path = sys.argv[2]",
  "relative_path = sys.argv[3]",
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
  "def split_segments(relative_path):",
  "    return [part for part in relative_path.split('/') if part and part != '.']",
  "",
  "def validate_segment(segment):",
  "    if segment == '..':",
  "        raise OSError(errno.EPERM, 'path traversal is not allowed', segment)",
  "",
  "def walk_existing_path(root_fd, segments):",
  "    current_fd = os.dup(root_fd)",
  "    try:",
  "        for segment in segments:",
  "            validate_segment(segment)",
  "            next_fd = open_dir(segment, dir_fd=current_fd)",
  "            os.close(current_fd)",
  "            current_fd = next_fd",
  "        return current_fd",
  "    except Exception:",
  "        os.close(current_fd)",
  "        raise",
  "",
  "def mkdirp_within_root(root_fd, segments):",
  "    current_fd = os.dup(root_fd)",
  "    try:",
  "        for segment in segments:",
  "            validate_segment(segment)",
  "            try:",
  "                next_fd = open_dir(segment, dir_fd=current_fd)",
  "            except FileNotFoundError:",
  "                os.mkdir(segment, 0o777, dir_fd=current_fd)",
  "                next_fd = open_dir(segment, dir_fd=current_fd)",
  "            os.close(current_fd)",
  "            current_fd = next_fd",
  "    finally:",
  "        os.close(current_fd)",
  "",
  "def remove_within_root(root_fd, segments):",
  "    if not segments:",
  "        raise OSError(errno.EPERM, 'refusing to remove root path')",
  "    parent_segments = segments[:-1]",
  "    basename = segments[-1]",
  "    validate_segment(basename)",
  "    parent_fd = walk_existing_path(root_fd, parent_segments)",
  "    try:",
  "        target_stat = os.lstat(basename, dir_fd=parent_fd)",
  "        if stat.S_ISDIR(target_stat.st_mode) and not stat.S_ISLNK(target_stat.st_mode):",
  "            os.rmdir(basename, dir_fd=parent_fd)",
  "        else:",
  "            os.unlink(basename, dir_fd=parent_fd)",
  "    finally:",
  "        os.close(parent_fd)",
  "",
  "root_fd = open_dir(root_path)",
  "try:",
  "    segments = split_segments(relative_path)",
  "    if operation == 'mkdirp':",
  "        mkdirp_within_root(root_fd, segments)",
  "    elif operation == 'remove':",
  "        remove_within_root(root_fd, segments)",
  "    else:",
  "        raise RuntimeError(f'unknown pinned path operation: {operation}')",
  "finally:",
  "    os.close(root_fd)",
].join("\n");

const PINNED_PATH_PYTHON_CANDIDATES = [
  process.env.OPENCLAW_PINNED_PYTHON,
  // Keep the write-specific alias for backwards compatibility.
  process.env.OPENCLAW_PINNED_WRITE_PYTHON,
  "/usr/bin/python3",
  "/opt/homebrew/bin/python3",
  "/usr/local/bin/python3",
].filter((value): value is string => Boolean(value));

let cachedPinnedPathPython = "";

function canExecute(binPath: string): boolean {
  try {
    fsSync.accessSync(binPath, fsSync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePinnedPathPython(): string {
  if (cachedPinnedPathPython) {
    return cachedPinnedPathPython;
  }
  for (const candidate of PINNED_PATH_PYTHON_CANDIDATES) {
    if (canExecute(candidate)) {
      cachedPinnedPathPython = candidate;
      return cachedPinnedPathPython;
    }
  }
  cachedPinnedPathPython = "python3";
  return cachedPinnedPathPython;
}

function buildPinnedPathError(stderr: string, code: number | null, signal: NodeJS.Signals | null) {
  return new Error(
    stderr.trim() || `Pinned path helper failed with code ${code ?? "null"} (${signal ?? "?"})`,
  );
}

export function isPinnedPathHelperSpawnError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const maybeErrno = error as NodeJS.ErrnoException;
  if (typeof maybeErrno.syscall !== "string" || !maybeErrno.syscall.startsWith("spawn")) {
    return false;
  }

  return ["EACCES", "ENOENT", "ENOEXEC"].includes(maybeErrno.code ?? "");
}

export async function runPinnedPathHelper(params: {
  operation: "mkdirp" | "remove";
  rootPath: string;
  relativePath: string;
}): Promise<void> {
  const child = spawn(
    resolvePinnedPathPython(),
    ["-c", LOCAL_PINNED_PATH_PYTHON, params.operation, params.rootPath, params.relativePath],
    {
      stdio: ["ignore", "ignore", "pipe"],
    },
  );

  let stderr = "";
  child.stderr.setEncoding?.("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
    },
  );
  if (code !== 0) {
    throw buildPinnedPathError(stderr, code, signal);
  }
}
