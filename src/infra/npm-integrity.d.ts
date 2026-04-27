import type { NpmIntegrityDrift, NpmSpecResolution } from "./install-source-utils.js";
export type NpmIntegrityDriftPayload = {
    spec: string;
    expectedIntegrity: string;
    actualIntegrity: string;
    resolution: NpmSpecResolution;
};
type ResolveNpmIntegrityDriftParams<TPayload> = {
    spec: string;
    expectedIntegrity?: string;
    resolution: NpmSpecResolution;
    createPayload: (params: {
        spec: string;
        expectedIntegrity: string;
        actualIntegrity: string;
        resolution: NpmSpecResolution;
    }) => TPayload;
    onIntegrityDrift?: (payload: TPayload) => boolean | Promise<boolean>;
    warn?: (payload: TPayload) => void;
};
export type ResolveNpmIntegrityDriftResult<TPayload> = {
    integrityDrift?: NpmIntegrityDrift;
    proceed: boolean;
    payload?: TPayload;
};
export declare function resolveNpmIntegrityDrift<TPayload>(params: ResolveNpmIntegrityDriftParams<TPayload>): Promise<ResolveNpmIntegrityDriftResult<TPayload>>;
type ResolveNpmIntegrityDriftWithDefaultMessageParams = {
    spec: string;
    expectedIntegrity?: string;
    resolution: NpmSpecResolution;
    onIntegrityDrift?: (payload: NpmIntegrityDriftPayload) => boolean | Promise<boolean>;
    warn?: (message: string) => void;
};
export declare function resolveNpmIntegrityDriftWithDefaultMessage(params: ResolveNpmIntegrityDriftWithDefaultMessageParams): Promise<{
    integrityDrift?: NpmIntegrityDrift;
    error?: string;
}>;
export {};
