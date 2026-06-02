import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  type ErrorShape,
  errorShape,
  type SessionsResolveParams,
} from "../../packages/gateway-protocol/src/index.js";
import { loadSessionStore, updateSessionStore, type SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionIdMatchSelection } from "../sessions/session-id-resolution.js";
import { parseSessionLabel } from "../sessions/session-label.js";
import {
  filterAndSortSessionEntries,
  listSessionsFromStore,
  loadCombinedSessionStoreForGateway,
  migrateAndPruneGatewaySessionStoreKey,
  resolveDeletedAgentIdFromSessionKey,
  resolveGatewaySessionStoreTarget,
} from "./session-utils.js";

/**
 * Canonical session-key lookup result used by Gateway RPC handlers and
 * embedded agent tools before they read or mutate session state.
 */
export type SessionsResolveResult = { ok: true; key: string } | { ok: false; error: ErrorShape };

function resolveSessionVisibilityFilterOptions(p: SessionsResolveParams) {
  return {
    includeGlobal: p.includeGlobal === true,
    includeUnknown: p.includeUnknown === true,
    spawnedBy: p.spawnedBy,
    agentId: p.agentId,
  };
}

function noSessionFoundResult(key: string): SessionsResolveResult {
  return {
    ok: false,
    error: errorShape(ErrorCodes.INVALID_REQUEST, `No session found: ${key}`),
  };
}

/** Rejects sessions whose owning agent no longer exists in config (#65524). */
function validateSessionAgentExists(
  cfg: OpenClawConfig,
  key: string,
): SessionsResolveResult | null {
  const deletedAgentId = resolveDeletedAgentIdFromSessionKey(cfg, key);
  if (deletedAgentId === null) {
    return null;
  }
  return {
    ok: false,
    error: errorShape(
      ErrorCodes.INVALID_REQUEST,
      `Agent "${deletedAgentId}" no longer exists in configuration`,
    ),
  };
}

function isResolvedSessionKeyVisible(params: {
  cfg: OpenClawConfig;
  p: SessionsResolveParams;
  storePath: string;
  store: ReturnType<typeof loadSessionStore>;
  key: string;
}) {
  if (typeof params.p.spawnedBy !== "string" || params.p.spawnedBy.trim().length === 0) {
    return true;
  }
  // Exact key resolution still respects spawnedBy scoping. Use the shared list
  // filter without a page limit so older child sessions remain addressable.
  return filterAndSortSessionEntries({
    cfg: params.cfg,
    store: params.store,
    now: Date.now(),
    opts: resolveSessionVisibilityFilterOptions(params.p),
  }).some(([key]) => key === params.key);
}

function findVisibleSessionIdMatches(params: {
  cfg: OpenClawConfig;
  store: Record<string, SessionEntry>;
  p: SessionsResolveParams;
  sessionId: string;
}): Array<[string, SessionEntry]> {
  const now = Date.now();
  // sessionId lookups need raw store entries for speed and ambiguity detection,
  // but visibility rules still mirror the dashboard/session list filters.
  const entries = filterAndSortSessionEntries({
    cfg: params.cfg,
    store: params.store,
    now,
    opts: resolveSessionVisibilityFilterOptions(params.p),
  });
  return entries.filter(
    ([key, entry]) => entry?.sessionId === params.sessionId || key === params.sessionId,
  );
}

/**
 * Resolves a caller-provided key, sessionId, or human label to the canonical
 * stored session key, applying agent scope, visibility filters, and legacy key
 * migration before returning a key to downstream session readers.
 */
