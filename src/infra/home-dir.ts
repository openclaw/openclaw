import os from "node:os";
import path from "node:path";
import {
  normalizeHomeDirValue,
  resolveEffectiveHomeDir,
  resolveOsHomeDir,
} from "@openclaw/normalization-core/home-dir";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { tryProcessCwd } from "./safe-cwd.js";

export { resolveEffectiveHomeDir, resolveOsHomeDir };

function getUserPathBaseDirectory() {
  // Path resolution can be imported by browser-safe helpers before Node context is needed.
  return resolveGlobalSingleton(Symbol.for("openclaw.userPathBaseDirectory"), () => {
    const { AsyncLocalStorage } = process.getBuiltinModule("async_hooks");
    return new AsyncLocalStorage<string>();
  });
}

/** Preserve invocation-relative paths while an updater parks its physical cwd. */
export function withUserPathBaseDirectory<T>(cwd: string | undefined, operation: () => T): T {
  return cwd === undefined
    ? operation()
    : getUserPathBaseDirectory().run(path.resolve(cwd), operation);
}

/** Resolves the effective home or falls back to cwd when no home source exists. */
export function resolveRequiredHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const resolved = resolveEffectiveHomeDir(env, homedir) ?? tryProcessCwd();
  if (resolved) {
    return path.resolve(resolved);
  }
  throw new Error(
    "Unable to resolve an OpenClaw home: set OPENCLAW_HOME, HOME, or USERPROFILE, or run from an existing directory.",
  );
}

/** Resolves the OS home or falls back to cwd when no OS home source exists. */
export function resolveRequiredOsHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const resolved = resolveOsHomeDir(env, homedir) ?? tryProcessCwd();
  if (resolved) {
    return path.resolve(resolved);
  }
  throw new Error(
    "Unable to resolve an OS home: set HOME or USERPROFILE, or run from an existing directory.",
  );
}

/** Expands leading `~`, `~/`, or `~\` with the effective home when one is known. */
export function expandHomePrefix(
  input: string,
  opts?: {
    home?: string;
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
  },
): string {
  if (!input.startsWith("~")) {
    return input;
  }
  const home =
    normalizeHomeDirValue(opts?.home) ??
    resolveEffectiveHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir);
  if (!home) {
    return input;
  }
  return input.replace(/^~(?=$|[\\/])/, () => home);
}

type HomePathOptions = {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
};

function resolveAgainstUserBase(input: string): string {
  const base = getUserPathBaseDirectory().getStore();
  return base ? path.resolve(base, input) : path.resolve(input);
}

function resolvePathWithHome(
  input: string,
  opts: HomePathOptions | undefined,
  resolveHome: typeof resolveRequiredHomeDir,
  resolveExpanded: (input: string) => string = resolveAgainstUserBase,
): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  const expanded = trimmed.startsWith("~")
    ? expandHomePrefix(trimmed, {
        home: resolveHome(opts?.env ?? process.env, opts?.homedir ?? os.homedir),
        env: opts?.env,
        homedir: opts?.homedir,
      })
    : trimmed;
  return resolveExpanded(expanded);
}

function notADirectory(target: string): Error {
  return Object.assign(new Error(`ENOTDIR: not a directory, '${target}'`), {
    code: "ENOTDIR",
    path: target,
  });
}

/**
 * Resolves a path about to be opened or written, like `path.resolve`, except that a symlink
 * followed by `..` is replaced by its target first, as the OS does: with `link -> a/b`,
 * `link/../x` names `a/x`, not the lexical `./x`. Every other segment keeps its spelling, so a
 * final symlink (for example a `plugins install --link` source) is recorded as typed.
 *
 * For a path with `..`, throws the error the OS would give (`ENOENT`, `ENOTDIR`, `EACCES`)
 * when a segment before `..` cannot be traversed, or when a trailing `/` or `/.` names an
 * existing non-directory. Returning such a path would let later normalization reopen a
 * lexical neighbor.
 */
export function resolveFilesystemPath(input: string): string {
  // Windows folds `..` lexically before the filesystem sees the path.
  if (process.platform === "win32" || !input.split("/").includes("..")) {
    return resolveAgainstUserBase(input);
  }
  const unfolded = path.isAbsolute(input)
    ? input
    : `${getUserPathBaseDirectory().getStore() ?? process.cwd()}/${input}`;
  const fs = process.getBuiltinModule("fs");
  const segments = unfolded.split("/");
  let current = "/";
  for (const segment of segments) {
    if (segment === "..") {
      const directory = fs.lstatSync(current).isSymbolicLink() ? fs.realpathSync(current) : current;
      if (!fs.statSync(directory).isDirectory()) {
        throw notADirectory(directory);
      }
      current = path.dirname(directory);
    } else if (segment !== "" && segment !== ".") {
      current = path.join(current, segment);
    }
  }
  const last = segments.at(-1);
  if (last === "" || last === ".") {
    const stat = fs.statSync(current, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) {
      throw notADirectory(current);
    }
  }
  return current;
}

/** Resolves a user-supplied path after trimming and expanding against the effective home. */
export function resolveHomeRelativePath(input: string, opts?: HomePathOptions): string {
  return resolvePathWithHome(input, opts, resolveRequiredHomeDir);
}

/** Resolves a user path against the effective home, preserving an empty input. */
export function resolveUserPath(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  if (!input) {
    return "";
  }
  return resolveHomeRelativePath(input, { env, homedir });
}

/** Resolves a user path like `resolveUserPath`, following symlinks before `..` as the OS does. */
export function resolveUserFilesystemPath(input: string): string {
  if (!input) {
    return "";
  }
  return resolvePathWithHome(input, undefined, resolveRequiredHomeDir, resolveFilesystemPath);
}

/** Resolves a user-supplied path against the OS home, ignoring OPENCLAW_HOME. */
export function resolveOsHomeRelativePath(input: string, opts?: HomePathOptions): string {
  return resolvePathWithHome(input, opts, resolveRequiredOsHomeDir);
}
