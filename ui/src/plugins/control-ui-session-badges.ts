import type {
  ControlUiSessionBadgeAccessory,
  ControlUiSessionBadgeTarget,
} from "../../../src/plugin-sdk/control-ui.js";
import {
  cachedSessionBadgeSchema,
  type SidebarSnapshotSessionBadge as CachedSessionBadge,
} from "../components/sidebar-snapshot-data.ts";
import type { ControlUiPluginCapability, ControlUiRegistration } from "./control-ui-capability.ts";

export type SessionBadgeRegistration = ControlUiRegistration<ControlUiSessionBadgeAccessory>;

export function sessionBadgeRegistrations(runtime: ControlUiPluginCapability) {
  return runtime
    .registrations("accessories")
    .filter(
      (entry): entry is SessionBadgeRegistration =>
        !entry.signal.aborted &&
        "presentation" in entry.value &&
        entry.value.presentation === "badge",
    );
}

export function resolveSessionBadge(
  runtime: Pick<ControlUiPluginCapability, "reportError">,
  entry: SessionBadgeRegistration,
  target: ControlUiSessionBadgeTarget,
): CachedSessionBadge | undefined {
  if (entry.signal.aborted) {
    return undefined;
  }
  try {
    const value = entry.value.resolve(target);
    if (value === undefined) {
      return undefined;
    }
    // Strip live-only fields once; storage and native rendering share these exact facts and errors.
    return cachedSessionBadgeSchema.parse({
      ...value,
      pluginId: entry.pluginId,
      id: entry.value.id,
    });
  } catch (error) {
    runtime.reportError(entry.pluginId, error);
    return undefined;
  }
}

export function readSessionBadges(
  runtime: ControlUiPluginCapability,
  target: ControlUiSessionBadgeTarget,
): CachedSessionBadge[] {
  return sessionBadgeRegistrations(runtime).flatMap((entry) => {
    const badge = resolveSessionBadge(runtime, entry, target);
    return badge ? [badge] : [];
  });
}
