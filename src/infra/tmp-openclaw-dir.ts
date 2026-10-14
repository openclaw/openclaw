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

/** Resolves a safe OpenClaw temp root, falling back to user-scoped os.tmpdir paths when needed. */
export function resolvePreferredOpenClawTmpDir(
  options: ResolvePreferredOpenClawTmpDirOptions = {},
): string {
  return loadResolveSecureTempRoot()({
    ...options,
    preferredDir: options.preferredDir ?? DEFAULT_POSIX_TMP_ROOT,
    fallbackPrefix: "openclaw",
    warningPrefix: "[openclaw]",
    unsafeFallbackLabel: "OpenClaw temp dir",
    skipPreferredOnWindows: true,
  });
}
