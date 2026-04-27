import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DiscoveredConfigSecretTarget, ResolvedPlanTarget, SecretTargetRegistryEntry } from "./target-registry-types.js";
export declare function listSecretTargetRegistryEntries(): SecretTargetRegistryEntry[];
export declare function isKnownSecretTargetType(value: unknown): value is string;
export declare function isKnownSecretTargetId(value: unknown): value is string;
export declare function resolvePlanTargetAgainstRegistry(candidate: {
    type: string;
    pathSegments: string[];
    providerId?: string;
    accountId?: string;
}): ResolvedPlanTarget | null;
export declare function resolveConfigSecretTargetByPath(pathSegments: string[]): ResolvedPlanTarget | null;
export declare function discoverConfigSecretTargets(config: OpenClawConfig): DiscoveredConfigSecretTarget[];
export declare function discoverConfigSecretTargetsByIds(config: OpenClawConfig, targetIds?: Iterable<string>): DiscoveredConfigSecretTarget[];
export declare function discoverAuthProfileSecretTargets(store: unknown): DiscoveredConfigSecretTarget[];
export declare function discoverAuthProfileSecretTargetsByIds(store: unknown, targetIds?: Iterable<string>): DiscoveredConfigSecretTarget[];
export declare function listAuthProfileSecretTargetEntries(): SecretTargetRegistryEntry[];
export type { AuthProfileType, DiscoveredConfigSecretTarget, ResolvedPlanTarget, SecretTargetConfigFile, SecretTargetExpected, SecretTargetRegistryEntry, SecretTargetShape, } from "./target-registry-types.js";
