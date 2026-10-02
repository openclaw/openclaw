// Composes the dreaming section of doctor.memory.status from the host resolution,
// memory-core's managed sweep and whatever the memory slot owner reports.
import type {
  ShortTermDreamingStats,
  ShortTermDreamingStatsEntry,
} from "../../memory-host-sdk/dreaming.js";
import type {
  MemoryPluginDreamingPhaseStatus,
  MemoryPluginDreamingStatus,
} from "../../plugins/registry-contribution-types.js";

type DoctorMemoryDreamingPhasePayload = {
  enabled: boolean;
  cron: string;
  managedCronPresent: boolean;
  nextRunAtMs?: number;
};

type DoctorMemoryLightDreamingPayload = DoctorMemoryDreamingPhasePayload & {
  lookbackDays: number;
  limit: number;
};

type DoctorMemoryDeepDreamingPayload = DoctorMemoryDreamingPhasePayload & {
  minScore: number;
  minRecallCount: number;
  minUniqueQueries: number;
  recencyHalfLifeDays: number;
  maxAgeDays?: number;
  limit: number;
};

type DoctorMemoryRemDreamingPayload = DoctorMemoryDreamingPhasePayload & {
  lookbackDays: number;
  limit: number;
  minPatternStrength: number;
};

export type DreamingStoreStats = Omit<ShortTermDreamingStats, "storePath" | "phaseSignalPath"> & {
  storePath?: string;
  phaseSignalPath?: string;
  storeError?: string;
};

export type DoctorMemoryDreamingConfigPayload = {
  enabled: boolean;
  timezone?: string;
  verboseLogging: boolean;
  storageMode: "inline" | "separate" | "both";
  separateReports: boolean;
  shortTermEntries: ShortTermDreamingStatsEntry[];
  signalEntries: ShortTermDreamingStatsEntry[];
  promotedEntries: ShortTermDreamingStatsEntry[];
  phases: {
    light: DoctorMemoryLightDreamingPayload;
    deep: DoctorMemoryDeepDreamingPayload;
    rem: DoctorMemoryRemDreamingPayload;
  };
};

export type DoctorMemoryDreamingPayload = DoctorMemoryDreamingConfigPayload &
  DreamingStoreStats & {
    /**
     * Whether the memory slot owner reports its own dreaming as running. Kept
     * apart from `enabled`, which stays the memory-core configuration toggle the
     * page's switch writes.
     */
    reportedEnabled?: boolean;
    /**
     * Whether the memory slot owner reported anything at all. A provider may
     * validly omit `enabled` and report only phases or counters; the page still
     * has to treat the sweep as owner-run and lock the host switch.
     */
    reportedByProvider?: boolean;
    /**
     * Consolidation counters the memory slot owner reported. Kept apart from
     * memory-core's own figures above, which stay tied to the entry lists the
     * Advanced tab renders and acts on; overlaying them would show one owner's
     * count beside another owner's list.
     */
    reportedStats?: MemoryPluginDreamingStatus["stats"];
  };

export type ManagedDreamingCronStatus = {
  managedCronPresent: boolean;
  nextRunAtMs?: number;
};

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
 * whatever the slot owner reported. Shared by the search and no-search paths so
 * a provider is consulted regardless of search availability.
 */
export function composeDreamingPayload(
  base: DoctorMemoryDreamingConfigPayload & DreamingStoreStats,
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

export const EMPTY_DREAMING_STORE_STATS: DreamingStoreStats = {
  shortTermCount: 0,
  recallSignalCount: 0,
  dailySignalCount: 0,
  groundedSignalCount: 0,
  totalSignalCount: 0,
  phaseSignalCount: 0,
  lightPhaseHitCount: 0,
  remPhaseHitCount: 0,
  promotedTotal: 0,
  promotedToday: 0,
  shortTermEntries: [],
  signalEntries: [],
  promotedEntries: [],
};
