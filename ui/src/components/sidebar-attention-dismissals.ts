// Per-gateway, per-browser snooze state for the sidebar attention chips.
// Deliberately client-side chrome (like nav width / dock layout), not gateway
// state: dismissing a nag on one device should not acknowledge it everywhere.
import { normalizeGatewayTokenScope } from "../app/gateway-scope.ts";
import { getSafeLocalStorage } from "../local-storage.ts";

const SIDEBAR_ATTENTION_KINDS = [
  "cronFailed",
  "cronOverdue",
  "modelAuthExpired",
  "modelAuthExpiring",
] as const;
export type SidebarAttentionKind = (typeof SIDEBAR_ATTENTION_KINDS)[number];

export type SidebarAttentionDismissals = Partial<Record<SidebarAttentionKind, string>>;

// Minimal chip shape the snooze logic needs; keeps this module free of the
// component's item type so the two files cannot form an import cycle.
type DismissableChip = { kind: SidebarAttentionKind; signature: string };

const DISMISSED_STORE_PREFIX = "openclaw.control.sidebarAttention.v1:";

function dismissedStoreKey(gatewayUrl: string): string {
  return `${DISMISSED_STORE_PREFIX}${normalizeGatewayTokenScope(gatewayUrl)}`;
}

export function loadDismissals(gatewayUrl: string): SidebarAttentionDismissals {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(storage.getItem(dismissedStoreKey(gatewayUrl)) ?? "null");
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const result: SidebarAttentionDismissals = {};
    for (const kind of SIDEBAR_ATTENTION_KINDS) {
      const value = (parsed as Record<string, unknown>)[kind];
      if (typeof value === "string") {
        result[kind] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function saveDismissals(gatewayUrl: string, dismissals: SidebarAttentionDismissals) {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return;
  }
  try {
    if (Object.keys(dismissals).length === 0) {
      storage.removeItem(dismissedStoreKey(gatewayUrl));
    } else {
      storage.setItem(dismissedStoreKey(gatewayUrl), JSON.stringify(dismissals));
    }
  } catch {
    // Quota/privacy-mode failures just lose the snooze; chips reappear.
  }
}

/**
 * Drop dismissals whose chip is gone or whose entity set changed, so a state
 * that clears and later recurs surfaces again instead of staying hidden by a
 * stale snooze. Returns the input object when nothing changed.
 */
export function pruneDismissals(
  dismissals: SidebarAttentionDismissals,
  items: readonly DismissableChip[],
): SidebarAttentionDismissals {
  const next: SidebarAttentionDismissals = {};
  let changed = false;
  for (const kind of SIDEBAR_ATTENTION_KINDS) {
    const stored = dismissals[kind];
    if (stored === undefined) {
      continue;
    }
    if (items.some((item) => item.kind === kind && item.signature === stored)) {
      next[kind] = stored;
    } else {
      changed = true;
    }
  }
  return changed ? next : dismissals;
}
