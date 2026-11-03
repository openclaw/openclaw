import type {
  ControlUiSessionBadgeAccessory,
  ControlUiSessionBadgeTarget,
} from "../../../src/plugin-sdk/control-ui.js";
import {
  sessionBadgeSchema,
  type SidebarSnapshotSessionBadge as CachedSessionBadge,
} from "../components/sidebar-snapshot-data.ts";
import * as json from "../lib/snapshot-json.ts";
import type { ControlUiPluginCapability, ControlUiRegistration } from "./control-ui-capability.ts";

export type SessionBadgeRegistration = ControlUiRegistration<ControlUiSessionBadgeAccessory>;

type BadgeTargetReceipt = {
  targetKey: string;
  value: ControlUiSessionBadgeAccessory;
  signal: AbortSignal;
};
/** Live-only binding receipts belong to the existing captured snapshot, never its persisted model. */
export type SessionBadgeCaptureContext = {
  previousTargets?: ReadonlyMap<string, BadgeTargetReceipt>;
  nextTargets: Map<string, BadgeTargetReceipt>;
};

type BadgeResolution = { status: "pending" } | { status: "ready"; badge?: CachedSessionBadge };
const resolutionSchema = json.object({
  status: json.enumeration(["pending", "ready"]),
  badge: json.optional(sessionBadgeSchema),
});

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
): BadgeResolution {
  if (entry.signal.aborted) {
    return { status: "ready" };
  }
  try {
    const resolution = resolutionSchema.parse(entry.value.resolve(target));
    if (resolution.status === "pending") {
      return { status: "pending" };
    }
    if (resolution.badge === undefined) {
      return { status: "ready" };
    }
    // Strip live-only fields once; storage and native rendering share these exact facts and errors.
    return {
      status: "ready",
      badge: {
        ...resolution.badge,
        pluginId: entry.pluginId,
        id: entry.value.id,
      },
    };
  } catch (error) {
    runtime.reportError(entry.pluginId, error);
    return { status: "ready" };
  }
}

export function readSessionBadges(
  runtime: ControlUiPluginCapability,
  target: ControlUiSessionBadgeTarget,
  previous: readonly CachedSessionBadge[] = [],
  capture?: SessionBadgeCaptureContext,
): CachedSessionBadge[] {
  const targetKey = JSON.stringify({
    sessionKey: target.sessionKey,
    agentId: target.agentId,
    worktreeId: target.worktreeId,
    artifact: target.artifact,
  });
  return sessionBadgeRegistrations(runtime).flatMap((entry) => {
    const key = JSON.stringify([target.sessionKey, target.agentId, entry.key]);
    const receipt = capture?.previousTargets?.get(key);
    capture?.nextTargets.set(key, { targetKey, value: entry.value, signal: entry.signal });
    const sameBinding =
      receipt !== undefined &&
      receipt.targetKey === targetKey &&
      receipt.value === entry.value &&
      receipt.signal === entry.signal;
    const resolution = resolveSessionBadge(runtime, entry, target);
    const badge =
      resolution.status === "ready"
        ? resolution.badge
        : sameBinding
          ? previous.find((fact) => fact.pluginId === entry.pluginId && fact.id === entry.value.id)
          : undefined;
    return badge ? [badge] : [];
  });
}
