import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { SessionContextBudgetStatus, SessionEntry } from "./types.js";

export const SESSION_CONTEXT_CAPACITY_CLEAR_PATCH = {
  contextTokens: undefined,
  contextTokensSource: undefined,
  contextBudgetStatus: undefined,
} satisfies Partial<SessionEntry>;

type SessionContextTokenOwner = Pick<
  SessionEntry,
  | "agentHarnessId"
  | "authProfileOverride"
  | "contextTokens"
  | "contextTokensSource"
  | "model"
  | "modelProvider"
  | "modelSelectionLocked"
>;

type SessionContextSelection = {
  entry: SessionContextTokenOwner | undefined;
  provider: string | null | undefined;
  model: string | null | undefined;
  agentHarnessId: string | null | undefined;
  authProfileId?: string | null;
};

type ObservedSessionAuthProfile = {
  entry: Pick<SessionEntry, "authProfileOverride" | "modelSelectionLocked"> | undefined;
  authProfileId?: string | null;
};

function matchesObservedAuthProfile(params: ObservedSessionAuthProfile): boolean {
  return (
    params.authProfileId === undefined ||
    (params.authProfileId?.trim() ?? "") === (params.entry?.authProfileOverride?.trim() ?? "")
  );
}

/** Unpinned successful accounts cannot publish capacity as if the stored pin produced it. */
export function qualifySessionContextTokenSource(
  params: ObservedSessionAuthProfile & { source: SessionEntry["contextTokensSource"] },
): SessionEntry["contextTokensSource"] {
  return params.entry?.modelSelectionLocked !== true &&
    !matchesObservedAuthProfile(params) &&
    (params.source === "runtime" || params.source === "resolved-v1")
    ? "resolved"
    : params.source;
}

function isExactProducerSelection(params: SessionContextSelection): boolean {
  const entryProvider = normalizeLowercaseStringOrEmpty(params.entry?.modelProvider);
  const entryModel = normalizeOptionalString(params.entry?.model) ?? "";
  const entryHarness = normalizeLowercaseStringOrEmpty(params.entry?.agentHarnessId);
  const currentProvider = normalizeLowercaseStringOrEmpty(params.provider);
  const currentModel = normalizeOptionalString(params.model) ?? "";
  const currentHarness = normalizeLowercaseStringOrEmpty(params.agentHarnessId);
  return Boolean(
    matchesObservedAuthProfile(params) &&
    entryProvider &&
    entryModel &&
    entryHarness &&
    entryProvider === currentProvider &&
    entryModel === currentModel &&
    entryHarness === currentHarness,
  );
}

/** Returns a persisted effective resolution only for its exact producing selection. */
function resolveMatchingPersistedResolution(params: SessionContextSelection): number | undefined {
  if (params.entry?.contextTokensSource !== "resolved-v1") {
    return undefined;
  }
  return isExactProducerSelection(params)
    ? asPositiveFiniteNumber(params.entry?.contextTokens)
    : undefined;
}

/** Returns persisted telemetry only when it belongs to the current producing selection. */
export function resolveTrustedSessionContextTokens(
  params: SessionContextSelection,
): number | undefined {
  const contextTokens = asPositiveFiniteNumber(params.entry?.contextTokens);
  if (contextTokens === undefined) {
    return undefined;
  }
  // A run that budgeted against a provider unknown-model estimate observed no real
  // limit. Only the current admitted owner's capacity may answer; if it cannot, the
  // selection stays unknown rather than restoring the stale estimate.
  if (params.entry?.contextTokensSource === "synthetic") {
    return undefined;
  }
  // Locked sessions own their native window, including rows created before
  // context-window provenance was persisted. A known selection mismatch is a
  // different owner, while missing identity remains a supported legacy state.
  if (params.entry?.modelSelectionLocked === true) {
    const entryProvider = normalizeLowercaseStringOrEmpty(params.entry?.modelProvider);
    const entryModel = normalizeOptionalString(params.entry?.model) ?? "";
    const currentProvider = normalizeLowercaseStringOrEmpty(params.provider);
    const currentModel = normalizeOptionalString(params.model) ?? "";
    if (
      (entryProvider && currentProvider && entryProvider !== currentProvider) ||
      (entryModel && currentModel && entryModel !== currentModel)
    ) {
      return undefined;
    }
    return contextTokens;
  }
  if (params.entry?.contextTokensSource !== "runtime") {
    return undefined;
  }
  return isExactProducerSelection(params) ? contextTokens : undefined;
}

