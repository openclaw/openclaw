import type { OpenClawConfig } from "../config/config.js";
import { getPath } from "./path-utils.js";
import { SECRET_TARGET_REGISTRY } from "./target-registry-data.js";
import {
  compileTargetRegistryEntry,
  expandPathTokens,
  materializePathTokens,
  matchPathTokens,
  type CompiledTargetRegistryEntry,
} from "./target-registry-pattern.js";
import type {
  DiscoveredConfigSecretTarget,
  ResolvedPlanTarget,
  SecretTargetRegistryEntry,
} from "./target-registry-types.js";

const COMPILED_SECRET_TARGET_REGISTRY = SECRET_TARGET_REGISTRY.map(compileTargetRegistryEntry);
const OPENCLAW_COMPILED_SECRET_TARGETS = COMPILED_SECRET_TARGET_REGISTRY.filter(
  (entry) => entry.configFile === "openclaw.json",
);
const AUTH_PROFILES_COMPILED_SECRET_TARGETS = COMPILED_SECRET_TARGET_REGISTRY.filter(
  (entry) => entry.configFile === "auth-profiles.json",
);

function buildTargetTypeIndex(): Map<string, CompiledTargetRegistryEntry[]> {
  const byType = new Map<string, CompiledTargetRegistryEntry[]>();
  const append = (type: string, entry: CompiledTargetRegistryEntry) => {
    const existing = byType.get(type);
    if (existing) {
      existing.push(entry);
      return;
    }
    byType.set(type, [entry]);
  };
  for (const entry of COMPILED_SECRET_TARGET_REGISTRY) {
    append(entry.targetType, entry);
    for (const alias of entry.targetTypeAliases ?? []) {
      append(alias, entry);
    }
  }
  return byType;
}

const TARGETS_BY_TYPE = buildTargetTypeIndex();
const KNOWN_TARGET_IDS = new Set(COMPILED_SECRET_TARGET_REGISTRY.map((entry) => entry.id));

function buildConfigTargetIdIndex(): Map<string, CompiledTargetRegistryEntry[]> {
  const byId = new Map<string, CompiledTargetRegistryEntry[]>();
  for (const entry of OPENCLAW_COMPILED_SECRET_TARGETS) {
    const existing = byId.get(entry.id);
    if (existing) {
      existing.push(entry);
      continue;
    }
    byId.set(entry.id, [entry]);
  }
  return byId;
}

const OPENCLAW_TARGETS_BY_ID = buildConfigTargetIdIndex();

function buildAuthProfileTargetIdIndex(): Map<string, CompiledTargetRegistryEntry[]> {
  const byId = new Map<string, CompiledTargetRegistryEntry[]>();
  for (const entry of AUTH_PROFILES_COMPILED_SECRET_TARGETS) {
    const existing = byId.get(entry.id);
    if (existing) {
      existing.push(entry);
      continue;
    }
    byId.set(entry.id, [entry]);
  }
  return byId;
}

const AUTH_PROFILES_TARGETS_BY_ID = buildAuthProfileTargetIdIndex();

function toResolvedPlanTarget(
  entry: CompiledTargetRegistryEntry,
  pathSegments: string[],
  captures: string[],
): ResolvedPlanTarget | null {
  const providerId =
    entry.providerIdPathSegmentIndex !== undefined
      ? pathSegments[entry.providerIdPathSegmentIndex]
      : undefined;
  const accountId =
    entry.accountIdPathSegmentIndex !== undefined
      ? pathSegments[entry.accountIdPathSegmentIndex]
      : undefined;
  const refPathSegments = entry.refPathTokens
    ? materializePathTokens(entry.refPathTokens, captures)
    : undefined;
  if (entry.refPathTokens && !refPathSegments) {
    return null;
  }
  return {
    entry,
    pathSegments,
    ...(refPathSegments ? { refPathSegments } : {}),
    ...(providerId ? { providerId } : {}),
    ...(accountId ? { accountId } : {}),
  };
}

export function listSecretTargetRegistryEntries(): SecretTargetRegistryEntry[] {
  return COMPILED_SECRET_TARGET_REGISTRY.map((entry) => ({
    id: entry.id,
    targetType: entry.targetType,
    ...(entry.targetTypeAliases ? { targetTypeAliases: [...entry.targetTypeAliases] } : {}),
    configFile: entry.configFile,
    pathPattern: entry.pathPattern,
    ...(entry.refPathPattern ? { refPathPattern: entry.refPathPattern } : {}),
    secretShape: entry.secretShape,
    expectedResolvedValue: entry.expectedResolvedValue,
    includeInPlan: entry.includeInPlan,
    includeInConfigure: entry.includeInConfigure,
    includeInAudit: entry.includeInAudit,
    ...(entry.providerIdPathSegmentIndex !== undefined
      ? { providerIdPathSegmentIndex: entry.providerIdPathSegmentIndex }
      : {}),
    ...(entry.accountIdPathSegmentIndex !== undefined
      ? { accountIdPathSegmentIndex: entry.accountIdPathSegmentIndex }
      : {}),
    ...(entry.authProfileType ? { authProfileType: entry.authProfileType } : {}),
    ...(entry.trackProviderShadowing ? { trackProviderShadowing: true } : {}),
  }));
}

export function isKnownSecretTargetType(value: unknown): value is string {
  return typeof value === "string" && TARGETS_BY_TYPE.has(value);
}

export function isKnownSecretTargetId(value: unknown): value is string {
  return typeof value === "string" && KNOWN_TARGET_IDS.has(value);
}

