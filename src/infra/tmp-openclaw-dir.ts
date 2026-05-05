import "./fs-safe-defaults.js";
import { resolveSecureTempRoot, type ResolveSecureTempRootOptions } from "@openclaw/fs-safe/temp";

export const POSIX_OPENCLAW_TMP_DIR = "/tmp/openclaw";

type ResolvePreferredOpenClawTmpDirOptions = Omit<
  ResolveSecureTempRootOptions,
  | "fallbackPrefix"
  | "preferredDir"
  | "skipPreferredOnWindows"
  | "unsafeFallbackLabel"
  | "warningPrefix"
>;

export function resolvePreferredOpenClawTmpDir(
  options: ResolvePreferredOpenClawTmpDirOptions = {},
): string {
  return resolveSecureTempRoot({
    ...options,
    fallbackPrefix: "openclaw",
    preferredDir: POSIX_OPENCLAW_TMP_DIR,
    skipPreferredOnWindows: true,
    unsafeFallbackLabel: "OpenClaw temp dir",
    warningPrefix: "[openclaw]",
  });
}
