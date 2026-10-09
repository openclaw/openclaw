// Session entry reset freshness resolves the same lifecycle rule used by reply setup.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { SessionConfig, SessionResetConfig } from "../types.base.js";
import { getCliSessionBinding } from "./cli-session-binding.js";
import { resolveSessionLifecycleTimestamps } from "./lifecycle.js";
import type { SessionLifecycleTimestamps } from "./lifecycle.types.js";
import { resolveSessionStorePathCore as resolveSessionStorePath } from "./paths.js";
import {
  evaluateSessionFreshness,
  resolveSessionResetPolicy,
  type SessionFreshness,
  type SessionResetPolicy,
  type SessionResetType,
} from "./reset.js";
import { loadSessionEntryReadOnly, type SessionAccessScope } from "./session-accessor.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope-helpers.js";
import { isNativeSessionEntryRead } from "./session-entry-read-request.js";
import { withSessionEntriesFromStoresInWorker } from "./session-entry-read-runtime.js";
import type { SessionEntry } from "./types.js";

type ResolveSessionEntryResetFreshnessParams = SessionAccessScope & {
  now?: number;
  resetOverride?: SessionResetConfig;
  resetType: SessionResetType;
  sessionCfg?: SessionConfig;
};

type ResolvedSessionEntryResetFreshness = {
  lifecycleTimestamps: SessionLifecycleTimestamps;
  resetPolicy: SessionResetPolicy;
  resetType: SessionResetType;
} & (
  | {
      state: "missing";
      entry: undefined;
      freshness: undefined;
    }
  | {
      state: "fresh" | "stale";
      entry: SessionEntry;
      freshness: SessionFreshness;
    }
);

export function hasProviderOwnedSession(entry: SessionEntry | undefined): boolean {
  const provider = normalizeOptionalString(entry?.providerOverride ?? entry?.modelProvider);
  return Boolean(provider && getCliSessionBinding(entry, provider));
}

function resolveFreshnessScope(params: ResolveSessionEntryResetFreshnessParams) {
  const agentId =
    params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey, params.defaultAgentId);
  const sessionCfg = params.sessionCfg;
  const storePath =
    params.storePath ??
    resolveSessionStorePath(sessionCfg?.store, {
      agentId,
      env: params.env,
    });
  return { ...params, agentId, storePath };
}

/** @deprecated Runtime callers should await resolveSessionEntryResetFreshnessAsync. */
export function resolveSessionEntryResetFreshness(
  params: ResolveSessionEntryResetFreshnessParams,
): ResolvedSessionEntryResetFreshness {
  const scope = resolveFreshnessScope(params);
  const entry = loadSessionEntryReadOnly(scope);
  return resolvePreparedSessionEntryResetFreshness(
    params,
    entry,
    resolveSessionLifecycleTimestamps({ ...scope, entry }),
  );
}

/** Entry and transcript fallback belong to the same retained worker snapshot. */
export async function resolveSessionEntryResetFreshnessAsync(
  params: ResolveSessionEntryResetFreshnessParams,
): Promise<ResolvedSessionEntryResetFreshness> {
  const scope = resolveFreshnessScope(params);
  // Process-held incognito state retains its existing native owner until its cutover.
  if (isNativeSessionEntryRead(scope, scope.agentId)) {
    return resolveSessionEntryResetFreshness(scope);
  }
  const sessionKey = resolveSqliteSessionKey(scope.sessionKey, scope.agentId);
  return withSessionEntriesFromStoresInWorker(
    [{ ...scope, sessionKeys: [sessionKey], lifecycleSessionKey: sessionKey }],
    ([read]) => {
      read!.assertCurrent();
      return resolvePreparedSessionEntryResetFreshness(
        params,
        read!.result.entries[0]?.entry,
        read!.result.lifecycleTimestamps,
      );
    },
    { ordered: true },
  );
}

/** Consume entry and lifecycle facts from one retained read without opening another snapshot. */
export function resolvePreparedSessionEntryResetFreshness(
  params: ResolveSessionEntryResetFreshnessParams,
  entry: SessionEntry | undefined,
  lifecycleTimestamps: SessionLifecycleTimestamps,
): ResolvedSessionEntryResetFreshness {
  const resetType = params.resetType;
  const resetPolicy = resolveSessionResetPolicy({
    sessionCfg: params.sessionCfg,
    resetType,
    resetOverride: params.resetOverride,
  });
  const base = {
    lifecycleTimestamps,
    resetPolicy,
    resetType,
  };
  if (!entry) {
    return {
      state: "missing",
      entry: undefined,
      freshness: undefined,
      ...base,
    };
  }
  const freshness =
    resetPolicy.configured !== true && hasProviderOwnedSession(entry)
      ? ({ fresh: true } satisfies SessionFreshness)
      : evaluateSessionFreshness({
          updatedAt: entry.updatedAt,
          sessionStartedAt: lifecycleTimestamps.sessionStartedAt,
          lastInteractionAt: lifecycleTimestamps.lastInteractionAt,
          now: params.now ?? Date.now(),
          policy: resetPolicy,
        });
  return {
    state: freshness.fresh ? "fresh" : "stale",
    entry,
    freshness,
    ...base,
  };
}
