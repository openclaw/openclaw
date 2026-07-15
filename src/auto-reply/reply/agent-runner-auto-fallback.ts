import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  clearAutoFallbackPrimaryProbeSelection,
  entryMatchesAutoFallbackPrimaryProbe,
  hasSessionAutoModelFallbackProvenance,
  resolveAutoFallbackPrimaryProbe,
} from "../../agents/agent-scope.js";
import { resolvePersistedOverrideModelRef } from "../../agents/model-selection.js";
import type { SessionEntry } from "../../config/sessions.js";
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
  const resolveEntrySelectionRun = (): FollowupRun["run"] => {
    const entryRef = resolvePersistedOverrideModelRef({
      defaultProvider: params.run.provider,
      overrideProvider: params.entry?.providerOverride,
      overrideModel: params.entry?.modelOverride,
    });
    const hasEntryModelOverride = Boolean(entryRef);
    const authProfileId = normalizeOptionalString(params.entry?.authProfileOverride);
    const fallbackRun: FollowupRun["run"] = {
      ...params.run,
      provider: entryRef?.provider ?? params.run.provider,
      model: entryRef?.model ?? params.run.model,
      autoFallbackPrimaryProbe: undefined,
    };
    if (hasEntryModelOverride) {
      fallbackRun.hasSessionModelOverride = true;
      fallbackRun.hasAutoFallbackProvenance =
        hasSessionAutoModelFallbackProvenance(params.entry) || undefined;
    } else {
      delete fallbackRun.hasSessionModelOverride;
      delete fallbackRun.hasAutoFallbackProvenance;
    }
    if (hasEntryModelOverride && params.entry?.modelOverrideSource) {
      fallbackRun.modelOverrideSource = params.entry.modelOverrideSource;
    } else {
      delete fallbackRun.modelOverrideSource;
    }
    if (hasEntryModelOverride && authProfileId) {
      fallbackRun.authProfileId = authProfileId;
      if (params.entry?.authProfileOverrideSource) {
        fallbackRun.authProfileIdSource = params.entry.authProfileOverrideSource;
      } else {
        delete fallbackRun.authProfileIdSource;
      }
    } else if (hasEntryModelOverride) {
      delete fallbackRun.authProfileId;
      delete fallbackRun.authProfileIdSource;
    }
    return fallbackRun;
  };
  const refreshedProbe = resolveAutoFallbackPrimaryProbe({
    entry: params.entry,
    sessionKey: params.sessionKey,
    primaryProvider: probe.provider,
    primaryModel: probe.model,
  });
  if (!refreshedProbe) {
    return resolveEntrySelectionRun();
  }
  return {
    ...params.run,
    provider: refreshedProbe.provider,
    model: refreshedProbe.model,
    autoFallbackPrimaryProbe: refreshedProbe,
  };
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
  const activeSessionEntry =
    params.activeSessionStore[params.sessionKey] ?? params.getActiveSessionEntry();
  if (!activeSessionEntry || !entryMatchesAutoFallbackPrimaryProbe(activeSessionEntry, probe)) {
    return;
  }
  if (!params.storePath) {
    clearAutoFallbackPrimaryProbeSelection(activeSessionEntry);
    params.activeSessionStore[params.sessionKey] = activeSessionEntry;
    return;
  }
  const updatedEntry = await updateSessionEntry(
    { storePath: params.storePath, sessionKey: params.sessionKey },
    (persistedEntry) => {
      if (!entryMatchesAutoFallbackPrimaryProbe(persistedEntry, probe)) {
        return null;
      }
      const shouldClearAuthProfile =
        persistedEntry.authProfileOverrideSource === "auto" ||
        (persistedEntry.authProfileOverrideSource === undefined &&
          persistedEntry.authProfileOverrideCompactionCount !== undefined);
      clearAutoFallbackPrimaryProbeSelection(persistedEntry);
      return {
        providerOverride: undefined,
        modelOverride: undefined,
        modelOverrideSource: undefined,
        modelOverrideFallbackOriginProvider: undefined,
        modelOverrideFallbackOriginModel: undefined,
        ...(shouldClearAuthProfile
          ? {
              authProfileOverride: undefined,
              authProfileOverrideSource: undefined,
              authProfileOverrideCompactionCount: undefined,
            }
          : {}),
        fallbackNoticeSelectedModel: undefined,
        fallbackNoticeActiveModel: undefined,
        fallbackNoticeReason: undefined,
        updatedAt: persistedEntry.updatedAt,
      };
    },
  );
  if (updatedEntry) {
    // The persisted comparison owns selection freshness; only publish its
    // result after the conditional update accepts this probe.
    params.activeSessionStore[params.sessionKey] = updatedEntry;
  }
}