export function resolvePlanTargetAgainstRegistry(candidate: {
  type: string;
  pathSegments: string[];
  providerId?: string;
  accountId?: string;
}): ResolvedPlanTarget | null {
  const entries = TARGETS_BY_TYPE.get(candidate.type);
  if (!entries || entries.length === 0) {
    return null;
  }

  for (const entry of entries) {
    if (!entry.includeInPlan) {
      continue;
    }
    const matched = matchPathTokens(candidate.pathSegments, entry.pathTokens);
    if (!matched) {
      continue;
    }
    const resolved = toResolvedPlanTarget(entry, candidate.pathSegments, matched.captures);
    if (!resolved) {
      continue;
    }
    if (candidate.providerId && candidate.providerId.trim().length > 0) {
      if (!resolved.providerId || resolved.providerId !== candidate.providerId) {
        continue;
      }
    }
    if (candidate.accountId && candidate.accountId.trim().length > 0) {
      if (!resolved.accountId || resolved.accountId !== candidate.accountId) {
        continue;
      }
    }
    return resolved;
  }
  return null;
}

export function discoverConfigSecretTargets(
  config: OpenClawConfig,
): DiscoveredConfigSecretTarget[] {
  return discoverConfigSecretTargetsByIds(config);
}

export function discoverConfigSecretTargetsByIds(
  config: OpenClawConfig,
  targetIds?: Iterable<string>,
): DiscoveredConfigSecretTarget[] {
  const allowedTargetIds =
    targetIds === undefined
      ? null
      : new Set(
          Array.from(targetIds)
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
        );
  const out: DiscoveredConfigSecretTarget[] = [];
  const seen = new Set<string>();

  const discoveryEntries =
    allowedTargetIds === null
      ? OPENCLAW_COMPILED_SECRET_TARGETS
      : Array.from(allowedTargetIds).flatMap(
          (targetId) => OPENCLAW_TARGETS_BY_ID.get(targetId) ?? [],
        );

  for (const entry of discoveryEntries) {
    const expanded = expandPathTokens(config, entry.pathTokens);
    for (const match of expanded) {
      const resolved = toResolvedPlanTarget(entry, match.segments, match.captures);
      if (!resolved) {
        continue;
      }
      const key = `${entry.id}:${resolved.pathSegments.join(".")}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const refValue = resolved.refPathSegments
        ? getPath(config, resolved.refPathSegments)
        : undefined;
      out.push({
        entry,
        path: resolved.pathSegments.join("."),
        pathSegments: resolved.pathSegments,
        ...(resolved.refPathSegments
          ? {
              refPathSegments: resolved.refPathSegments,
              refPath: resolved.refPathSegments.join("."),
            }
          : {}),
        value: match.value,
        ...(resolved.providerId ? { providerId: resolved.providerId } : {}),
        ...(resolved.accountId ? { accountId: resolved.accountId } : {}),
        ...(resolved.refPathSegments ? { refValue } : {}),
      });
    }
  }

  return out;
}

export function discoverAuthProfileSecretTargets(store: unknown): DiscoveredConfigSecretTarget[] {
  return discoverAuthProfileSecretTargetsByIds(store);
}

export function discoverAuthProfileSecretTargetsByIds(
  store: unknown,
  targetIds?: Iterable<string>,
): DiscoveredConfigSecretTarget[] {
  const allowedTargetIds =
    targetIds === undefined
      ? null
      : new Set(
          Array.from(targetIds)
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
        );
  const out: DiscoveredConfigSecretTarget[] = [];
  const seen = new Set<string>();

  const discoveryEntries =
    allowedTargetIds === null
      ? AUTH_PROFILES_COMPILED_SECRET_TARGETS
      : Array.from(allowedTargetIds).flatMap(
          (targetId) => AUTH_PROFILES_TARGETS_BY_ID.get(targetId) ?? [],
        );

  for (const entry of discoveryEntries) {
    const expanded = expandPathTokens(store, entry.pathTokens);
    for (const match of expanded) {
      const resolved = toResolvedPlanTarget(entry, match.segments, match.captures);
      if (!resolved) {
        continue;
      }
      const key = `${entry.id}:${resolved.pathSegments.join(".")}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const refValue = resolved.refPathSegments
        ? getPath(store, resolved.refPathSegments)
        : undefined;
      out.push({
        entry,
        path: resolved.pathSegments.join("."),
        pathSegments: resolved.pathSegments,
        ...(resolved.refPathSegments
          ? {
              refPathSegments: resolved.refPathSegments,
              refPath: resolved.refPathSegments.join("."),
            }
          : {}),
        value: match.value,
        ...(resolved.providerId ? { providerId: resolved.providerId } : {}),
        ...(resolved.accountId ? { accountId: resolved.accountId } : {}),
        ...(resolved.refPathSegments ? { refValue } : {}),
      });
    }
  }

  return out;
}

export function listAuthProfileSecretTargetEntries(): SecretTargetRegistryEntry[] {
  return COMPILED_SECRET_TARGET_REGISTRY.filter(
    (entry) => entry.configFile === "auth-profiles.json" && entry.includeInAudit,
  );
}

export type {
  AuthProfileType,
  DiscoveredConfigSecretTarget,
  ResolvedPlanTarget,
  SecretTargetConfigFile,
  SecretTargetExpected,
  SecretTargetRegistryEntry,
  SecretTargetShape,
} from "./target-registry-types.js";
