import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  clearAutoFallbackPrimaryProbeSelection,
  entryMatchesAutoFallbackPrimaryProbe,
  hasSessionAutoModelFallbackProvenance,
  resolveAutoFallbackPrimaryProbe,
} from "../../agents/agent-scope.js";
import { resolvePersistedOverrideModelRef } from "../../agents/model-selection.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  resolveCollapsedSessionAuthPinSource,
  resolveSessionAuthProfileOverrideSource,
} from "../../config/sessions/auth-profile-override-provenance.js";
import { resolveSessionModelOverrideRouteResolution } from "../../config/sessions/model-override-provenance.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { shouldPreserveUserFacingSessionStateForInputProvenance } from "../../sessions/input-provenance.js";
import type { FollowupRun } from "./queue.js";

/** Decides whether to retry after rechecking auto-fallback primary probe state. */
export function resolveRunAfterAutoFallbackPrimaryProbeRecheck(params: {
  run: FollowupRun["run"];
  entry?: SessionEntry;
  sessionKey?: string;
}): FollowupRun["run"] {
  const probe = params.run.autoFallbackPrimaryProbe;
  if (!probe || !params.sessionKey || !params.entry) {
    return params.run;
  }
  const refreshedProbe = resolveAutoFallbackPrimaryProbe({
    entry: params.entry,
    sessionKey: params.sessionKey,
    primaryProvider: probe.provider,
    primaryModel: probe.model,
  });
  if (refreshedProbe) {
    return {
      ...params.run,
      provider: refreshedProbe.provider,
      model: refreshedProbe.model,
      requestedRouteResolution: "resolved",
      autoFallbackPrimaryProbe: refreshedProbe,
    };
  }
  const entryRef = resolvePersistedOverrideModelRef({
    defaultProvider: params.run.provider,
    overrideProvider: params.entry.providerOverride,
    overrideModel: params.entry.modelOverride,
  });
  const authProfileId = normalizeOptionalString(params.entry.authProfileOverride);
  const fallbackRun: FollowupRun["run"] = {
    ...params.run,
    provider: entryRef?.provider ?? params.run.provider,
    model: entryRef?.model ?? params.run.model,
    requestedRouteResolution: entryRef
      ? resolveSessionModelOverrideRouteResolution(params.entry)
      : params.run.requestedRouteResolution,
    autoFallbackPrimaryProbe: undefined,
  };
  if (entryRef) {
    fallbackRun.hasSessionModelOverride = true;
    fallbackRun.hasAutoFallbackProvenance =
      hasSessionAutoModelFallbackProvenance(params.entry) || undefined;
  } else {
    delete fallbackRun.hasSessionModelOverride;
    delete fallbackRun.hasAutoFallbackProvenance;
  }
  const modelOverrideSource = params.entry.modelOverrideSource;
  if (entryRef && modelOverrideSource && modelOverrideSource !== "default") {
    fallbackRun.modelOverrideSource = modelOverrideSource;
  } else {
    delete fallbackRun.modelOverrideSource;
  }
  if (entryRef && authProfileId) {
    fallbackRun.authProfileId = authProfileId;
    const authProfileIdSource = resolveCollapsedSessionAuthPinSource(params.entry);
    if (authProfileIdSource) {
      fallbackRun.authProfileIdSource = authProfileIdSource;
    } else {
      delete fallbackRun.authProfileIdSource;
    }
  } else if (entryRef) {
    delete fallbackRun.authProfileId;
    delete fallbackRun.authProfileIdSource;
  }
  return fallbackRun;
}

/** Clears a recovered primary probe without overwriting a newer session selection. */
export async function clearRecoveredAutoFallbackPrimaryProbeSelection(params: {
  run: FollowupRun["run"];
  provider: string;
  model: string;
  sessionKey?: string;
  activeSessionStore?: Record<string, SessionEntry>;
  getActiveSessionEntry: () => SessionEntry | undefined;
  storePath?: string;
}): Promise<void> {
  if (shouldPreserveUserFacingSessionStateForInputProvenance(params.run.inputProvenance)) {
    return;
  }
  const probe = params.run.autoFallbackPrimaryProbe;
  if (!probe || params.provider !== probe.provider || params.model !== probe.model) {
    return;
  }
  if (!params.sessionKey || !params.activeSessionStore) {
    return;
  }
  if (!params.storePath) {
    const entry = params.activeSessionStore[params.sessionKey] ?? params.getActiveSessionEntry();
    if (entry && entryMatchesAutoFallbackPrimaryProbe(entry, probe)) {
      clearAutoFallbackPrimaryProbeSelection(entry);
      params.activeSessionStore[params.sessionKey] = entry;
    }
    return;
  }
  let comparedEntry: SessionEntry | undefined;
  const updatedEntry = await updateSessionEntry(
    { storePath: params.storePath, sessionKey: params.sessionKey },
    (persistedEntry) => {
      comparedEntry = persistedEntry;
      if (!entryMatchesAutoFallbackPrimaryProbe(persistedEntry, probe)) {
        return null;
      }
      const shouldClearAuthProfile =
        resolveSessionAuthProfileOverrideSource(persistedEntry) === "auto";
      clearAutoFallbackPrimaryProbeSelection(persistedEntry);
      return {
        providerOverride: undefined,
        modelOverride: undefined,
        modelOverrideSource: undefined,
        modelOverrideRouteResolution: undefined,
        modelOverrideFallbackOriginProvider: undefined,
        modelOverrideFallbackOriginModel: undefined,
        ...(shouldClearAuthProfile
          ? {
              authProfileOverride: undefined,
              authProfileOverrideSource: undefined,
              authProfileOverrideCompactionCount: undefined,
            }
          : {}),
        fallbackNotice: undefined,
        updatedAt: persistedEntry.updatedAt,
      };
    },
  );
  // Persistence owns selection. A simultaneous cache-only edit may be refreshed
  // here; it does not need a second generation or snapshot-merge protocol.
  const authoritativeEntry = updatedEntry ?? comparedEntry;
  if (authoritativeEntry) {
    params.activeSessionStore[params.sessionKey] = authoritativeEntry;
  } else {
    delete params.activeSessionStore[params.sessionKey];
  }
}