export type SessionContextTokenLimits = {
  /** Explicit configured prompt capacity may replace current model telemetry. */
  effectiveConfiguredTokens?: number;
  /** Native-window constraints also bound recovery and prevent permanent retention. */
  authoredContextTokenCap?: number;
};

/** Projects the context window owned by the current session selection. */
export function resolveProjectedSessionContextTokens(
  params: SessionContextSelection & {
    resolvedContextTokens: number | null | undefined;
    configuredContextTokenLimits?: SessionContextTokenLimits;
    /**
     * Capacity answered by the session's admitted prepared owner. When supplied, a row
     * produced against a synthetic estimate takes only this owner's answer (or an
     * authored cap); an unavailable owner yields unknown, never stale or borrowed capacity.
     */
    ownerCapacity?:
      | { state: "ready"; contextTokens: number; synthetic: boolean }
      | { state: "unavailable" };
  },
): number | undefined {
  if (params.ownerCapacity && params.entry?.contextTokensSource === "synthetic") {
    const authored = asPositiveFiniteNumber(
      params.configuredContextTokenLimits?.authoredContextTokenCap,
    );
    const owned =
      params.ownerCapacity.state === "ready"
        ? asPositiveFiniteNumber(params.ownerCapacity.contextTokens)
        : undefined;
    return authored !== undefined && owned !== undefined
      ? Math.min(authored, owned)
      : (authored ?? owned);
  }
  const resolvedContextTokens = asPositiveFiniteNumber(params.resolvedContextTokens);
  const authoredContextTokens = asPositiveFiniteNumber(
    params.configuredContextTokenLimits?.effectiveConfiguredTokens,
  );

  const trustedContextTokens = resolveTrustedSessionContextTokens(params);
  const persistedResolution =
    resolvedContextTokens === undefined && authoredContextTokens === undefined
      ? resolveMatchingPersistedResolution(params)
      : undefined;
  // An authored effective cap owns the current selection. Otherwise current
  // model capacity only constrains telemetry from that exact producer tuple.
  // When synchronous model resolution is unavailable, preserve the last
  // matching effective resolution instead of publishing an unknown window.
  const currentContextTokens =
    authoredContextTokens !== undefined
      ? resolvedContextTokens === undefined
        ? authoredContextTokens
        : Math.min(authoredContextTokens, resolvedContextTokens)
      : trustedContextTokens !== undefined && resolvedContextTokens !== undefined
        ? Math.min(trustedContextTokens, resolvedContextTokens)
        : (trustedContextTokens ?? resolvedContextTokens ?? persistedResolution);
  return params.entry?.modelSelectionLocked === true
    ? (trustedContextTokens ?? currentContextTokens)
    : currentContextTokens;
}

/** Only publish a last-run prompt budget for the current session selection and cap. */
export function resolveProjectedSessionContextBudgetStatus(params: {
  entry:
    | Pick<SessionEntry, "sessionId" | "contextBudgetStatus" | "liveModelSwitchPending">
    | undefined;
  provider: string | null | undefined;
  model: string | null | undefined;
  contextTokens: number | undefined;
}): SessionContextBudgetStatus | undefined {
  const status = params.entry?.contextBudgetStatus;
  const provider = normalizeLowercaseStringOrEmpty(params.provider);
  const model = normalizeOptionalString(params.model) ?? "";
  if (
    !status ||
    !provider ||
    !model ||
    asPositiveFiniteNumber(params.contextTokens) === undefined ||
    params.entry?.liveModelSwitchPending ||
    normalizeLowercaseStringOrEmpty(status.provider) !== provider ||
    (normalizeOptionalString(status.model) ?? "") !== model ||
    !status.sessionId?.trim() ||
    status.sessionId !== params.entry?.sessionId ||
    status.contextTokenBudget !== params.contextTokens
  ) {
    return undefined;
  }
  return status;
}
