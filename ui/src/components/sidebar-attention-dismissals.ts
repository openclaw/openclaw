// Per-Gateway, per-profile, per-browser snooze state for the sidebar attention chips.
// Deliberately client-side chrome (like nav width / dock layout), not gateway
// state: dismissing a nag on one device should not acknowledge it everywhere.
import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import type { ScopeUpgradeState } from "../app/device-scope-upgrade-availability.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { getSafeLocalStorage } from "../local-storage.ts";

const SIDEBAR_ATTENTION_DISMISSAL_KINDS = [
  "outbox",
  "modelAuthExpired",
  "openClawIdKeys",
  "openClawIdRequest",
  "openClawIdBrowserRequest",
  "openClawIdRecoveryUse",
  "scopeUpgrade",
  "updateAvailable",
] as const;

export type SidebarAttentionKind = (typeof SIDEBAR_ATTENTION_DISMISSAL_KINDS)[number];
export type SidebarAttentionDismissal = { kind: SidebarAttentionKind; signature: string };

// Preserve v2 failure IDs until the Gateway confirms their import.
const STORED_DISMISSAL_KINDS = [...SIDEBAR_ATTENTION_DISMISSAL_KINDS, "cronFailed"] as const;
export type SidebarAttentionDismissals = Partial<
  Record<(typeof STORED_DISMISSAL_KINDS)[number], string[]>
>;

// Origin-only v1 records have no proven account owner. Leave them untouched and unadopted.
const DISMISSED_STORE_PREFIX = "openclaw.control.sidebarAttention.v2:";

export function resolveSidebarAttentionKey(gateway: ApplicationGateway): string | null {
  const snapshot = gateway.snapshot;
  const profileId = snapshot.selfUser?.id;
  return snapshot.phase === "connected" && profileId && gateway.connection.gatewayUrl
    ? `${DISMISSED_STORE_PREFIX}${JSON.stringify([gatewayCredentialScope(gateway.connection.gatewayUrl), profileId])}`
    : null;
}

export function deferredCronFailurePrefix(key: string): string {
  return key + ":pending-failure:";
}

export function hasDeferredCronFailure(key: string): boolean {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return false;
  }
  const prefix = deferredCronFailurePrefix(key);
  try {
    for (let index = 0; index < storage.length; index++) {
      if (storage.key(index)?.startsWith(prefix)) {
        return true;
      }
    }
  } catch {
    // Browser storage can be denied while the Gateway remains available.
  }
  return false;
}

export function loadDismissals(key: string | null): SidebarAttentionDismissals {
  if (!key) {
    return {};
  }
  const storage = getSafeLocalStorage();
  if (!storage) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? "null");
    const record = asNullableRecord(parsed);
    if (!record) {
      return {};
    }
    const result: SidebarAttentionDismissals = {};
    for (const kind of STORED_DISMISSAL_KINDS) {
      const value = record[kind];
      const signatures = Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];
      if (signatures.length > 0) {
        result[kind] = [...new Set(signatures)];
      }
    }
    return result;
  } catch {
    return {};
  }
}

function saveDismissals(key: string | null, dismissals: SidebarAttentionDismissals) {
  if (!key) {
    return;
  }
  const storage = getSafeLocalStorage();
  if (!storage) {
    return;
  }
  try {
    if (Object.keys(dismissals).length === 0) {
      storage.removeItem(key);
    } else {
      storage.setItem(key, JSON.stringify(dismissals));
    }
  } catch {
    // Quota/privacy-mode failures just lose the snooze; chips reappear.
  }
}

export function retireLegacyCronDismissal(key: string, id: string): void {
  const stored = loadDismissals(key);
  if (!stored.cronFailed?.includes(id)) {
    return;
  }
  stored.cronFailed = stored.cronFailed.filter((candidate) => candidate !== id);
  if (!stored.cronFailed.length) {
    delete stored.cronFailed;
  }
  saveDismissals(key, stored);
}

/**
 * Record one dismissal via read-merge-write against the persisted map, not a
 * caller-held snapshot: another tab may have dismissed a different chip since
 * this tab last loaded, and a blind write would drop that entry.
 */
