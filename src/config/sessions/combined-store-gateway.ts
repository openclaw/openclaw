// Builds the gateway-visible combined session store across agent-specific stores.
// Gateway callers need canonical per-agent keys even when stores are split by `{agentId}`.

import fsSync from "node:fs";
import path from "node:path";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  canonicalizeSpawnedByForAgent,
  resolveStoredSessionKeyForAgentStore,
} from "../../gateway/session-store-key.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveAgentsDirFromSessionStorePath, resolveStorePath } from "./paths.js";
import { listSessionEntries } from "./session-accessor.js";
import {
  resolveAgentSessionStoreTargetsSync,
  resolveAllAgentSessionStoreTargetsSync,
  resolveSessionStoreTargets,
} from "./targets.js";
import type { SessionEntry } from "./types.js";

// Template-backed stores need per-agent scans before they can be merged for Gateway views.
function isStorePathTemplate(store?: string): boolean {
  return typeof store === "string" && store.includes("{agentId}");
}

function resolveComparablePath(filePath: string): string {
  try {
    return fsSync.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function loadGatewayStoreEntries(storePath: string): Record<string, SessionEntry> {
  return Object.fromEntries(
    listSessionEntries({ clone: false, storePath }).map(({ sessionKey, entry }) => [
      sessionKey,
      entry,
    ]),
  );
}

function mergeSessionEntryIntoCombined(params: {
  cfg: OpenClawConfig;
  combined: Record<string, SessionEntry>;
  entry: SessionEntry;
  agentId: string;
  canonicalKey: string;
}) {
  const { cfg, combined, entry, agentId, canonicalKey } = params;
  const existing = combined[canonicalKey];

  if (existing && (existing.updatedAt ?? 0) > (entry.updatedAt ?? 0)) {
    // Preserve the freshest entry while still canonicalizing spawnedBy for this agent store.
    const spawnedBy = canonicalizeSpawnedByForAgent(
      cfg,
      agentId,
      existing.spawnedBy ?? entry.spawnedBy,
    );
    combined[canonicalKey] = {
      ...entry,
      ...existing,
      spawnedBy,
    };
    return;
  }

  const spawnedBy = canonicalizeSpawnedByForAgent(
    cfg,
    agentId,
    entry.spawnedBy ?? existing?.spawnedBy,
  );
  if (!existing && entry.spawnedBy === spawnedBy) {
    combined[canonicalKey] = entry;
  } else {
    combined[canonicalKey] = {
      ...existing,
      ...entry,
      spawnedBy,
    };
  }
}

/** Loads and canonicalizes session entries for gateway views across one or more agent stores. */
export function loadCombinedSessionStoreForGateway(
  cfg: OpenClawConfig,
  opts: { agentId?: string; configuredAgentsOnly?: boolean } = {},
): {
  storePath: string;
  store: Record<string, SessionEntry>;
} {
  const storeConfig = cfg.session?.store;
  const literalStorePath =
    storeConfig && !isStorePathTemplate(storeConfig) ? resolveStorePath(storeConfig) : undefined;
  const literalAgentsDir = literalStorePath
    ? resolveAgentsDirFromSessionStorePath(literalStorePath)
    : undefined;
  if (literalStorePath && !literalAgentsDir) {
    // A single shared store still needs keys canonicalized as if owned by the default agent.
    const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
    const store = loadGatewayStoreEntries(literalStorePath);
    const combined: Record<string, SessionEntry> = {};
    for (const [key, entry] of Object.entries(store)) {
      const canonicalKey = resolveStoredSessionKeyForAgentStore({
        cfg,
        agentId: defaultAgentId,
        sessionKey: key,
      });
      mergeSessionEntryIntoCombined({
        cfg,
        combined,
        entry,
        agentId: defaultAgentId,
        canonicalKey,
      });
    }
    return { storePath: literalStorePath, store: combined };
  }

  const requestedAgentId =
    typeof opts.agentId === "string" && opts.agentId.trim()
      ? normalizeAgentId(opts.agentId)
      : undefined;
  const targets = requestedAgentId
    ? resolveAgentSessionStoreTargetsSync(cfg, requestedAgentId)
    : opts.configuredAgentsOnly === true
      ? resolveSessionStoreTargets(cfg, { allAgents: true })
      : resolveAllAgentSessionStoreTargetsSync(cfg);
  const scopedTargets = literalAgentsDir
    ? (() => {
        const scopedAgentsDir = resolveComparablePath(literalAgentsDir);
        return targets.filter((target) => {
          const targetAgentsDir = resolveAgentsDirFromSessionStorePath(target.storePath);
          return (
            targetAgentsDir !== undefined &&
            resolveComparablePath(targetAgentsDir) === scopedAgentsDir
          );
        });
      })()
    : targets;
  const combined: Record<string, SessionEntry> = {};
  for (const target of scopedTargets) {
    const agentId = target.agentId;
    const storePath = target.storePath;
    const store = loadGatewayStoreEntries(storePath);
    for (const [key, entry] of Object.entries(store)) {
      const canonicalKey = resolveStoredSessionKeyForAgentStore({
        cfg,
        agentId,
        sessionKey: key,
      });
      mergeSessionEntryIntoCombined({
        cfg,
        combined,
        entry,
        agentId,
        canonicalKey,
      });
    }
  }

  let storePath = "(multiple)";
  if (scopedTargets.length === 1) {
    storePath = scopedTargets[0].storePath;
  } else if (literalStorePath) {
    storePath = literalStorePath;
  } else if (typeof storeConfig === "string" && storeConfig.trim()) {
    storePath = storeConfig.trim();
  }
  return { storePath, store: combined };
}
