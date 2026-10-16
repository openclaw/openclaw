// Resolves OpenClaw home and platform-specific config directories.
import { AsyncLocalStorage } from "node:async_hooks";
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

const userPathBaseDirectory = resolveGlobalSingleton(
  Symbol.for("openclaw.userPathBaseDirectory"),
  () => new AsyncLocalStorage<string>(),
);

/** Preserve invocation-relative paths while an updater parks its physical cwd. */
export function withUserPathBaseDirectory<T>(cwd: string | undefined, operation: () => T): T {
  return cwd === undefined ? operation() : userPathBaseDirectory.run(path.resolve(cwd), operation);
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

function resolvePathWithHome(
  input: string,
  opts: HomePathOptions | undefined,
  resolveHome: typeof resolveRequiredHomeDir,
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
  const base = userPathBaseDirectory.getStore();
  return base ? path.resolve(base, expanded) : path.resolve(expanded);
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

/** Resolves a user-supplied path against the OS home, ignoring OPENCLAW_HOME. */
export function resolveOsHomeRelativePath(input: string, opts?: HomePathOptions): string {
  return resolvePathWithHome(input, opts, resolveRequiredOsHomeDir);
}
