import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import {
  normalizeBackgroundPreference,
  type BackgroundPreference,
} from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import { getSafeLocalStorage } from "../local-storage.ts";

// The active identity is learned from hello, never from the general settings blob.
// Do not restore private artwork before hello identifies the viewer on this boot.
let identity: { gateway: string; profileId: string } | null = null;
let unpersisted: { key: string; value: BackgroundPreference | undefined } | null = null;
const PREFIX = "openclaw.control.background.v1:";

export function backgroundPreferenceStorageKey(gatewayUrl: string): string | null {
  const gateway = gatewayOriginScope(gatewayUrl);
  return !identity || identity.gateway === gateway
    ? PREFIX + JSON.stringify([gateway, identity?.profileId ?? null])
    : null;
}

export function setBackgroundPreferenceIdentity(
  gatewayUrl: string,
  profileId: string | null,
): boolean {
  const gateway = gatewayOriginScope(gatewayUrl);
  if (
    (!identity && !profileId) ||
    (identity?.gateway === gateway && identity.profileId === profileId)
  ) {
    return false;
  }
  identity = profileId ? { gateway, profileId } : null;
  unpersisted = null;
  return true;
}

export function clearBackgroundPreferenceIdentity(): void {
  identity = null;
  unpersisted = null;
}

export function loadBackgroundPreference(gatewayUrl: string): BackgroundPreference | undefined {
  const key = backgroundPreferenceStorageKey(gatewayUrl);
  if (!key) {
    return undefined;
  }
  if (unpersisted?.key === key) {
    return unpersisted.value;
  }
  try {
    const preference = normalizeBackgroundPreference(
      JSON.parse(getSafeLocalStorage()?.getItem(key) ?? "null"),
    );
    return identity || preference?.source.kind !== "custom" ? preference : undefined;
  } catch {
    return undefined;
  }
}

export function saveBackgroundPreference(gatewayUrl: string, value: unknown): void {
  const key = backgroundPreferenceStorageKey(gatewayUrl);
  if (!key) {
    return;
  }
  const normalized = normalizeBackgroundPreference(value);
  // Anonymous viewers may opt out or use bundled artwork, never retain private asset references.
  if (!identity && normalized?.source.kind === "custom") {
    return;
  }
  unpersisted = { key, value: normalized };
  try {
    const storage = getSafeLocalStorage();
    if (normalized) {
      storage?.setItem(key, JSON.stringify(normalized));
    } else {
      storage?.removeItem(key);
    }
    if (storage) {
      unpersisted = null;
    }
  } catch {
    // Keep the current viewer's same-tab edit without leaking it into another identity.
  }
}
