import type { MemoryEmbeddingProvider, MemoryEmbeddingProviderAdapter, MemoryEmbeddingProviderCreateOptions, MemoryEmbeddingProviderRuntime } from "./memory-core-host-engine-embeddings.js";
type EmbeddingProviderResult = {
    provider: MemoryEmbeddingProvider | null;
    requestedProvider: string;
    fallbackFrom?: string;
    fallbackReason?: string;
    providerUnavailableReason?: string;
    runtime?: MemoryEmbeddingProviderRuntime;
};
type RuntimeFacadeModule = {
    createEmbeddingProvider: (options: MemoryEmbeddingProviderCreateOptions & {
        provider: string;
        fallback: string;
    }) => Promise<EmbeddingProviderResult>;
    registerBuiltInMemoryEmbeddingProviders: (register: {
        registerMemoryEmbeddingProvider: (adapter: MemoryEmbeddingProviderAdapter) => void;
    }) => void;
    removeGroundedShortTermCandidates: (params: {
        workspaceDir: string;
    }) => Promise<{
        removed: number;
        storePath: string;
    }>;
    repairDreamingArtifacts: (params: {
        workspaceDir: string;
        archiveDiary?: boolean;
        now?: Date;
    }) => Promise<RepairDreamingArtifactsResult>;
};
type GroundedRemPreviewItem = {
    text: string;
    refs: string[];
};
type GroundedRemCandidate = GroundedRemPreviewItem & {
    lean: "likely_durable" | "unclear" | "likely_situational";
};
type GroundedRemFilePreview = {
    path: string;
    facts: GroundedRemPreviewItem[];
    reflections: GroundedRemPreviewItem[];
    memoryImplications: GroundedRemPreviewItem[];
    candidates: GroundedRemCandidate[];
    renderedMarkdown: string;
};
type GroundedRemPreviewResult = {
    workspaceDir: string;
    scannedFiles: number;
    files: GroundedRemFilePreview[];
};
type ApiFacadeModule = {
    previewGroundedRemMarkdown: (params: {
        workspaceDir: string;
        inputPaths: string[];
    }) => Promise<GroundedRemPreviewResult>;
    dedupeDreamDiaryEntries: (params: {
        workspaceDir: string;
    }) => Promise<{
        dreamsPath: string;
        removed: number;
        kept: number;
    }>;
    writeBackfillDiaryEntries: (params: {
        workspaceDir: string;
        entries: Array<{
            isoDay: string;
            bodyLines: string[];
            sourcePath?: string;
        }>;
        timezone?: string;
    }) => Promise<{
        dreamsPath: string;
        written: number;
        replaced: number;
    }>;
    removeBackfillDiaryEntries: (params: {
        workspaceDir: string;
    }) => Promise<{
        dreamsPath: string;
        removed: number;
    }>;
};
type RepairDreamingArtifactsResult = {
    changed: boolean;
    archiveDir?: string;
    archivedDreamsDiary: boolean;
    archivedSessionCorpus: boolean;
    archivedSessionIngestion: boolean;
    archivedPaths: string[];
    warnings: string[];
};
export declare const createEmbeddingProvider: RuntimeFacadeModule["createEmbeddingProvider"];
export declare const registerBuiltInMemoryEmbeddingProviders: RuntimeFacadeModule["registerBuiltInMemoryEmbeddingProviders"];
export declare const removeGroundedShortTermCandidates: RuntimeFacadeModule["removeGroundedShortTermCandidates"];
export declare const repairDreamingArtifacts: RuntimeFacadeModule["repairDreamingArtifacts"];
export declare const previewGroundedRemMarkdown: ApiFacadeModule["previewGroundedRemMarkdown"];
export declare const dedupeDreamDiaryEntries: ApiFacadeModule["dedupeDreamDiaryEntries"];
export declare const writeBackfillDiaryEntries: ApiFacadeModule["writeBackfillDiaryEntries"];
export declare const removeBackfillDiaryEntries: ApiFacadeModule["removeBackfillDiaryEntries"];
export {};