export async function resolveSessionKeyFromResolveParams(params: {
  cfg: OpenClawConfig;
  p: SessionsResolveParams;
}): Promise<SessionsResolveResult> {
  const { cfg, p } = params;

  const key = normalizeOptionalString(p.key) ?? "";
  const hasKey = key.length > 0;
  const sessionId = normalizeOptionalString(p.sessionId) ?? "";
  const hasSessionId = sessionId.length > 0;
  const hasLabel = (normalizeOptionalString(p.label) ?? "").length > 0;
  const selectionCount = [hasKey, hasSessionId, hasLabel].filter(Boolean).length;
  if (selectionCount > 1) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Provide either key, sessionId, or label (not multiple)",
      ),
    };
  }
  if (selectionCount === 0) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "Either key, sessionId, or label is required"),
    };
  }

  if (hasKey) {
    const target = resolveGatewaySessionStoreTarget({ cfg, key });
    const store = loadSessionStore(target.storePath);
    if (store[target.canonicalKey]) {
      if (
        !isResolvedSessionKeyVisible({
          cfg,
          p,
          storePath: target.storePath,
          store,
          key: target.canonicalKey,
        })
      ) {
        return noSessionFoundResult(key);
      }
      const agentCheck = validateSessionAgentExists(cfg, target.canonicalKey);
      if (agentCheck) {
        return agentCheck;
      }
      return { ok: true, key: target.canonicalKey };
    }
    const legacyKey = target.storeKeys.find((candidate) => store[candidate]);
    if (!legacyKey) {
      return noSessionFoundResult(key);
    }
    // Key callers may still pass older aliases. Canonicalize the store first so
    // later reads, deletes, and embedded tools all converge on one key spelling.
    await updateSessionStore(target.storePath, (s) => {
      const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({ cfg, key, store: s });
      if (!s[primaryKey] && s[legacyKey]) {
        s[primaryKey] = s[legacyKey];
      }
    });
    if (
      !isResolvedSessionKeyVisible({
        cfg,
        p,
        storePath: target.storePath,
        store: loadSessionStore(target.storePath),
        key: target.canonicalKey,
      })
    ) {
      return noSessionFoundResult(key);
    }
    const agentCheckLegacy = validateSessionAgentExists(cfg, target.canonicalKey);
    if (agentCheckLegacy) {
      return agentCheckLegacy;
    }
    return { ok: true, key: target.canonicalKey };
  }

  if (hasSessionId) {
    const { store } = loadCombinedSessionStoreForGateway(cfg, { agentId: p.agentId });
    const matches = findVisibleSessionIdMatches({ cfg, store, p, sessionId });
    const selection = resolveSessionIdMatchSelection(matches, sessionId);
    if (selection.kind === "none") {
      return {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, `No session found: ${sessionId}`),
      };
    }
    if (selection.kind === "ambiguous") {
      const keys = selection.sessionKeys.join(", ");
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Multiple sessions found for sessionId: ${sessionId} (${keys})`,
        ),
      };
    }
    const agentCheckSessionId = validateSessionAgentExists(cfg, selection.sessionKey);
    if (agentCheckSessionId) {
      return agentCheckSessionId;
    }
    return { ok: true, key: selection.sessionKey };
  }

  const parsedLabel = parseSessionLabel(p.label);
  if (!parsedLabel.ok) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, parsedLabel.error),
    };
  }

  const { storePath, store } = loadCombinedSessionStoreForGateway(cfg, { agentId: p.agentId });
  // Labels are user-facing and may collide. Reuse the list projection with
  // limit 2 so the resolver can distinguish no-match, unique, and ambiguous.
  const list = listSessionsFromStore({
    cfg,
    storePath,
    store,
    opts: {
      includeGlobal: p.includeGlobal === true,
      includeUnknown: p.includeUnknown === true,
      label: parsedLabel.label,
      agentId: p.agentId,
      spawnedBy: p.spawnedBy,
      limit: 2,
    },
  });
  if (list.sessions.length === 0) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `No session found with label: ${parsedLabel.label}`,
      ),
    };
  }
  if (list.sessions.length > 1) {
    const keys = list.sessions.map((s) => s.key).join(", ");
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `Multiple sessions found with label: ${parsedLabel.label} (${keys})`,
      ),
    };
  }

  const agentCheckLabel = validateSessionAgentExists(cfg, list.sessions[0].key);
  if (agentCheckLabel) {
    return agentCheckLabel;
  }
  return { ok: true, key: list.sessions[0].key };
}
