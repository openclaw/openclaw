import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  hasSessionAutoModelFallbackProvenance,
  resolveAutoFallbackPrimaryProbe,
} from "../../agents/agent-scope.js";
import { resolvePersistedOverrideModelRef } from "../../agents/model-selection.js";
import type { SessionEntry } from "../../config/sessions.js";
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
