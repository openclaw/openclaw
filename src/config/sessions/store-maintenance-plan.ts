import {
  archiveStaleDashboardEntries,
  capEntryCount,
  pruneStaleEntries,
  pruneStaleModelRunEntries,
  shouldRunModelRunPrune,
  shouldRunSessionEntryMaintenance,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

type MaintenanceCandidate = { key: string; entry: SessionEntry };
type ArchivePhase = "dashboard" | "age" | "cap";
type RemovalReason = "model-run-pruned" | "pruned" | "capped";
type EntryMaintenanceConfig = Pick<
  ResolvedSessionMaintenanceConfig,
  | "pruneAfterMs"
  | "archiveDashboardAfterMs"
  | "modelRunPruneAfterMs"
  | "maxEntries"
  | "preserveRecentMs"
>;

/** Mutate working images only; callers own warn mode, protected keys, reads, and persistence. */
export function planSessionEntryMaintenance(params: {
  profile: "write" | "legacy-read";
  maintenance: EntryMaintenanceConfig;
  initialUnarchivedCount: number;
  forceMaintenance?: boolean;
  readPreserveKeys: () => ReadonlySet<string> | undefined;
  log?: boolean;
  readAgeCandidates: (minimumAgeMs: number | null) => Record<string, SessionEntry>;
  readCapCandidates: (
    remainingUnarchivedCount: number,
  ) => { store: Record<string, SessionEntry>; maxEntries: number } | undefined;
  onArchived?: (candidate: MaintenanceCandidate, phase: ArchivePhase) => void;
  onRemoved?: (candidate: MaintenanceCandidate, reason: RemovalReason) => void;
}) {
  // Legacy reads archive dashboards first but freeze probe pressure before that archive.
  const runModelRunPrune = shouldRunModelRunPrune({
    maintenance: params.maintenance,
    entryCount: params.initialUnarchivedCount,
    force: params.forceMaintenance,
  });
  const candidateAges = [
    params.maintenance.pruneAfterMs,
    params.maintenance.archiveDashboardAfterMs,
    runModelRunPrune ? params.maintenance.modelRunPruneAfterMs : null,
  ].filter((age): age is number => age != null && age > 0);
  const store = params.readAgeCandidates(
    candidateAges.length > 0 ? Math.min(...candidateAges) : null,
  );
  let remainingUnarchivedCount = params.initialUnarchivedCount;
  const counts = { archived: 0, capArchived: 0, modelRunPruned: 0, pruned: 0, capped: 0 };
  const options = {
    log: params.log,
    preserveRecentMs: params.maintenance.preserveRecentMs,
  };
  let protectedOptions: (typeof options & { preserveKeys?: ReadonlySet<string> }) | undefined;
  const readProtectedOptions = () =>
    (protectedOptions ??= { ...options, preserveKeys: params.readPreserveKeys() });
  // A cap can still have candidates after an empty age scan. Resolve protection once,
  // immediately before the first phase that can change an entry.
  const ageOptions = Object.keys(store).length > 0 ? readProtectedOptions() : options;
  const recordRemoval = (candidate: MaintenanceCandidate, reason: RemovalReason) => {
    remainingUnarchivedCount -= 1;
    params.onRemoved?.(candidate, reason);
  };
  const recordArchive = (candidate: MaintenanceCandidate, phase: ArchivePhase) => {
    remainingUnarchivedCount -= 1;
    counts.archived += 1;
    if (phase === "cap") {
      counts.capArchived += 1;
    }
    params.onArchived?.(candidate, phase);
  };
  const archiveDashboards = () =>
    archiveStaleDashboardEntries(store, params.maintenance.archiveDashboardAfterMs, {
      ...ageOptions,
      onArchived: (candidate) => recordArchive(candidate, "dashboard"),
    });

  if (params.profile === "legacy-read") {
    archiveDashboards();
  }
  if (runModelRunPrune) {
    counts.modelRunPruned = pruneStaleModelRunEntries(
      store,
      params.maintenance.modelRunPruneAfterMs,
      { ...ageOptions, onPruned: (candidate) => recordRemoval(candidate, "model-run-pruned") },
    );
  }
  if (params.profile === "write") {
    archiveDashboards();
  }
  if (params.profile === "write" || remainingUnarchivedCount > params.maintenance.maxEntries) {
    counts.pruned = pruneStaleEntries(store, params.maintenance.pruneAfterMs, {
      ...ageOptions,
      onPruned: (candidate) => recordRemoval(candidate, "pruned"),
      onArchived: (candidate) => recordArchive(candidate, "age"),
    });
    if (
      shouldRunSessionEntryMaintenance({
        entryCount: remainingUnarchivedCount,
        maxEntries: params.maintenance.maxEntries,
        force: params.forceMaintenance,
      })
    ) {
      const cap = params.readCapCandidates(remainingUnarchivedCount);
      if (cap && Object.keys(cap.store).length > 0) {
        counts.capped = capEntryCount(cap.store, cap.maxEntries, {
          ...readProtectedOptions(),
          onArchived: (candidate) => {
            // Indexed cap candidates may be absent from the age-candidate working image.
            if (cap.store !== store) {
              store[candidate.key] = candidate.entry;
            }
            recordArchive(candidate, "cap");
          },
          onRemoved: (candidate) => recordRemoval(candidate, "capped"),
        });
      }
    }
  }
  return { store, ...counts };
}
