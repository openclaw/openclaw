import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { appendSelfImprovementAuditEvent } from "./audit-events.js";
import type {
  SelfImprovementAuditEventStoreFile,
  SelfImprovementDailyScorecardStoreFile,
  SelfImprovementMaintenanceResult,
  SelfImprovementMaintenanceStoreName,
  SelfImprovementMaintenanceStoreResult,
  SelfImprovementOperationalHealthSnapshotStoreFile,
  SelfImprovementProposal,
  SelfImprovementProposalStoreFile,
  SelfImprovementRecommendation,
  SelfImprovementRecommendationStoreFile,
} from "./types.js";

const STORE_DIR = "self-improvement";
const DAY_MS = 24 * 60 * 60_000;

const RETENTION = {
  recommendations: { days: 90, maxRecords: 1_000 },
  auditEvents: { days: 30, maxRecords: 500 },
  healthSnapshots: { days: 30, maxRecords: 120 },
  scorecards: { days: 180, maxRecords: 180 },
  proposals: { days: 90, maxRecords: 1_000 },
} as const;

function storePath(stateDir: string, filename: string): string {
  return path.join(stateDir, STORE_DIR, filename);
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

function cutoff(now: number, days: number): number {
  return now - days * DAY_MS;
}

function isActiveRecommendation(recommendation: SelfImprovementRecommendation): boolean {
  return recommendation.status !== "resolved" && recommendation.status !== "dismissed";
}

function isActiveProposal(proposal: SelfImprovementProposal): boolean {
  return (
    proposal.status === "pending" ||
    proposal.status === "acknowledged" ||
    proposal.status === "approved" ||
    proposal.curatorStatus === "accepted_for_workshop" ||
    proposal.curatorStatus === "needs_more_evidence" ||
    proposal.curatorStatus === "pending_review"
  );
}

function storeResult(params: {
  store: SelfImprovementMaintenanceStoreName;
  before: number;
  after: number;
  retainedActive?: number;
}): SelfImprovementMaintenanceStoreResult {
  const policy = RETENTION[params.store];
  return {
    store: params.store,
    before: params.before,
    after: params.after,
    pruned: Math.max(0, params.before - params.after),
    retainedActive: params.retainedActive ?? 0,
    retentionDays: policy.days,
    maxRecords: policy.maxRecords,
  };
}

function compactByAgeOrLatest<T>(params: {
  records: readonly T[];
  timestamp: (record: T) => number;
  cutoffAt: number;
  maxRecords: number;
  sortNewest: (left: T, right: T) => number;
}): T[] {
  const latest = new Set(
    [...params.records].toSorted(params.sortNewest).slice(0, params.maxRecords),
  );
  return params.records
    .filter((record) => params.timestamp(record) >= params.cutoffAt || latest.has(record))
    .toSorted(params.sortNewest);
}

function compactRecommendations(
  file: SelfImprovementRecommendationStoreFile,
  now: number,
): { file: SelfImprovementRecommendationStoreFile; result: SelfImprovementMaintenanceStoreResult } {
  const active = file.recommendations.filter(isActiveRecommendation);
  const closed = file.recommendations.filter((entry) => !isActiveRecommendation(entry));
  const retainedClosed = closed.filter(
    (entry) =>
      Math.max(entry.updatedAt, entry.lastSeenAt) >= cutoff(now, RETENTION.recommendations.days),
  );
  const recommendations = [...active, ...retainedClosed].toSorted(
    (left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
  );
  return {
    file: { version: 2, recommendations },
    result: storeResult({
      store: "recommendations",
      before: file.recommendations.length,
      after: recommendations.length,
      retainedActive: active.length,
    }),
  };
}

function compactAuditEvents(
  file: SelfImprovementAuditEventStoreFile,
  now: number,
): { file: SelfImprovementAuditEventStoreFile; result: SelfImprovementMaintenanceStoreResult } {
  const events = compactByAgeOrLatest({
    records: file.events,
    timestamp: (event) => event.createdAt,
    cutoffAt: cutoff(now, RETENTION.auditEvents.days),
    maxRecords: RETENTION.auditEvents.maxRecords,
    sortNewest: (left, right) =>
      right.createdAt - left.createdAt || left.id.localeCompare(right.id),
  });
  return {
    file: { version: 1, events },
    result: storeResult({ store: "auditEvents", before: file.events.length, after: events.length }),
  };
}

function compactHealthSnapshots(
  file: SelfImprovementOperationalHealthSnapshotStoreFile,
  now: number,
): {
  file: SelfImprovementOperationalHealthSnapshotStoreFile;
  result: SelfImprovementMaintenanceStoreResult;
} {
  const snapshots = compactByAgeOrLatest({
    records: file.snapshots,
    timestamp: (snapshot) => snapshot.createdAt,
    cutoffAt: cutoff(now, RETENTION.healthSnapshots.days),
    maxRecords: RETENTION.healthSnapshots.maxRecords,
    sortNewest: (left, right) =>
      right.createdAt - left.createdAt || left.id.localeCompare(right.id),
  });
  return {
    file: { version: 1, snapshots },
    result: storeResult({
      store: "healthSnapshots",
      before: file.snapshots.length,
      after: snapshots.length,
    }),
  };
}

function compactScorecards(
  file: SelfImprovementDailyScorecardStoreFile,
  now: number,
): { file: SelfImprovementDailyScorecardStoreFile; result: SelfImprovementMaintenanceStoreResult } {
  const scorecards = file.scorecards
    .filter((scorecard) => scorecard.createdAt >= cutoff(now, RETENTION.scorecards.days))
    .toSorted((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
    .slice(0, RETENTION.scorecards.maxRecords);
  return {
    file: { version: 1, scorecards },
    result: storeResult({
      store: "scorecards",
      before: file.scorecards.length,
      after: scorecards.length,
    }),
  };
}

function compactProposals(
  file: SelfImprovementProposalStoreFile,
  now: number,
): { file: SelfImprovementProposalStoreFile; result: SelfImprovementMaintenanceStoreResult } {
  const active = file.proposals.filter(isActiveProposal);
  const inactive = file.proposals.filter((proposal) => !isActiveProposal(proposal));
  const retainedInactive = inactive.filter(
    (proposal) => proposal.updatedAt >= cutoff(now, RETENTION.proposals.days),
  );
  const proposals = [...active, ...retainedInactive]
    .toSorted((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    .slice(0, RETENTION.proposals.maxRecords);
  return {
    file: { version: 1, proposals },
    result: storeResult({
      store: "proposals",
      before: file.proposals.length,
      after: proposals.length,
      retainedActive: active.length,
    }),
  };
}

export async function runSelfImprovementMaintenance(params?: {
  stateDir?: string;
  apply?: boolean;
  now?: number;
}): Promise<SelfImprovementMaintenanceResult> {
  const stateDir = params?.stateDir ?? resolveStateDir();
  const maintainedAt = params?.now ?? Date.now();
  const applied = Boolean(params?.apply);
  const recommendationsPath = storePath(stateDir, "recommendations.json");
  const auditEventsPath = storePath(stateDir, "audit-events.json");
  const healthSnapshotsPath = storePath(stateDir, "health-snapshots.json");
  const scorecardsPath = storePath(stateDir, "scorecards.json");
  const proposalsPath = storePath(stateDir, "proposals.json");

  const recommendations = compactRecommendations(
    await readJsonFile<SelfImprovementRecommendationStoreFile>(recommendationsPath, {
      version: 2,
      recommendations: [],
    }),
    maintainedAt,
  );
  const auditEvents = compactAuditEvents(
    await readJsonFile<SelfImprovementAuditEventStoreFile>(auditEventsPath, {
      version: 1,
      events: [],
    }),
    maintainedAt,
  );
  const healthSnapshots = compactHealthSnapshots(
    await readJsonFile<SelfImprovementOperationalHealthSnapshotStoreFile>(healthSnapshotsPath, {
      version: 1,
      snapshots: [],
    }),
    maintainedAt,
  );
  const scorecards = compactScorecards(
    await readJsonFile<SelfImprovementDailyScorecardStoreFile>(scorecardsPath, {
      version: 1,
      scorecards: [],
    }),
    maintainedAt,
  );
  const proposals = compactProposals(
    await readJsonFile<SelfImprovementProposalStoreFile>(proposalsPath, {
      version: 1,
      proposals: [],
    }),
    maintainedAt,
  );
  const stores = [
    recommendations.result,
    auditEvents.result,
    healthSnapshots.result,
    scorecards.result,
    proposals.result,
  ];

  let auditEventId: string | undefined;
  if (applied) {
    await writeJsonFile(recommendationsPath, recommendations.file);
    await writeJsonFile(healthSnapshotsPath, healthSnapshots.file);
    await writeJsonFile(scorecardsPath, scorecards.file);
    await writeJsonFile(proposalsPath, proposals.file);
    const maintenanceAuditEvent = await appendSelfImprovementAuditEvent({
      stateDir,
      event: {
        createdAt: maintainedAt,
        actor: "cli",
        kind: "retention_maintenance",
        targetId: "self-improvement-stores",
        summary: "Applied Self-Improvement retention maintenance.",
        metadata: {
          totalBefore: stores.reduce((sum, store) => sum + store.before, 0),
          totalAfter: stores.reduce((sum, store) => sum + store.after, 0),
          totalPruned: stores.reduce((sum, store) => sum + store.pruned, 0),
          stores: stores.map((store) => `${store.store}:${store.before}->${store.after}`),
        },
      },
    });
    auditEventId = maintenanceAuditEvent.id;
    const refreshedAuditEvents = compactAuditEvents(
      await readJsonFile<SelfImprovementAuditEventStoreFile>(auditEventsPath, {
        version: 1,
        events: [],
      }),
      maintainedAt,
    );
    await writeJsonFile(auditEventsPath, refreshedAuditEvents.file);
  }

  return {
    maintainedAt,
    dryRun: !applied,
    applied,
    stores,
    totalBefore: stores.reduce((sum, store) => sum + store.before, 0),
    totalAfter: stores.reduce((sum, store) => sum + store.after, 0),
    totalPruned: stores.reduce((sum, store) => sum + store.pruned, 0),
    ...(auditEventId ? { auditEventId } : {}),
  };
}
