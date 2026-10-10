import type { NativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";

export type CookieSyncEdits = {
  domains: string[] | null;
  targetProfile: { value: string; sent: boolean } | null;
};

export const pendingCookieSyncEdits = new WeakMap<
  NativeDeviceSettingsCapability,
  CookieSyncEdits
>();

export function retainCookieSyncEdits(capability: NativeDeviceSettingsCapability): CookieSyncEdits {
  let edits = pendingCookieSyncEdits.get(capability);
  if (!edits) {
    edits = { domains: null, targetProfile: null };
    pendingCookieSyncEdits.set(capability, edits);
  }
  return edits;
}

export function settleCookieSyncEdit(
  capability: NativeDeviceSettingsCapability,
  key: keyof CookieSyncEdits,
  edit: CookieSyncEdits[keyof CookieSyncEdits],
) {
  const edits = pendingCookieSyncEdits.get(capability);
  if (!edits || edits[key] !== edit) {
    return;
  }
  // Completion belongs to this exact edit, including Cancel and native normalization.
  // A newer edit can have the same value and must survive the older reply.
  edits[key] = null;
  if (edits.domains === null && edits.targetProfile === null) {
    pendingCookieSyncEdits.delete(capability);
  }
}
