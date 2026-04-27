import { type RuntimeEnv } from "../runtime.js";
export type RuntimeKind = "node" | "unknown";
type Semver = {
    major: number;
    minor: number;
    patch: number;
};
export type RuntimeDetails = {
    kind: RuntimeKind;
    version: string | null;
    execPath: string | null;
    pathEnv: string;
};
export declare function parseSemver(version: string | null): Semver | null;
export declare function isAtLeast(version: Semver | null, minimum: Semver): boolean;
export declare function detectRuntime(): RuntimeDetails;
export declare function runtimeSatisfies(details: RuntimeDetails): boolean;
export declare function isSupportedNodeVersion(version: string | null): boolean;
export declare function parseMinimumNodeEngine(engine: string | null): Semver | null;
export declare function nodeVersionSatisfiesEngine(version: string | null, engine: string | null): boolean | null;
export declare function assertSupportedRuntime(runtime?: RuntimeEnv, details?: RuntimeDetails): void;
export {};
