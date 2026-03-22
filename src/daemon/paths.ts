import path from "node:path";
import { expandHomePrefix } from "../infra/home-dir.js";
import { resolveGatewayProfileSuffix } from "./constants.js";

const windowsAbsolutePath = /^[a-zA-Z]:[\\/]/;
const windowsUncPath = /^\\\\/;

function isWindowsStylePath(value: string): boolean {
  return windowsAbsolutePath.test(value) || windowsUncPath.test(value);
}

export function resolveHomeDir(env: Record<string, string | undefined>): string {
  const explicitHome = env.OPENCLAW_HOME?.trim();
  const osHome = env.HOME?.trim() || env.USERPROFILE?.trim();
  const home =
    (explicitHome ? expandHomePrefix(explicitHome, { home: osHome, env }) : undefined) || osHome;
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
  if (isWindowsStylePath(trimmed)) {
    return trimmed;
  }
  return path.resolve(trimmed);
}

export function resolveGatewayStateDir(env: Record<string, string | undefined>): string {
  const override = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (override) {
    const home = override.startsWith("~") ? resolveHomeDir(env) : undefined;
    return resolveUserPathWithHome(override, home);
  }
  const home = resolveHomeDir(env);
  const suffix = resolveGatewayProfileSuffix(env.OPENCLAW_PROFILE);
  if (isWindowsStylePath(home)) {
    return path.win32.join(home, `.openclaw${suffix}`);
  }
  return path.join(home, `.openclaw${suffix}`);
}
