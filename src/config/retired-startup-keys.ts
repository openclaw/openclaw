import { isRecord } from "@openclaw/normalization-core/record-coerce";

// Keys third-party supervisors keep writing after OpenClaw retired them.
// Doctor already deletes these. Gateway startup has to ignore them too, or a
// rewritten openclaw.json exits with InvalidConfigError before it can listen.

const RETIRED_STARTUP_PATHS = [
  ["meta", "lastTouchedAt"],
  ["gateway", "controlUi", "allowInsecureAuth"],
] as const;

function deletePath(owner: Record<string, unknown>, path: readonly string[]): boolean {
  const [key, ...rest] = path;
  if (!key || !Object.hasOwn(owner, key)) {
    return false;
  }
  if (rest.length === 0) {
    delete owner[key];
    return true;
  }
  const child = owner[key];
  if (!isRecord(child) || !deletePath(child, rest)) {
    return false;
  }
  if (Object.keys(child).length === 0) {
    delete owner[key];
  }
  return true;
}

/** Drop retired keys that a supervisor may rewrite on every boot. In-memory only. */
export function stripRetiredStartupKeys(config: unknown): boolean {
  if (!isRecord(config)) {
    return false;
  }
  let changed = false;
  for (const path of RETIRED_STARTUP_PATHS) {
    changed = deletePath(config, path) || changed;
  }
  const plugins = config.plugins;
  if (
    isRecord(plugins) &&
    isRecord(plugins.installs) &&
    Object.keys(plugins.installs).length === 0
  ) {
    delete plugins.installs;
    if (Object.keys(plugins).length === 0) {
      delete config.plugins;
    }
    changed = true;
  }
  return changed;
}
