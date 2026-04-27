import type { GatewayRequestHandlers } from "./types.js";
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
type DoctorMemoryDreamingEntryPayload = {
    key: string;
    path: string;
    startLine: number;
    endLine: number;
    snippet: string;
    recallCount: number;
    dailyCount: number;
    groundedCount: number;
    totalSignalCount: number;
    lightHits: number;
    remHits: number;
    phaseHitCount: number;
    promotedAt?: string;
    lastRecalledAt?: string;
};
type DoctorMemoryDreamingPayload = {
    enabled: boolean;
    timezone?: string;
    verboseLogging: boolean;
    storageMode: "inline" | "separate" | "both";
    separateReports: boolean;
    shortTermCount: number;
    recallSignalCount: number;
    dailySignalCount: number;
    groundedSignalCount: number;
    totalSignalCount: number;
    phaseSignalCount: number;
    lightPhaseHitCount: number;
    remPhaseHitCount: number;
    promotedTotal: number;
    promotedToday: number;
    storePath?: string;
    phaseSignalPath?: string;
    lastPromotedAt?: string;
    storeError?: string;
    phaseSignalError?: string;
    shortTermEntries: DoctorMemoryDreamingEntryPayload[];
    signalEntries: DoctorMemoryDreamingEntryPayload[];
    promotedEntries: DoctorMemoryDreamingEntryPayload[];
    phases: {
        light: DoctorMemoryLightDreamingPayload;
        deep: DoctorMemoryDeepDreamingPayload;
        rem: DoctorMemoryRemDreamingPayload;
    };
};
export type DoctorMemoryStatusPayload = {
    agentId: string;
    provider?: string;
    embedding: {
        ok: boolean;
        error?: string;
    };
    dreaming?: DoctorMemoryDreamingPayload;
};
export type DoctorMemoryDreamDiaryPayload = {
    agentId: string;
    found: boolean;
    path: string;
    content?: string;
    updatedAtMs?: number;
};
export type DoctorMemoryDreamActionPayload = {
    agentId: string;
    action: "backfill" | "reset" | "resetGroundedShortTerm" | "repairDreamingArtifacts" | "dedupeDreamDiary";
    path?: string;
    found?: boolean;
    scannedFiles?: number;
    written?: number;
    replaced?: number;
    removedEntries?: number;
    removedShortTermEntries?: number;
    changed?: boolean;
    archiveDir?: string;
    archivedDreamsDiary?: boolean;
    archivedSessionCorpus?: boolean;
    archivedSessionIngestion?: boolean;
    warnings?: string[];
    dedupedEntries?: number;
    keptEntries?: number;
};
export declare const doctorHandlers: GatewayRequestHandlers;
export {};
