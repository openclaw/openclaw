// Composes the dreaming section of doctor.memory.status from the host resolution,
// memory-core's managed sweep and whatever the memory slot owner reports.
import type { DoctorMemoryDreamingPayload } from "../../../packages/gateway-protocol/src/doctor-memory.js";
import type {
  MemoryPluginDreamingPhaseStatus,
  MemoryPluginDreamingStatus,
} from "../../plugins/registry-contribution-types.js";

export type ManagedDreamingCronStatus = {
  managedCronPresent: boolean;
  nextRunAtMs?: number;
};

type HostDreamingPayload = Omit<
  DoctorMemoryDreamingPayload,
  "reportedEnabled" | "reportedByProvider" | "reportedStats"
>;

/**
 * Overlays what the slot owner reported about the run itself. Anything it
 * leaves out keeps the host-resolved value. Reported enablement lands in
 * `reportedEnabled`, never in `enabled`: the latter is the configuration the
 * page's toggle writes, and overriding it would show a switch that cannot
 * change what it displays. The one `timezone` labels every phase row, so a
 * reported one is taken only when the provider reports all three phases;
 * otherwise a host phase's cron would carry the provider's zone.
 */
function applyReportedDreamingTop(
  reported: MemoryPluginDreamingStatus | null,
): Pick<DoctorMemoryDreamingPayload, "timezone" | "reportedEnabled" | "reportedByProvider"> {
  if (!reported) {
    return {};
  }
  const reportsEveryPhase =
    reported.phases?.light !== undefined &&
    reported.phases.deep !== undefined &&
    reported.phases.rem !== undefined;
  return {
    reportedByProvider: true,
    ...(reported.enabled === undefined ? {} : { reportedEnabled: reported.enabled }),
    ...(reported.timezone === undefined || !reportsEveryPhase
      ? {}
      : { timezone: reported.timezone }),
  };
}

/**
 * Merges one reported phase over the host-resolved phase. `scheduled` maps onto
 * `managedCronPresent` so a provider that dreams on its own timer — or on an
 * event, reporting `scheduled` with `cron: ""` — no longer reads as unscheduled.
 * A reported `cron`, empty or not, replaces the host schedule for that phase,
 * so the next run inherited from memory-core's sweep is dropped with it; only a
 * `nextRunAtMs` the provider reports itself survives.
 */
function applyReportedDreamingPhase<
  T extends { managedCronPresent: boolean; cron: string; nextRunAtMs?: number },
>(resolved: T, reported: MemoryPluginDreamingPhaseStatus | undefined): T {
  if (!reported) {
    return resolved;
  }
  const base = { ...resolved };
  if (reported.cron !== undefined) {
    delete base.nextRunAtMs;
  }
  return {
    ...base,
    ...(reported.enabled === undefined ? {} : { enabled: reported.enabled }),
    ...(reported.cron === undefined ? {} : { cron: reported.cron }),
    ...(reported.scheduled === undefined ? {} : { managedCronPresent: reported.scheduled }),
    ...(reported.lastRunAtMs === undefined ? {} : { lastRunAtMs: reported.lastRunAtMs }),
    ...(reported.nextRunAtMs === undefined ? {} : { nextRunAtMs: reported.nextRunAtMs }),
  };
}

/**
 * Builds the dreaming section from the host resolution, the status of
 * memory-core's one managed sweep cron (which every host phase shares) and
 * whatever the slot owner reported. Reported counters arrive as `reportedStats`
 * beside memory-core's own figures, which stay tied to the entry lists the
 * Advanced tab renders and acts on. Shared by every status path so a provider is
 * consulted regardless of search or provider-runtime availability.
 */
export function composeDreamingPayload(
  base: HostDreamingPayload,
  cronStatus: ManagedDreamingCronStatus,
  reported: MemoryPluginDreamingStatus | null,
): DoctorMemoryDreamingPayload {
  return {
    ...base,
    ...applyReportedDreamingTop(reported),
    ...(reported?.stats === undefined ? {} : { reportedStats: reported.stats }),
    phases: {
      light: applyReportedDreamingPhase(
        { ...base.phases.light, ...cronStatus },
        reported?.phases?.light,
      ),
      deep: applyReportedDreamingPhase(
        { ...base.phases.deep, ...cronStatus },
        reported?.phases?.deep,
      ),
      rem: applyReportedDreamingPhase({ ...base.phases.rem, ...cronStatus }, reported?.phases?.rem),
    },
  };
}
