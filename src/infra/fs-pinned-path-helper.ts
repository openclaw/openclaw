import { spawn } from "node:child_process";
import fsSync from "node:fs";

const LOCAL_PINNED_PATH_PYTHON = [
  "import errno",
  "import json",
  "import os",
  "import stat",
  "import sys",
  "",
  "operation = sys.argv[1]",
  "root_path = sys.argv[2]",
  "relative_path = sys.argv[3]",
  "to_relative_path = sys.argv[4] if len(sys.argv) > 4 else ''",
  "overwrite = len(sys.argv) > 5 and sys.argv[5] == '1'",
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
  "def mkdirp_within_root_fd(root_fd, segments):",
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
  "        return current_fd",
  "    except Exception:",
  "        os.close(current_fd)",
  "        raise",
  "",
  "def mkdirp_within_root(root_fd, segments):",
  "    fd = mkdirp_within_root_fd(root_fd, segments)",
  "    os.close(fd)",
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
  "def readdir_within_root(root_fd, segments):",
  "    dir_fd = walk_existing_path(root_fd, segments)",
  "    try:",
  "        print(json.dumps(sorted(os.listdir(dir_fd))))",
  "    finally:",
  "        os.close(dir_fd)",
  "",
  "def stat_within_root(root_fd, segments, follow_symlinks):",
  "    if not segments:",
  "        target_stat = os.fstat(root_fd)",
  "    else:",
  "        parent_fd = walk_existing_path(root_fd, segments[:-1])",
  "        try:",
  "            basename = segments[-1]",
  "            validate_segment(basename)",
  "            target_stat = os.stat(basename, dir_fd=parent_fd, follow_symlinks=follow_symlinks)",
  "        finally:",
  "            os.close(parent_fd)",
  "    print(json.dumps({",
  "        'dev': getattr(target_stat, 'st_dev', 0),",
  "        'ino': getattr(target_stat, 'st_ino', 0),",
  "        'nlink': getattr(target_stat, 'st_nlink', 0),",
  "        'uid': getattr(target_stat, 'st_uid', 0),",
  "        'gid': getattr(target_stat, 'st_gid', 0),",
  "        'rdev': getattr(target_stat, 'st_rdev', 0),",
  "        'blksize': getattr(target_stat, 'st_blksize', 0),",
  "        'blocks': getattr(target_stat, 'st_blocks', 0),",
  "        'mode': target_stat.st_mode,",
  "        'size': target_stat.st_size,",
  "        'mtimeMs': target_stat.st_mtime_ns / 1000000,",
  "        'ctimeMs': target_stat.st_ctime_ns / 1000000,",
  "        'atimeMs': target_stat.st_atime_ns / 1000000,",
  "        'birthtimeMs': getattr(target_stat, 'st_birthtime', target_stat.st_ctime) * 1000,",
  "    }))",
  "",
  "def maybe_apply_rename_test_race(point, source_parent_fd, source_basename):",
  "    raw = os.environ.get('OPENCLAW_TEST_PINNED_PATH_HELPER_RACE')",
  "    if not raw:",
  "        return",
  "    try:",
  "        payload = json.loads(raw)",
  "    except Exception:",
  "        return",
  "    if payload.get('point') != point:",
  "        return",
  "    if payload.get('action') != 'replace-source-with-symlink':",
  "        return",
  "    target = payload.get('target')",
  "    if not isinstance(target, str):",
  "        return",
  "    try:",
  "        current_stat = os.lstat(source_basename, dir_fd=source_parent_fd)",
  "        if stat.S_ISDIR(current_stat.st_mode) and not stat.S_ISLNK(current_stat.st_mode):",
  "            os.rmdir(source_basename, dir_fd=source_parent_fd)",
  "        else:",
  "            os.unlink(source_basename, dir_fd=source_parent_fd)",
  "    except FileNotFoundError:",
  "        pass",
  "    os.symlink(target, source_basename, dir_fd=source_parent_fd)",
  "",
  "def same_stat_identity(left_stat, right_stat):",
  "    return (",
  "        getattr(left_stat, 'st_dev', None) == getattr(right_stat, 'st_dev', None)",
  "        and getattr(left_stat, 'st_ino', None) == getattr(right_stat, 'st_ino', None)",
  "    )",
  "",
  "def remove_leaf(parent_fd, basename, leaf_stat):",
  "    if stat.S_ISDIR(leaf_stat.st_mode) and not stat.S_ISLNK(leaf_stat.st_mode):",
  "        os.rmdir(basename, dir_fd=parent_fd)",
  "    else:",
  "        os.unlink(basename, dir_fd=parent_fd)",
  "",
  "def validate_renamed_destination(dest_parent_fd, dest_basename, expected_stat):",
  "    dest_stat = os.lstat(dest_basename, dir_fd=dest_parent_fd)",
  "    if stat.S_ISLNK(dest_stat.st_mode) or not same_stat_identity(dest_stat, expected_stat):",
  "        remove_leaf(dest_parent_fd, dest_basename, dest_stat)",
  "        raise OSError(errno.ELOOP, 'rename endpoint changed during operation', dest_basename)",
  "",
  "def rename_within_root(root_fd, source_segments, dest_segments, overwrite):",
  "    if not source_segments or not dest_segments:",
  "        raise OSError(errno.EPERM, 'refusing to rename root path')",
  "    source_parent_fd = walk_existing_path(root_fd, source_segments[:-1])",
  "    dest_parent_fd = None",
  "    try:",
  "        source_basename = source_segments[-1]",
  "        dest_basename = dest_segments[-1]",
  "        validate_segment(source_basename)",
  "        validate_segment(dest_basename)",
  "        dest_parent_fd = mkdirp_within_root_fd(root_fd, dest_segments[:-1])",
  "        source_stat = os.lstat(source_basename, dir_fd=source_parent_fd)",
  "        if stat.S_ISLNK(source_stat.st_mode):",
  "            raise OSError(errno.ELOOP, 'refusing to rename symlink source', source_basename)",
  "        try:",
  "            dest_stat = os.lstat(dest_basename, dir_fd=dest_parent_fd)",
  "            if stat.S_ISLNK(dest_stat.st_mode):",
  "                raise OSError(errno.ELOOP, 'refusing to rename over symlink destination', dest_basename)",
  "        except FileNotFoundError:",
  "            pass",
  "        maybe_apply_rename_test_race('after-endpoint-lstat', source_parent_fd, source_basename)",
  "        if not overwrite:",
  "            if not stat.S_ISREG(source_stat.st_mode):",
  "                raise OSError(errno.EPERM, 'no-overwrite rename only supports regular files', source_basename)",
  "            os.link(source_basename, dest_basename, src_dir_fd=source_parent_fd, dst_dir_fd=dest_parent_fd, follow_symlinks=False)",
  "            validate_renamed_destination(dest_parent_fd, dest_basename, source_stat)",
  "            os.unlink(source_basename, dir_fd=source_parent_fd)",
  "            validate_renamed_destination(dest_parent_fd, dest_basename, source_stat)",
  "            return",
  "        os.rename(source_basename, dest_basename, src_dir_fd=source_parent_fd, dst_dir_fd=dest_parent_fd)",
  "        validate_renamed_destination(dest_parent_fd, dest_basename, source_stat)",
  "    finally:",
  "        os.close(source_parent_fd)",
  "        if dest_parent_fd is not None:",
  "            os.close(dest_parent_fd)",
  "",
  "root_fd = open_dir(root_path)",
  "try:",
  "    segments = split_segments(relative_path)",
  "    if operation == 'mkdirp':",
  "        mkdirp_within_root(root_fd, segments)",
  "    elif operation == 'remove':",
  "        remove_within_root(root_fd, segments)",
  "    elif operation == 'readdir':",
  "        readdir_within_root(root_fd, segments)",
  "    elif operation == 'stat':",
  "        stat_within_root(root_fd, segments, overwrite)",
  "    elif operation == 'rename':",
  "        rename_within_root(root_fd, segments, split_segments(to_relative_path), overwrite)",
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

function buildPinnedPathHelperEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
    delete env.OPENCLAW_TEST_PINNED_PATH_HELPER_RACE;
  }
  return env;
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
  operation: "mkdirp" | "remove" | "readdir" | "rename" | "stat";
  rootPath: string;
  relativePath: string;
  toRelativePath?: string;
  overwrite?: boolean;
}): Promise<string> {
  const child = spawn(
    resolvePinnedPathPython(),
    [
      "-c",
      LOCAL_PINNED_PATH_PYTHON,
      params.operation,
      params.rootPath,
      params.relativePath,
      params.toRelativePath ?? "",
      params.overwrite === true ? "1" : "0",
    ],
    {
      env: buildPinnedPathHelperEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  child.stdout.setEncoding?.("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
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
  return stdout;
}
