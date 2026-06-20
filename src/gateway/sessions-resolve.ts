// Gateway sessions.resolve implementation helper.
// Resolves key/sessionId/title/label selectors into one canonical session key.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  type ErrorShape,
  errorShape,
  type SessionsResolveParams,
} from "../../packages/gateway-protocol/src/index.js";
import { updateSessionStore, type SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionIdMatchSelection } from "../sessions/session-id-resolution.js";
import {
  getSessionTitleFromEntry,
  parseSessionLabel,
  parseSessionTitle,
  sessionTitlesEqual,
} from "../sessions/session-label.js";
import {
  filterAndSortSessionEntries,
  loadCombinedSessionStoreForGateway,
  migrateAndPruneGatewaySessionStoreKey,
  resolveDeletedAgentIdFromSessionKey,
  resolveGatewaySessionStoreTargetWithStore,
} from "./session-utils.js";

export type SessionsResolveResult =
  | { ok: true; key: string }
  | { ok: true; missing: true }
  | { ok: false; error: ErrorShape };

function resolveSessionVisibilityFilterOptions(p: SessionsResolveParams) {
  return {
    includeGlobal: p.includeGlobal === true,
    includeUnknown: p.includeUnknown === true,
    spawnedBy: p.spawnedBy,
    agentId: p.agentId,
  };
}

function noSessionFoundResult(params: { p: SessionsResolveParams; message: string }) {
  if (params.p.allowMissing) {
    return { ok: true, missing: true } as const;
  }
  return {
    ok: false,
    error: errorShape(ErrorCodes.INVALID_REQUEST, params.message),
  } as const;
}

function validateSessionAgentExists(
  cfg: OpenClawConfig,
  key: string,
  entry?: SessionEntry | null,
  options?: { acpMetadataSessionKey?: string | null },
): SessionsResolveResult | null {
  const deletedAgentId = resolveDeletedAgentIdFromSessionKey(cfg, key, entry, options);
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
  store: Record<string, SessionEntry>;
  key: string;
}) {
  if (typeof params.p.spawnedBy !== "string" || params.p.spawnedBy.trim().length === 0) {
    return true;
  }
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

function findVisibleTitleMatches(params: {
  cfg: OpenClawConfig;
  store: Record<string, SessionEntry>;
  p: SessionsResolveParams;
  title: string;
}): Array<[string, SessionEntry]> {
  const entries = filterAndSortSessionEntries({
    cfg: params.cfg,
    store: params.store,
    now: Date.now(),
    opts: resolveSessionVisibilityFilterOptions(params.p),
  });
  return entries
    .filter(([, entry]) => sessionTitlesEqual(getSessionTitleFromEntry(entry), params.title))
    .slice(0, 2);
}

export async function resolveSessionKeyFromResolveParams(params: {
  cfg: OpenClawConfig;
  p: SessionsResolveParams;
}): Promise<SessionsResolveResult> {
  const { cfg, p } = params;

  const key = normalizeOptionalString(p.key) ?? "";
  const hasKey = key.length > 0;
  const sessionId = normalizeOptionalString(p.sessionId) ?? "";
  const hasSessionId = sessionId.length > 0;
  const hasTitle = (normalizeOptionalString(p.title) ?? "").length > 0;
  const hasLabel = (normalizeOptionalString(p.label) ?? "").length > 0;
  const selectionCount = [hasKey, hasSessionId, hasTitle, hasLabel].filter(Boolean).length;
  if (selectionCount > 1) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Provide either key, sessionId, title, or label (not multiple)",
      ),
    };
  }
  if (selectionCount === 0) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Either key, sessionId, title, or label is required",
      ),
    };
  }

  if (hasKey) {
    const target = resolveGatewaySessionStoreTargetWithStore({ cfg, key, clone: false });
    const store = target.store;
    if (store[target.canonicalKey]) {
      if (
        !isResolvedSessionKeyVisible({
          cfg,
          p,
          store,
          key: target.canonicalKey,
        })
      ) {
        return noSessionFoundResult({ p, message: `No session found: ${key}` });
      }
      const agentCheck = validateSessionAgentExists(
        cfg,
        target.canonicalKey,
        store[target.canonicalKey],
        { acpMetadataSessionKey: target.canonicalKey },
      );
      if (agentCheck) {
        return agentCheck;
      }
      return { ok: true, key: target.canonicalKey };
    }
    const legacyKey = target.storeKeys.find((candidate) => store[candidate]);
    if (!legacyKey) {
      return noSessionFoundResult({ p, message: `No session found: ${key}` });
    }
    await updateSessionStore(target.storePath, (s) => {
      const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({ cfg, key, store: s });
      if (!s[primaryKey] && s[legacyKey]) {
        s[primaryKey] = s[legacyKey];
      }
    });
    const refreshedTarget = resolveGatewaySessionStoreTargetWithStore({
      cfg,
      key: target.canonicalKey,
      clone: false,
    });
    if (
      !isResolvedSessionKeyVisible({
        cfg,
        p,
        store: refreshedTarget.store,
        key: refreshedTarget.canonicalKey,
      })
    ) {
      return noSessionFoundResult({ p, message: `No session found: ${key}` });
    }
    const agentCheckLegacy = validateSessionAgentExists(
      cfg,
      refreshedTarget.canonicalKey,
      refreshedTarget.store[refreshedTarget.canonicalKey],
      { acpMetadataSessionKey: refreshedTarget.canonicalKey },
    );
    if (agentCheckLegacy) {
      return agentCheckLegacy;
    }
    return { ok: true, key: refreshedTarget.canonicalKey };
  }

  if (hasSessionId) {
    const { store } = loadCombinedSessionStoreForGateway(cfg, { agentId: p.agentId });
    const matches = findVisibleSessionIdMatches({ cfg, store, p, sessionId });
    const selection = resolveSessionIdMatchSelection(matches, sessionId);
    if (selection.kind === "none") {
      return noSessionFoundResult({ p, message: `No session found: ${sessionId}` });
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
    const selectedEntry = matches.find(([matchKey]) => matchKey === selection.sessionKey)?.[1];
    const agentCheckSessionId = validateSessionAgentExists(
      cfg,
      selection.sessionKey,
      selectedEntry,
    );
    if (agentCheckSessionId) {
      return agentCheckSessionId;
    }
    return { ok: true, key: selection.sessionKey };
  }

  const parsed = hasTitle ? parseSessionTitle(p.title) : parseSessionLabel(p.label);
  if (!parsed.ok) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, parsed.error),
    };
  }
  const selectorName = hasTitle ? "title" : "label";
  const title = "title" in parsed ? parsed.title : parsed.label;

  const { store } = loadCombinedSessionStoreForGateway(cfg, { agentId: p.agentId });
  const matches = findVisibleTitleMatches({ cfg, store, p, title });
  if (matches.length === 0) {
    return noSessionFoundResult({
      p,
      message: `No session found with ${selectorName}: ${title}`,
    });
  }
  if (matches.length > 1) {
    const keys = matches.map(([key]) => key).join(", ");
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `Multiple sessions found with ${selectorName}: ${title} (${keys})`,
      ),
    };
  }

  const [matchedKey, matchedEntry] = matches[0];
  const agentCheckTitle = validateSessionAgentExists(cfg, matchedKey, matchedEntry);
  if (agentCheckTitle) {
    return agentCheckTitle;
  }
  return { ok: true, key: matchedKey };
}
