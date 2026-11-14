import path from "node:path";
import { resolveStateDir } from "../config/state-dir.js";
import { getSealedRuntimeSecureTempRoot } from "./sealed-runtime-registry.js";

/** Preferred shared OpenClaw temp root on POSIX systems when ownership and permissions are safe. */
export const DEFAULT_POSIX_TMP_ROOT = "/tmp/openclaw";

type SecureDirStat = {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  mode?: number;
  uid?: number;
};

/** Injectable filesystem/platform hooks for resolving the preferred temp root in tests. */
export type ResolvePreferredOpenClawTmpDirOptions = {
  accessSync?: (path: string, mode?: number) => void;
  chmodSync?: (path: string, mode: number) => void;
  getuid?: () => number | undefined;
  lstatSync?: (path: string) => SecureDirStat;
  mkdirSync?: (path: string, opts: { recursive: boolean; mode?: number }) => void;
  platform?: NodeJS.Platform;
  preferredDir?: string;
  /** Coordination addresses must stay shared across profiles and updater versions. */
  purpose?: "workspace" | "coordination";
  tmpdir?: () => string;
  warn?: (message: string) => void;
};

type ResolveSecureTempRoot =
  typeof import("@openclaw/fs-safe/secure-temp-root").resolveSecureTempRoot;

let resolveSecureTempRootRuntime: ResolveSecureTempRoot | undefined;
declare const SEALED_RUNTIME_BUILD: boolean;

function loadResolveSecureTempRoot(): ResolveSecureTempRoot {
  if (resolveSecureTempRootRuntime) {
    return resolveSecureTempRootRuntime;
  }
  const injected = getSealedRuntimeSecureTempRoot();
  if (injected) {
    resolveSecureTempRootRuntime = injected;
    return injected;
  }
  if (typeof SEALED_RUNTIME_BUILD === "boolean" && SEALED_RUNTIME_BUILD) {
    throw new Error("sealed temp-root runtime was not registered before use");
  }
  // Keep browser imports safe; load the Node-only resolver when a temp root is needed.
  if (typeof process.getBuiltinModule !== "function") {
    throw new Error("Node module loading is unavailable for secure temp-root resolution");
  }
  const require = process.getBuiltinModule("module").createRequire(import.meta.url);
  const fsSafeTemp =
    require("@openclaw/fs-safe/secure-temp-root") as typeof import("@openclaw/fs-safe/secure-temp-root");
  resolveSecureTempRootRuntime = fsSafeTemp.resolveSecureTempRoot;
  return resolveSecureTempRootRuntime;
}

function assertSafeTempAncestors(
  root: string,
  options: ResolvePreferredOpenClawTmpDirOptions,
): void {
  const platform = options.platform ?? process.platform;
  // fs-safe owns Windows ACL admission and Android's trusted system/app-group policy.
  if (platform === "win32" || platform === "android") {
    return;
  }
  const fs = process.getBuiltinModule("fs");
  const lstat = options.lstatSync ?? fs.lstatSync;
  // Supplied filesystem observations may describe virtual paths rather than host paths.
  const canonicalRoot = options.lstatSync ? path.resolve(root) : fs.realpathSync.native(root);
  for (let directory = path.dirname(canonicalRoot); ; directory = path.dirname(directory)) {
    const stat = lstat(directory);
    if (stat.mode !== undefined && (stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) {
      const quoted = `'${directory.replaceAll("'", "'\\''")}'`;
      throw new Error(
        `Temp workspace ancestor ${JSON.stringify(directory)} is group/world writable without sticky protection; have its owner run chmod +t ${quoted} for a shared temp directory or chmod go-w ${quoted} for a private ancestor.`,
      );
    }
    if (path.dirname(directory) === directory) {
      return;
    }
  }
}

/** Select a private root with trusted ancestors before consumers create disposable workspaces. */
export function resolvePreferredOpenClawTmpDir(
  options: ResolvePreferredOpenClawTmpDirOptions = {},
): string {
  const resolveRoot = loadResolveSecureTempRoot();
  const rootOptions = {
    ...options,
    preferredDir: options.preferredDir ?? DEFAULT_POSIX_TMP_ROOT,
    fallbackPrefix: "openclaw",
    warningPrefix: "[openclaw]",
    unsafeFallbackLabel: "OpenClaw temp dir",
    skipPreferredOnWindows: true,
  };
  const root = resolveRoot(rootOptions);
  if (options.purpose === "coordination") {
    return root;
  }
  let rejected: unknown;
  try {
    assertSafeTempAncestors(root, options);
    return root;
  } catch (error) {
    rejected = error;
  }
  const stateDir = resolveStateDir();
  try {
    const fallbackRoot = resolveRoot({
      ...rootOptions,
      preferredDir: undefined,
      tmpdir: () => path.join(stateDir, "tmp"),
    });
    assertSafeTempAncestors(fallbackRoot, options);
    (options.warn ?? console.warn)(
      `[openclaw] ${String(rejected)} Using private state temp dir: ${fallbackRoot}`,
    );
    return fallbackRoot;
  } catch (error) {
    throw new Error(
      `No safe OpenClaw temp root is available. Default root: ${String(rejected)} State fallback ${JSON.stringify(stateDir)}: ${String(error)}`,
      { cause: error },
    );
  }
}
