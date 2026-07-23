// Builds the gateway-visible combined session store across agent-specific stores.
// Gateway callers need canonical per-agent keys even when stores are split by `{agentId}`.

import { expectDefined } from "@openclaw/normalization-core";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  canonicalizeSpawnedByForAgent,
  resolveStoredSessionKeyForAgentStore,
} from "../../gateway/session-store-key.js";
import { isIncognitoSessionKey, normalizeAgentId } from "../../routing/session-key.js";
import { listOpenIncognitoAgentDatabases } from "../../state/openclaw-agent-db.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveStorePath } from "./paths.js";
import { listSessionEntries, listSessionEntriesReadOnly } from "./session-accessor.js";
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

function loadGatewayStoreEntries(params: {
  agentId: string;
  storePath: string;
}): Record<string, SessionEntry> {
  return Object.fromEntries(
    listSessionEntriesReadOnly({
      agentId: params.agentId,
      clone: false,
      storePath: params.storePath,
    }).map(({ sessionKey, entry }) => [sessionKey, entry]),
  );
}

function loadIncognitoGatewayStoreEntries(params: {
  agentId: string;
  storePath: string;
}): Record<string, SessionEntry> {
  return Object.fromEntries(
    listSessionEntries({
      agentId: params.agentId,
      clone: false,
      storePath: params.storePath,
    }).map(({ sessionKey, entry }) => [sessionKey, entry]),
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

function mergeOpenIncognitoStores(params: {
  cfg: OpenClawConfig;
  combined: Record<string, SessionEntry>;
  agentId?: string;
}): string[] {
  const storePaths: string[] = [];
  for (const target of listOpenIncognitoAgentDatabases()) {
    if (params.agentId && target.agentId !== params.agentId) {
      continue;
    }
    const store = loadIncognitoGatewayStoreEntries({
      agentId: target.agentId,
      storePath: target.storePath,
    });
    let merged = false;
    for (const [sessionKey, entry] of Object.entries(store)) {
      if (!isIncognitoSessionKey(sessionKey) || entry.incognito !== true) {
        continue;
      }
      mergeSessionEntryIntoCombined({
        cfg: params.cfg,
        combined: params.combined,
        entry,
        agentId: target.agentId,
        canonicalKey: sessionKey,
      });
      merged = true;
    }
    if (merged) {
      storePaths.push(target.storePath);
    }
  }
  return storePaths;
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
  if (storeConfig && !isStorePathTemplate(storeConfig)) {
    // A single shared store still needs keys canonicalized as if owned by the default agent.
    const storePath = resolveStorePath(storeConfig);
    const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
    const store = loadGatewayStoreEntries({ agentId: defaultAgentId, storePath });
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
    const incognitoStorePaths = mergeOpenIncognitoStores({
      cfg,
      combined,
      ...(opts.agentId ? { agentId: normalizeAgentId(opts.agentId) } : {}),
    });
    return {
      storePath: incognitoStorePaths.length > 0 ? "(multiple)" : storePath,
      store: combined,
    };
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
  const combined: Record<string, SessionEntry> = {};
  for (const target of targets) {
    const agentId = target.agentId;
    const storePath = target.storePath;
    const store = loadGatewayStoreEntries({ agentId, storePath });
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

  const incognitoStorePaths = mergeOpenIncognitoStores({
    cfg,
    combined,
    ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
  });

  const allStorePaths = [...targets.map((target) => target.storePath), ...incognitoStorePaths];
  const storePath =
    allStorePaths.length === 1
      ? expectDefined(allStorePaths[0], "store path at 0")
      : typeof storeConfig === "string" && storeConfig.trim()
        ? storeConfig.trim()
        : "(multiple)";
  return { storePath, store: combined };
}
