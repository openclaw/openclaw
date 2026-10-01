// Windows launcher normalization for npm/bun wrappers that duplicate node.exe in argv.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

const CONTROL_CHARS = new RegExp(String.raw`[\u0000-\u001f\u007f]`, "g");

/** Remove duplicated Windows node launcher argv entries while preserving normal POSIX argv. */
export function normalizeWindowsArgv(
  argv: string[],
  options: {
    platform?: NodeJS.Platform;
    execPath?: string;
  } = {},
): string[] {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return argv;
  }
  if (argv.length < 2) {
    return argv;
  }

  const normalizeCandidate = (value: string): string =>
    value
      .replace(CONTROL_CHARS, "")
      .replace(/^['"]+|['"]+$/g, "")
      .trim()
      .replace(/^\\\\\\?\\/, "");
  const basename = (value: string): string => value.split(/[\\/]/).pop() ?? value;

  const execPath = normalizeCandidate(options.execPath ?? process.execPath);
  const execPathLower = normalizeLowercaseStringOrEmpty(execPath);
  const execBase = normalizeLowercaseStringOrEmpty(basename(execPath));
  const isExecPath = (value: string | undefined): boolean => {
    if (!value) {
      return false;
    }
    const normalized = normalizeCandidate(value);
    if (!normalized) {
      return false;
    }
    const lower = normalizeLowercaseStringOrEmpty(normalized);
    const base = basename(lower);
    return lower === execPathLower || base === execBase || base === "node.exe";
  };

  const next = [...argv];
  while (isExecPath(next[1])) {
    next.splice(1, 1);
  }
  return next;
}
