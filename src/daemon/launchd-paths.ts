import os from "node:os";
import path from "node:path";
import { toPosixPath } from "./output.js";

export function resolveTrustedLaunchAgentHome(): string {
  const home = (() => {
    try {
      const fromUserInfo = os.userInfo().homedir.trim();
      if (fromUserInfo) {
        return fromUserInfo;
      }
    } catch {}
    return os.homedir().trim();
  })();
  if (!home) {
    throw new Error("Unable to resolve trusted user home for launchd operations.");
  }
  return toPosixPath(home);
}

export function resolveTrustedLaunchAgentPlistPath(label: string): string {
  return path.posix.join(
    resolveTrustedLaunchAgentHome(),
    "Library",
    "LaunchAgents",
    `${label}.plist`,
  );
}
