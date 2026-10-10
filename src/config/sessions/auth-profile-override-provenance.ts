import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "./types.js";

const configuredModelAuthScope = Symbol("configuredModelAuthScope");

type RuntimeAuthProfileSelection = {
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  [configuredModelAuthScope]?: { profileId: string; provider: string };
};

/** Object spreads retain this runtime fact; JSON serialization does not persist it. */
export function bindConfiguredModelAuthProfileScope(
  selection: RuntimeAuthProfileSelection,
  provider?: string,
): void {
  delete selection[configuredModelAuthScope];
  const profileId = selection.authProfileId?.trim();
  if (provider && profileId && selection.authProfileIdSource === "user") {
    selection[configuredModelAuthScope] = { profileId, provider };
  }
}

/** A new account intent invalidates configuration provenance even when its values match. */
export function replaceRuntimeAuthProfileSelection(
  selection: RuntimeAuthProfileSelection,
  next: Pick<RuntimeAuthProfileSelection, "authProfileId" | "authProfileIdSource">,
): void {
  selection.authProfileId = next.authProfileId;
  selection.authProfileIdSource = next.authProfileId ? next.authProfileIdSource : undefined;
  bindConfiguredModelAuthProfileScope(selection);
}

export function readConfiguredModelAuthProfileProvider(
  selection: RuntimeAuthProfileSelection | undefined,
  currentSessionEntry?: AuthProfileOverrideProvenance,
): string | undefined {
  if (!selection || resolveCollapsedSessionAuthPinSource(currentSessionEntry) === "user") {
    return undefined;
  }
  const scope = selection[configuredModelAuthScope];
  return scope &&
    scope.profileId === selection.authProfileId?.trim() &&
    selection.authProfileIdSource === "user"
    ? scope.provider
    : undefined;
}

type ProviderLoginSessionEntry = Pick<
  SessionEntry,
  | "sessionId"
  | "providerOverride"
  | "modelProvider"
  | "authProfileOverride"
  | "authProfileOverrideSource"
  | "authProfileOverrideCompactionCount"
>;

type ProviderLoginSessionAdoption =
  | { status: "unchanged" }
  | {
      status: "patch";
      patch: {
        authProfileOverride: string;
        authProfileOverrideSource: "user";
        authProfileOverrideCompactionCount: undefined;
      };
    }
  | { status: "rejected" };

type AuthProfileOverrideProvenance = Pick<
  SessionEntry,
  "authProfileOverride" | "authProfileOverrideSource" | "authProfileOverrideCompactionCount"
>;

export function resolveSessionAuthProfileOverrideSource(
  entry: AuthProfileOverrideProvenance | undefined,
): "auto" | "user" | "user-link" | undefined {
  if (!entry?.authProfileOverride?.trim()) {
    return undefined;
  }
  const isAutomatic = typeof entry.authProfileOverrideCompactionCount === "number";
  return entry.authProfileOverrideSource || (isAutomatic ? "auto" : "user");
}

/** Keep person-linked session provenance at user-pin strength in runtime consumers. */
export function resolveCollapsedSessionAuthPinSource(
  entry: AuthProfileOverrideProvenance | undefined,
): "auto" | "user" | undefined {
  const source = resolveSessionAuthProfileOverrideSource(entry);
  return source === "user-link" ? "user" : source;
}

function matchesLoginSnapshot(
  current: ProviderLoginSessionEntry,
  snapshot: ProviderLoginSessionEntry,
): boolean {
  return (
    current.sessionId === snapshot.sessionId &&
    current.authProfileOverride === snapshot.authProfileOverride &&
    current.authProfileOverrideSource === snapshot.authProfileOverrideSource &&
    current.authProfileOverrideCompactionCount === snapshot.authProfileOverrideCompactionCount
  );
}

function resolvePersistedModelProvider(entry: ProviderLoginSessionEntry): string | undefined {
  const provider = normalizeLowercaseStringOrEmpty(entry.providerOverride ?? entry.modelProvider);
  return provider || undefined;
}

/** Decide one session-profile adoption from the authoritative row read immediately before write. */
export function decideProviderLoginSessionAdoption(params: {
  currentModelProvider: string | undefined;
  loginProvider: string;
  nextProfileId: string | undefined;
  snapshot: ProviderLoginSessionEntry | undefined;
  current: ProviderLoginSessionEntry | undefined;
}): ProviderLoginSessionAdoption {
  if (!params.nextProfileId) {
    return { status: "rejected" };
  }
  if (
    !params.currentModelProvider ||
    normalizeLowercaseStringOrEmpty(params.currentModelProvider) !==
      normalizeLowercaseStringOrEmpty(params.loginProvider) ||
    !params.current
  ) {
    return { status: "unchanged" };
  }
  const currentProvider = resolvePersistedModelProvider(params.current);
  const snapshotProvider = params.snapshot
    ? resolvePersistedModelProvider(params.snapshot)
    : undefined;
  if (
    (currentProvider &&
      currentProvider !== normalizeLowercaseStringOrEmpty(params.loginProvider)) ||
    (params.snapshot && currentProvider !== snapshotProvider)
  ) {
    return { status: "unchanged" };
  }
  if (params.snapshot) {
    if (!matchesLoginSnapshot(params.current, params.snapshot)) {
      return { status: "rejected" };
    }
  } else {
    const source = resolveCollapsedSessionAuthPinSource(params.current);
    if (source === "user" && params.current.authProfileOverride !== params.nextProfileId) {
      return { status: "rejected" };
    }
  }
  return !isProviderLoginPatchPersisted(params.current, params.nextProfileId)
    ? {
        status: "patch",
        patch: {
          authProfileOverride: params.nextProfileId,
          authProfileOverrideSource: "user",
          authProfileOverrideCompactionCount: undefined,
        },
      }
    : { status: "unchanged" };
}

/** A persisted row proves a patch only when it carries the exact login profile we wrote. */
export function isProviderLoginPatchPersisted(
  persisted: ProviderLoginSessionEntry,
  nextProfileId: string,
): boolean {
  return (
    persisted.authProfileOverride === nextProfileId &&
    persisted.authProfileOverrideSource === "user" &&
    persisted.authProfileOverrideCompactionCount === undefined
  );
}
