import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Normalize the shorter POSIX/Windows basename, removing native executable suffixes. */
export function normalizeExecutableToken(token: string): string {
  const win = path.win32.basename(token);
  const posix = path.posix.basename(token);
  const base = win.length < posix.length ? win : posix;
  return normalizeLowercaseStringOrEmpty(base).replace(/\.(?:exe|cmd|bat|com)$/, "");
}
