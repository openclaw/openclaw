// How a memory slot owner that reports its own dreaming shapes the Dreams page.
import { t } from "../../../i18n/index.ts";
import type { DreamingState } from "./dreaming.ts";

type DreamingStatus = DreamingState["dreamingStatus"];

/**
 * Whether the memory slot owner reports its own dreaming. Any report counts, so
 * the host switch is locked on presence, not on the optional enablement flag.
 */
export function ownerReportsDreaming(status: DreamingStatus): boolean {
  return status?.reportedByProvider === true || typeof status?.reportedEnabled === "boolean";
}

/**
 * Turning the host sweep on beside a slot owner that dreams on its own would
 * dream twice, so that direction is locked. Turning it off stays possible, so an
 * installation that adopts such an owner while the host sweep runs can stop it.
 */
export function blocksHostEnable(status: DreamingStatus, enabled: boolean | null): boolean {
  return enabled === true && ownerReportsDreaming(status);
}

/**
 * The switch stays bound to the configuration it writes. While a slot owner
 * reports, the scene lights when the owner says it runs or when a phase
 * actually runs, so an owner reporting `enabled: false` cannot hide a host phase
 * that is still scheduled, and a counters-only report reads as idle. Turning
 * the host sweep on beside such an owner is locked; turning it off is not.
 */
export function resolveDreamingOwner(params: {
  status: DreamingStatus;
  pluginId: string;
  dreamingOn: boolean;
}) {
  if (!ownerReportsDreaming(params.status)) {
    return { active: params.dreamingOn, locksToggle: false };
  }
  const phaseRunning = Object.values(params.status?.phases ?? {}).some(
    (phase) => phase.enabled && phase.managedCronPresent,
  );
  return {
    active: params.status?.reportedEnabled === true || phaseRunning,
    locksToggle: !params.dreamingOn,
    pluginId: params.pluginId,
    hint: t(
      params.dreamingOn ? "dreaming.header.ownerManagedHostOn" : "dreaming.header.ownerManaged",
      { plugin: params.pluginId },
    ),
  };
}

/**
 * The status line follows whoever the scene shows as dreaming: the slot owner's
 * reported count while one reports (null when it reports none), memory-core's
 * otherwise. The review lists keep memory-core's figures.
 */
export function statusPromotedCount(status: DreamingStatus): number | null {
  return ownerReportsDreaming(status)
    ? (status?.reportedStats?.promotedToday ?? null)
    : (status?.promotedToday ?? 0);
}
