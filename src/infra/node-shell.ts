import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

export const ANDROID_TERMUX_SHELL = "/data/data/com.termux/files/usr/bin/sh";

export function buildNodeShellCommand(command: string, platform?: string | null) {
  const normalized = normalizeLowercaseStringOrEmpty((platform ?? "").trim());
  if (normalized.startsWith("win")) {
    return ["cmd.exe", "/d", "/s", "/c", command];
  }
  if (normalized === "android") {
    return [ANDROID_TERMUX_SHELL, "-lc", command];
  }
  return ["/bin/sh", "-lc", command];
}
