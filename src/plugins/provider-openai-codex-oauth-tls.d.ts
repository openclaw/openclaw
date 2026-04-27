import type { OpenClawConfig } from "../config/types.openclaw.js";
type PreflightFailureKind = "tls-cert" | "network";
export type OpenAIOAuthTlsPreflightResult = {
    ok: true;
} | {
    ok: false;
    kind: PreflightFailureKind;
    code?: string;
    message: string;
};
export declare function runOpenAIOAuthTlsPreflight(options?: {
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}): Promise<OpenAIOAuthTlsPreflightResult>;
export declare function formatOpenAIOAuthTlsPreflightFix(result: Exclude<OpenAIOAuthTlsPreflightResult, {
    ok: true;
}>): string;
export declare function noteOpenAIOAuthTlsPrerequisites(params: {
    cfg: OpenClawConfig;
    deep?: boolean;
}): Promise<void>;
export {};
