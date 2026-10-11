import { resolveSessionAuthProfileOverrideSource } from "./auth-profile-override-provenance.js";
import { hasSessionActiveAutoModelFallback } from "./model-override-provenance.js";
import type {
  SessionPatchProjectionSnapshot,
  SessionPatchProjectionTarget,
} from "./session-accessor.types.js";
import type { InternalSessionEntry, SessionEntry } from "./types.js";

export class SessionLabelOwnerIndex {
  readonly #owners = new Map<string, Set<string>>();

  constructor(private readonly store: Record<string, SessionEntry>) {
    for (const [sessionKey, entry] of Object.entries(this.store)) {
      this.#add(sessionKey, entry.label);
    }
  }

  isLabelInUse(label: string, excludedKeys: readonly string[]): boolean {
    for (const sessionKey of this.#owners.get(label) ?? []) {
      if (!excludedKeys.includes(sessionKey)) {
        return true;
      }
    }
    return false;
  }

  replaceEntry(
    candidateKeys: readonly string[],
    primaryKey: string,
    entry: SessionEntry,
  ): SessionEntry {
    for (const sessionKey of new Set([...candidateKeys, primaryKey])) {
      const label = this.store[sessionKey]?.label;
      if (label !== undefined) {
        this.#owners.get(label)?.delete(sessionKey);
      }
      delete this.store[sessionKey];
    }
    const cloned = structuredClone(entry);
    this.store[primaryKey] = cloned;
    this.#add(primaryKey, cloned.label);
    return cloned;
  }

  #add(sessionKey: string, label: string | undefined): void {
    if (label === undefined) {
      return;
    }
    const owners = this.#owners.get(label) ?? new Set<string>();
    owners.add(sessionKey);
    this.#owners.set(label, owners);
  }
}

type SessionModelOverrideSelection = Pick<
  SessionEntry,
  | "modelOverride"
  | "providerOverride"
  | "modelOverrideSource"
  | "modelFallbackPolicy"
  | "modelOverrideRouteResolution"
  | "agentRuntimeOverride"
>;

export function selectSessionModelOverride(
  entry: Partial<SessionModelOverrideSelection>,
): SessionModelOverrideSelection {
  return {
    modelOverride: entry.modelOverride,
    providerOverride: entry.providerOverride,
    modelOverrideSource: entry.modelOverrideSource,
    // The session preference travels with its selection across rollover.
    modelFallbackPolicy: entry.modelOverride ? entry.modelFallbackPolicy : undefined,
    modelOverrideRouteResolution: entry.modelOverrideRouteResolution,
    agentRuntimeOverride: entry.agentRuntimeOverride,
  };
}

/** Carries only user/runtime selection into a new dashboard fork. */
export function inheritSessionSelection(
  parentEntry: SessionEntry | undefined,
): Partial<InternalSessionEntry> {
  if (!parentEntry) {
    return {};
  }
  const authProfileOverrideSource = resolveSessionAuthProfileOverrideSource(parentEntry);
  const inheritModelSelection = !hasSessionActiveAutoModelFallback(parentEntry);
  const inheritAuthProfile =
    inheritModelSelection ||
    authProfileOverrideSource === "user" ||
    authProfileOverrideSource === "user-link";
  return {
    ...(inheritModelSelection && parentEntry.providerOverride
      ? { providerOverride: parentEntry.providerOverride }
      : {}),
    ...(inheritModelSelection && parentEntry.modelOverride
      ? { modelOverride: parentEntry.modelOverride }
      : {}),
    ...(inheritModelSelection && parentEntry.modelOverrideSource
      ? { modelOverrideSource: parentEntry.modelOverrideSource }
      : {}),
    ...(inheritModelSelection &&
    parentEntry.modelOverride &&
    parentEntry.modelFallbackPolicy === "configured"
      ? { modelFallbackPolicy: parentEntry.modelFallbackPolicy }
      : {}),
    ...(inheritModelSelection && parentEntry.modelOverrideRouteResolution
      ? { modelOverrideRouteResolution: parentEntry.modelOverrideRouteResolution }
      : {}),
    ...(inheritModelSelection && parentEntry.agentRuntimeOverride
      ? { agentRuntimeOverride: parentEntry.agentRuntimeOverride }
      : {}),
    ...(parentEntry.contextWindow ? { contextWindow: parentEntry.contextWindow } : {}),
    ...(parentEntry.thinkingLevel ? { thinkingLevel: parentEntry.thinkingLevel } : {}),
    ...(parentEntry.fastMode !== undefined ? { fastMode: parentEntry.fastMode } : {}),
    ...(parentEntry.toolOverrides ? { toolOverrides: parentEntry.toolOverrides } : {}),
    ...(parentEntry.verboseLevel ? { verboseLevel: parentEntry.verboseLevel } : {}),
    ...(parentEntry.traceLevel ? { traceLevel: parentEntry.traceLevel } : {}),
    ...(parentEntry.reasoningLevel ? { reasoningLevel: parentEntry.reasoningLevel } : {}),
    ...(parentEntry.elevatedLevel ? { elevatedLevel: parentEntry.elevatedLevel } : {}),
    ...(inheritAuthProfile && authProfileOverrideSource && parentEntry.authProfileOverride
      ? { authProfileOverride: parentEntry.authProfileOverride }
      : {}),
    ...(inheritAuthProfile && authProfileOverrideSource ? { authProfileOverrideSource } : {}),
  };
}

export function resolveProjectionExistingEntry(
  snapshot: SessionPatchProjectionSnapshot,
  target: SessionPatchProjectionTarget,
): SessionEntry | undefined {
  const candidateKeys = target.candidateKeys ?? [target.primaryKey];
  let freshest: SessionEntry | undefined;
  for (const candidateKey of candidateKeys) {
    const entry = snapshot.store[candidateKey];
    if (entry && (!freshest || (entry.updatedAt ?? 0) > (freshest.updatedAt ?? 0))) {
      freshest = entry;
    }
  }
  return freshest ? structuredClone(freshest) : undefined;
}
