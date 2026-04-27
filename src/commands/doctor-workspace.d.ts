import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
export declare const MEMORY_SYSTEM_PROMPT: string;
export declare function shouldSuggestMemorySystem(workspaceDir: string): Promise<boolean>;
export type LegacyWorkspaceDetection = {
    activeWorkspace: string;
    legacyDirs: string[];
};
export declare function detectLegacyWorkspaceDirs(params: {
    workspaceDir: string;
}): LegacyWorkspaceDetection;
export declare function formatLegacyWorkspaceWarning(detection: LegacyWorkspaceDetection): string;
export type RootMemoryFilesDetection = {
    workspaceDir: string;
    canonicalPath: string;
    legacyPath: string;
    canonicalExists: boolean;
    legacyExists: boolean;
    canonicalBytes?: number;
    legacyBytes?: number;
};
export declare function detectRootMemoryFiles(workspaceDir: string): Promise<RootMemoryFilesDetection>;
export declare function formatRootMemoryFilesWarning(detection: RootMemoryFilesDetection): string | null;
export type RootMemoryMigrationResult = {
    changed: boolean;
    canonicalPath: string;
    legacyPath: string;
    removedLegacy: boolean;
    mergedLegacy: boolean;
    archivedLegacyPath?: string;
    copiedBytes?: number;
};
export declare function migrateLegacyRootMemoryFile(workspaceDir: string): Promise<RootMemoryMigrationResult>;
export declare function noteWorkspaceMemoryHealth(cfg: OpenClawConfig): Promise<void>;
export declare function maybeRepairWorkspaceMemoryHealth(params: {
    cfg: OpenClawConfig;
    prompter: DoctorPrompter;
}): Promise<void>;
