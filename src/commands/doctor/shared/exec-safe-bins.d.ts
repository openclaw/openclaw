import type { OpenClawConfig } from "../../../config/types.openclaw.js";
export type ExecSafeBinCoverageHit = {
    scopePath: string;
    bin: string;
    kind: "missingProfile" | "riskySemantics";
    isInterpreter?: boolean;
    warning?: string;
};
export type ExecSafeBinTrustedDirHintHit = {
    scopePath: string;
    bin: string;
    resolvedPath: string;
};
export declare function scanExecSafeBinCoverage(cfg: OpenClawConfig): ExecSafeBinCoverageHit[];
export declare function scanExecSafeBinTrustedDirHints(cfg: OpenClawConfig): ExecSafeBinTrustedDirHintHit[];
export declare function collectExecSafeBinCoverageWarnings(params: {
    hits: ExecSafeBinCoverageHit[];
    doctorFixCommand: string;
}): string[];
export declare function collectExecSafeBinTrustedDirHintWarnings(hits: ExecSafeBinTrustedDirHintHit[]): string[];
export declare function maybeRepairExecSafeBinProfiles(cfg: OpenClawConfig): {
    config: OpenClawConfig;
    changes: string[];
    warnings: string[];
};
