import { resolveStorePath, updateSessionStore } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getLogger } from "../logging/logger.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  requireValidConfigFileSnapshot as requireValidConfigFileSnapshotBase,
  requireValidConfigSnapshot,
} from "./config-validation.js";

export function createQuietRuntime(runtime: RuntimeEnv): RuntimeEnv {
  return { ...runtime, log: () => {} };
}

export async function requireValidConfigFileSnapshot(runtime: RuntimeEnv) {
  return await requireValidConfigFileSnapshotBase(runtime);
}

export async function requireValidConfig(runtime: RuntimeEnv): Promise<OpenClawConfig | null> {
  return await requireValidConfigSnapshot(runtime);
}

/** Purge session store entries for a deleted agent (#65524). Best-effort. */
export async function purgeAgentSessionStoreEntries(
  cfg: OpenClawConfig,
  agentId: string,
): Promise<void> {
  try {
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    await updateSessionStore(storePath, (store) => {
      for (const key of Object.keys(store)) {
        if (resolveAgentIdFromSessionKey(key) === agentId) {
          delete store[key];
        }
      }
    });
  } catch (err) {
    getLogger().debug("session store purge skipped during agent delete", err);
  }
}
