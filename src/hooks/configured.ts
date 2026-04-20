import type { HookConfig, HookInstallRecord } from "../config/types.hooks.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getLegacyInternalHookHandlers } from "./legacy-config.js";

function hasEnabledEntry(entries: Record<string, HookConfig> | undefined): boolean {
  if (!entries) {
    return false;
  }
  return Object.values(entries).some((entry) => entry?.enabled !== false);
}

function hasConfiguredInstalls(installs: Record<string, HookInstallRecord> | undefined): boolean {
  return installs ? Object.keys(installs).length > 0 : false;
}

export function hasConfiguredInternalHooks(config: OpenClawConfig): boolean {
  const internal = config.hooks?.internal;
  if (!internal || internal.enabled === false) {
    return false;
  }
  if (internal.enabled === true) {
    return true;
  }
  if (hasEnabledEntry(internal.entries)) {
    return true;
  }
  if ((internal.load?.extraDirs ?? []).some((dir) => dir.trim().length > 0)) {
    return true;
  }
  if (hasConfiguredInstalls(internal.installs)) {
    return true;
  }
  return getLegacyInternalHookHandlers(config).length > 0;
}
