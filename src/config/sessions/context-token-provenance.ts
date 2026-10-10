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

type SessionContextTokenProjectionParams = SessionContextSelection & {
  resolvedContextTokens: number | null | undefined;
  authoredContextTokens?: number | null | undefined;
  resolvedContextTokensSource?: "resolved" | "resolved-v1" | "synthetic";
  configuredContextTokenLimits?: SessionContextTokenLimits;
  ownerCapacity?:
    | {
        state: "ready";
        contextTokens: number;
        synthetic: boolean;
        contextTokensSource?: "resolved";
      }
    | { state: "unavailable" };
};

/** Projects the selected capacity and records the owner that supplied it. */
export function resolveProjectedSessionContextTokenBudget(
  params: SessionContextTokenProjectionParams,
): { contextTokens: number; contextTokensSource: SessionEntry["contextTokensSource"] } | undefined {
  if (params.ownerCapacity && params.entry?.contextTokensSource === "synthetic") {
    const authored = asPositiveFiniteNumber(
      params.configuredContextTokenLimits?.authoredContextTokenCap ?? params.authoredContextTokens,
    );
    const owned =
      params.ownerCapacity.state === "ready"
        ? asPositiveFiniteNumber(params.ownerCapacity.contextTokens)
        : undefined;
    const contextTokens =
      authored !== undefined &&
      owned !== undefined &&
      params.ownerCapacity.state === "ready" &&
      !params.ownerCapacity.synthetic
        ? Math.min(authored, owned)
        : (authored ?? owned);
    return contextTokens === undefined
      ? undefined
      : {
          contextTokens,
          contextTokensSource:
            authored !== undefined
              ? "resolved"
              : params.ownerCapacity.state === "ready" && params.ownerCapacity.synthetic
                ? "synthetic"
                : params.ownerCapacity.state === "ready"
                  ? (params.ownerCapacity.contextTokensSource ?? "resolved-v1")
                  : "resolved-v1",
        };
  }
  const authored = asPositiveFiniteNumber(
    params.configuredContextTokenLimits?.effectiveConfiguredTokens ?? params.authoredContextTokens,
  );
  // An estimated window is a last resort, never a constraint on real authority.
  const estimate =
    params.resolvedContextTokensSource === "synthetic"
      ? asPositiveFiniteNumber(params.resolvedContextTokens)
      : undefined;
  const resolved =
    params.resolvedContextTokensSource === "synthetic"
      ? undefined
      : asPositiveFiniteNumber(params.resolvedContextTokens);
  const trusted = resolveTrustedSessionContextTokens(params);
  const resolvedSource = params.resolvedContextTokensSource ?? "resolved";
  if (params.entry?.modelSelectionLocked === true && trusted !== undefined) {
    return { contextTokens: trusted, contextTokensSource: params.entry.contextTokensSource };
  }
  if (authored !== undefined) {
    return {
      contextTokens: resolved === undefined ? authored : Math.min(authored, resolved),
      contextTokensSource: "resolved",
    };
  }
  if (trusted !== undefined && (resolved === undefined || trusted <= resolved)) {
    return { contextTokens: trusted, contextTokensSource: params.entry?.contextTokensSource };
  }
  if (resolved !== undefined) {
    return { contextTokens: resolved, contextTokensSource: resolvedSource };
  }
  const persisted = resolveMatchingPersistedResolution(params);
  if (persisted !== undefined) {
    return { contextTokens: persisted, contextTokensSource: "resolved-v1" };
  }
  return estimate === undefined
    ? undefined
    : { contextTokens: estimate, contextTokensSource: "synthetic" };
}

/** Projects the context window owned by the current session selection. */
export function resolveProjectedSessionContextTokens(
  params: SessionContextTokenProjectionParams,
): number | undefined {
  return resolveProjectedSessionContextTokenBudget(params)?.contextTokens;
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