export function dismissSidebarAttention(
  key: string | null,
  dismissal: SidebarAttentionDismissal,
): SidebarAttentionDismissals {
  if (!key) {
    return {};
  }
  const stored = loadDismissals(key);
  const next = {
    ...stored,
    [dismissal.kind]: [...new Set([...(stored[dismissal.kind] ?? []), dismissal.signature])],
  };
  saveDismissals(key, next);
  return next;
}

export function resolveScopeUpgradeDismissal(params: {
  scopes: readonly string[] | undefined;
  state: ScopeUpgradeState;
}): SidebarAttentionDismissal | null {
  // Manual repair and an actionable upgrade are distinct incidents.
  return (params.state.phase === "guidance" || params.state.phase === "available") && params.scopes
    ? {
        kind: "scopeUpgrade",
        signature: JSON.stringify([
          params.state.phase === "guidance" && params.state.reason === "role"
            ? "role-guidance"
            : params.state.phase,
          ...params.scopes.toSorted(),
        ]),
      }
    : null;
}

export function resolveUpdateAttentionDismissal(params: {
  gatewayBootId?: string | null;
  updateAvailable?: UpdateAvailable | null;
  updateSchedule?: UpdateScheduleState | null;
}): SidebarAttentionDismissal | null {
  const target = params.updateSchedule?.target;
  const version =
    (target?.kind === "package" ? target.version : target?.upstreamSha) ??
    params.updateAvailable?.upstreamSha ??
    params.updateAvailable?.latestVersion;
  const gatewayBootId = params.gatewayBootId?.trim();
  const normalizedVersion = version?.trim();
  return gatewayBootId && normalizedVersion
    ? {
        kind: "updateAvailable",
        signature: JSON.stringify([normalizedVersion, gatewayBootId]),
      }
    : null;
}

export function isUpdateAttentionForced(tone: "danger" | "info" | "warn" | null | undefined) {
  return tone === "warn" || tone === "danger";
}

export function isSidebarAttentionDismissed(
  dismissals: SidebarAttentionDismissals,
  dismissal: SidebarAttentionDismissal,
): boolean {
  return dismissals[dismissal.kind]?.includes(dismissal.signature) === true;
}

export function reconcileSidebarAttentionDismissals(params: {
  active: readonly SidebarAttentionDismissal[];
  key: string | null;
  scope?: { modelAuthAgentId: string };
}): SidebarAttentionDismissals {
  const dismissals = loadDismissals(params.key);
  const active = params.active;
  const scope = params.scope;
  /**
   * Drop dismissals whose chip is gone or whose entity set changed, so a state
   * that clears and later recurs surfaces again instead of staying hidden by a
   * stale snooze. Returns the input object when nothing changed.
   */
  const next: SidebarAttentionDismissals = {};
  if (dismissals.cronFailed) {
    next.cronFailed = dismissals.cronFailed;
  }
  let changed = false;
  for (const kind of SIDEBAR_ATTENTION_DISMISSAL_KINDS) {
    const stored = dismissals[kind];
    if (!stored) {
      continue;
    }
    const current = stored.filter((signature) => {
      // A recovery use is an immutable event, not a nag that can recur. Other inventories
      // and a pending owner history read cannot re-arm an already dismissed event.
      if (kind === "openClawIdRecoveryUse") {
        return true;
      }
      // A selected-agent response can only re-arm its own auth warnings.
      const authoritative =
        !scope ||
        kind !== "modelAuthExpired" ||
        !signature.startsWith("agent:") ||
        signature.startsWith(`agent:${scope.modelAuthAgentId}\n`);
      return (
        !authoritative ||
        active.some((dismissal) => dismissal.kind === kind && dismissal.signature === signature)
      );
    });
    if (current.length > 0) {
      next[kind] = current;
    }
    if (current.length !== stored.length) {
      changed = true;
    }
  }
  const pruned = changed ? next : dismissals;
  if (pruned !== dismissals) {
    saveDismissals(params.key, pruned);
  }
  return pruned;
}

export function clearSidebarAttentionDismissal(
  key: string | null,
  kind: SidebarAttentionKind,
): SidebarAttentionDismissals {
  const stored = loadDismissals(key);
  if (!stored[kind]) {
    return stored;
  }
  const next = { ...stored };
  delete next[kind];
  saveDismissals(key, next);
  return next;
}
