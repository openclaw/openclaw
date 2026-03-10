import os from "node:os";
import path from "node:path";
import { resolveGatewayProfileSuffix } from "./constants.js";

const windowsAbsolutePath = /^[a-zA-Z]:[\\/]/;
const windowsUncPath = /^\\\\/;

function resolveSudoUserHome(env: Record<string, string | undefined>): string | undefined {
  const sudoUser = env.SUDO_USER?.trim();
  if (!sudoUser || sudoUser === "root") {
    return undefined;
  }
  try {
    const info = os.userInfo({ username: sudoUser });
    const homedir = info.homedir.trim();
    return homedir || undefined;
  } catch {
    return undefined;
  }
}

export function resolveHomeDir(env: Record<string, string | undefined>): string {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  const sudoUserHome = resolveSudoUserHome(env);
  // Under sudo, HOME is often /root even though systemd --user runs as SUDO_USER.
  // Prefer the sudo caller's home so unit file writes and systemctl scope match.
  if (sudoUserHome && (!home || home === "/root" || home === "/var/root")) {
    return sudoUserHome;
  }
  if (!home) {
    throw new Error("Missing HOME");
  }
  return home;
}

export function resolveUserPathWithHome(input: string, home?: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    if (!home) {
      throw new Error("Missing HOME");
    }
    const expanded = trimmed.replace(/^~(?=$|[\\/])/, home);
    return path.resolve(expanded);
  }
  if (windowsAbsolutePath.test(trimmed) || windowsUncPath.test(trimmed)) {
    return trimmed;
  }
  return path.resolve(trimmed);
}

export function resolveGatewayStateDir(env: Record<string, string | undefined>): string {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    const home = override.startsWith("~") ? resolveHomeDir(env) : undefined;
    return resolveUserPathWithHome(override, home);
  }
  const home = resolveHomeDir(env);
  const suffix = resolveGatewayProfileSuffix(env.OPENCLAW_PROFILE);
  return path.join(home, `.openclaw${suffix}`);
}
