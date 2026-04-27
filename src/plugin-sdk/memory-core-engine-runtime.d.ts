import type { OpenClawConfig } from "../config/types.js";
import type { MemorySearchManager } from "./memory-core-host-engine-storage.js";
export type BuiltinMemoryEmbeddingProviderDoctorMetadata = {
    providerId: string;
    authProviderId: string;
    envVars: string[];
    transport: "local" | "remote";
    autoSelectPriority?: number;
};
export type DreamingArtifactsAuditIssue = {
    severity: "warn" | "error";
    code: "dreaming-session-corpus-unreadable" | "dreaming-session-corpus-self-ingested" | "dreaming-session-ingestion-unreadable" | "dreaming-diary-unreadable";
    message: string;
    fixable: boolean;
};
export type DreamingArtifactsAuditSummary = {
    dreamsPath?: string;
    sessionCorpusDir: string;
    sessionCorpusFileCount: number;
    suspiciousSessionCorpusFileCount: number;
    suspiciousSessionCorpusLineCount: number;
    sessionIngestionPath: string;
    sessionIngestionExists: boolean;
    issues: DreamingArtifactsAuditIssue[];
};
export type RepairDreamingArtifactsResult = {
    changed: boolean;
    archiveDir?: string;
    archivedDreamsDiary: boolean;
    archivedSessionCorpus: boolean;
    archivedSessionIngestion: boolean;
    archivedPaths: string[];
    warnings: string[];
};
export type ShortTermAuditIssue = {
    severity: "warn" | "error";
    code: "recall-store-unreadable" | "recall-store-empty" | "recall-store-invalid" | "recall-lock-stale" | "recall-lock-unreadable" | "qmd-index-missing" | "qmd-index-empty" | "qmd-collections-empty";
    message: string;
    fixable: boolean;
};
export type ShortTermAuditSummary = {
    storePath: string;
    lockPath: string;
    updatedAt?: string;
    exists: boolean;
    entryCount: number;
    promotedCount: number;
    spacedEntryCount: number;
    conceptTaggedEntryCount: number;
    conceptTagScripts?: Record<string, unknown>;
    invalidEntryCount: number;
    issues: ShortTermAuditIssue[];
    qmd?: {
        dbPath?: string;
        collections?: number;
        dbBytes?: number;
    } | undefined;
};
export type RepairShortTermPromotionArtifactsResult = {
    changed: boolean;
    removedInvalidEntries: number;
    rewroteStore: boolean;
    removedStaleLock: boolean;
};
type MemoryIndexManagerFacade = {
    get(params: {
        cfg: OpenClawConfig;
        agentId: string;
        purpose?: "default" | "status";
    }): Promise<MemorySearchManager | null>;
};
type FacadeModule = {
    auditShortTermPromotionArtifacts: (params: {
        workspaceDir: string;
        qmd?: {
            dbPath?: string;
            collections?: number;
        };
    }) => Promise<ShortTermAuditSummary>;
    auditDreamingArtifacts: (params: {
        workspaceDir: string;
    }) => Promise<DreamingArtifactsAuditSummary>;
    getBuiltinMemoryEmbeddingProviderDoctorMetadata: (providerId: string) => BuiltinMemoryEmbeddingProviderDoctorMetadata | null;
    getMemorySearchManager: (params: {
        cfg: OpenClawConfig;
        agentId: string;
        purpose?: "default" | "status";
    }) => Promise<{
        manager: MemorySearchManager | null;
        error?: string;
    }>;
    listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata: () => Array<BuiltinMemoryEmbeddingProviderDoctorMetadata>;
    MemoryIndexManager: MemoryIndexManagerFacade;
    repairShortTermPromotionArtifacts: (params: {
        workspaceDir: string;
    }) => Promise<RepairShortTermPromotionArtifactsResult>;
    repairDreamingArtifacts: (params: {
        workspaceDir: string;
        archiveDiary?: boolean;
        now?: Date;
    }) => Promise<RepairDreamingArtifactsResult>;
};
export declare const auditShortTermPromotionArtifacts: FacadeModule["auditShortTermPromotionArtifacts"];
export declare const auditDreamingArtifacts: FacadeModule["auditDreamingArtifacts"];
export declare const getBuiltinMemoryEmbeddingProviderDoctorMetadata: FacadeModule["getBuiltinMemoryEmbeddingProviderDoctorMetadata"];
export declare const getMemorySearchManager: FacadeModule["getMemorySearchManager"];
export declare const listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata: FacadeModule["listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata"];
export declare const MemoryIndexManager: FacadeModule["MemoryIndexManager"];
export declare const repairShortTermPromotionArtifacts: FacadeModule["repairShortTermPromotionArtifacts"];
export declare const repairDreamingArtifacts: FacadeModule["repairDreamingArtifacts"];
export {};
