import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parseLegacyCredentialEntry } from "../../agents/auth-profiles/legacy-flat-credential.js";
import { OPENAI_PROVIDER_ID } from "../../agents/openai-routing.js";
import { resolveLegacyRuntimeModelProviderAlias } from "./shared/legacy-runtime-model-providers.js";

const LEGACY_OPENAI_CODEX_PROVIDER_ID = "openai-codex";

export function isLegacyOpenAICodexProvider(value: unknown): boolean {
  return (
    typeof value === "string" && value.trim().toLowerCase() === LEGACY_OPENAI_CODEX_PROVIDER_ID
  );
}

export function isLegacyOpenAICodexProfileId(profileId: string): boolean {
  return profileId.trim().toLowerCase().startsWith(`${LEGACY_OPENAI_CODEX_PROVIDER_ID}:`);
}

export function canonicalLegacyAuthProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (isLegacyOpenAICodexProvider(normalized)) {
    return OPENAI_PROVIDER_ID;
  }
  const legacy = resolveLegacyRuntimeModelProviderAlias(normalized);
  return legacy?.legacyProvider === normalized ? legacy.provider : normalized;
}

export function legacyAuthProfileTarget(
  profileId: string,
): { provider: string; suffix: string } | null {
  if (profileId === "openai:codex-cli") {
    return { provider: OPENAI_PROVIDER_ID, suffix: "default" };
  }
  const separator = profileId.indexOf(":");
  if (separator <= 0) {
    return null;
  }
  const provider = profileId.slice(0, separator).trim().toLowerCase();
  const canonical = canonicalLegacyAuthProvider(provider);
  return canonical === provider
    ? null
    : { provider: canonical, suffix: profileId.slice(separator + 1).trim() || "default" };
}

export function isLegacyAuthProfileId(profileId: string): boolean {
  return legacyAuthProfileTarget(profileId) !== null;
}

export function collectRawAuthRotationProfileIds(raw: unknown): string[] {
  if (!isRecord(raw)) {
    return [];
  }
  const ids: string[] = [];
  for (const field of ["order", "lastGood", "usageStats"] as const) {
    const entries = raw[field];
    if (!isRecord(entries)) {
      continue;
    }
    if (field === "usageStats") {
      ids.push(...Object.keys(entries));
      continue;
    }
    for (const value of Object.values(entries)) {
      for (const id of Array.isArray(value) ? value : [value]) {
        if (typeof id === "string") {
          ids.push(id);
        }
      }
    }
  }
  return ids;
}

export function isReadableAuthAliasState(raw: unknown): boolean {
  if (!isRecord(raw)) {
    return false;
  }
  return (
    (raw.order === undefined ||
      (isRecord(raw.order) &&
        Object.values(raw.order).every(
          (ids) => Array.isArray(ids) && ids.every((id) => typeof id === "string"),
        ))) &&
    (raw.lastGood === undefined ||
      (isRecord(raw.lastGood) &&
        Object.values(raw.lastGood).every((id) => typeof id === "string"))) &&
    (raw.usageStats === undefined ||
      (isRecord(raw.usageStats) && Object.values(raw.usageStats).every(isRecord)))
  );
}

export function isReadableAuthAliasStore(raw: unknown): boolean {
  if (!isRecord(raw) || !isRecord(raw.profiles) || !isReadableAuthAliasState(raw)) {
    return false;
  }
  return Object.values(raw.profiles).every((value) => parseLegacyCredentialEntry(value) !== null);
}

export function allocateLegacyAuthProfileId(
  legacyProfileId: string,
  occupied: Set<string>,
): string {
  const target = legacyAuthProfileTarget(legacyProfileId);
  if (!target) {
    throw new Error(`Not a retired auth profile id: ${legacyProfileId}`);
  }
  const { provider, suffix } = target;
  const direct = `${provider}:${suffix}`;
  if (!occupied.has(direct)) {
    occupied.add(direct);
    return direct;
  }
  const collisionPrefix = isLegacyOpenAICodexProfileId(legacyProfileId) ? "chatgpt" : "cli";
  const chatgpt = `${provider}:${collisionPrefix}-${suffix}`;
  if (!occupied.has(chatgpt)) {
    occupied.add(chatgpt);
    return chatgpt;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${chatgpt}-${index}`;
    if (!occupied.has(candidate)) {
      occupied.add(candidate);
      return candidate;
    }
  }
}

export function canonicalizeLegacyAuthProfileEntries(
  profiles: Record<string, unknown>,
  options?: {
    profileIdMap?: ReadonlyMap<string, string>;
    preserveUnmappedLegacyIds?: boolean;
  },
): {
  profileIdMap: Map<string, string>;
  changed: boolean;
} {
  const occupied = new Set(Object.keys(profiles).filter((id) => !isLegacyAuthProfileId(id)));
  const reservedMappedIds = new Set(options?.profileIdMap?.values() ?? []);
  const profileIdMap = new Map<string, string>();
  let changed = false;

  for (const [profileId, rawProfile] of Object.entries({ ...profiles })) {
    if (!isRecord(rawProfile)) {
      continue;
    }
    const target = legacyAuthProfileTarget(profileId);
    const legacyId = target !== null;
    const provider =
      typeof rawProfile.provider === "string"
        ? canonicalLegacyAuthProvider(rawProfile.provider)
        : target?.provider;
    const legacyProvider =
      typeof rawProfile.provider === "string" &&
      provider !== rawProfile.provider.trim().toLowerCase();
    if (!legacyId && !legacyProvider) {
      continue;
    }
    if (target && provider !== target.provider) {
      continue;
    }
    if (options?.preserveUnmappedLegacyIds && !options.profileIdMap?.has(profileId)) {
      continue;
    }
    const mappedProfileId = options?.profileIdMap?.get(profileId);
    const nextProfileId =
      mappedProfileId && !occupied.has(mappedProfileId)
        ? mappedProfileId
        : legacyId
          ? allocateLegacyAuthProfileId(profileId, new Set([...occupied, ...reservedMappedIds]))
          : profileId;
    // Keep ids deterministic across config and store rewrites so references can be updated once.
    occupied.add(nextProfileId);
    const nextProfile = {
      ...rawProfile,
      provider,
    };
    if (nextProfileId !== profileId) {
      delete profiles[profileId];
      profileIdMap.set(profileId, nextProfileId);
    }
    profiles[nextProfileId] = nextProfile;
    changed = true;
  }

  return { profileIdMap, changed };
}

export function canonicalizeLegacyAuthOrder(
  auth: Record<string, unknown>,
  profileIdMap: Map<string, string>,
  options?: { preserveUnmappedLegacyIds?: boolean },
): boolean {
  if (!isRecord(auth.order)) {
    return false;
  }
  const order = auth.order;
  const before = structuredClone(order);
  const occupied = new Set([
    ...Object.values(order).flatMap((entries) =>
      Array.isArray(entries)
        ? entries.filter(
            (entry): entry is string => typeof entry === "string" && !isLegacyAuthProfileId(entry),
          )
        : [],
    ),
    ...profileIdMap.values(),
  ]);
  const unresolved = (entry: unknown): boolean =>
    typeof entry !== "string" ||
    Boolean(options?.preserveUnmappedLegacyIds && !profileIdMap.has(entry));
  const rewrite = (entry: unknown): unknown => {
    if (typeof entry !== "string") {
      return entry;
    }
    const mapped = profileIdMap.get(entry);
    if (mapped) {
      return mapped;
    }
    if (!isLegacyAuthProfileId(entry) || options?.preserveUnmappedLegacyIds) {
      return entry;
    }
    const allocated = allocateLegacyAuthProfileId(entry, occupied);
    profileIdMap.set(entry, allocated);
    return allocated;
  };
  const aliases = new Map<string, string[]>();
  for (const provider of Object.keys(order)) {
    const canonical = canonicalLegacyAuthProvider(provider);
    if (canonical !== provider && Array.isArray(order[provider])) {
      const group = aliases.get(canonical) ?? [];
      group.push(provider);
      aliases.set(canonical, group);
    }
  }
  for (const [provider, entries] of Object.entries(order)) {
    if (
      Array.isArray(entries) &&
      ![...aliases.values()].some((group) => group.includes(provider))
    ) {
      order[provider] = entries.map(rewrite);
    }
  }
  for (const [canonical, providers] of aliases) {
    const canonicalEntries = order[canonical];
    if (canonicalEntries !== undefined && !Array.isArray(canonicalEntries)) {
      continue;
    }
    const moved: unknown[] = [];
    let hasResolvedAlias = false;
    for (const provider of providers) {
      const entries = order[provider];
      if (!Array.isArray(entries)) {
        continue;
      }
      const retained = entries.filter(unresolved);
      const resolved = entries.filter((entry) => !unresolved(entry));
      if (resolved.length > 0 || entries.length === 0) {
        hasResolvedAlias = true;
        moved.push(...resolved.map(rewrite));
      }
      if (retained.length > 0) {
        order[provider] = retained;
      } else {
        delete order[provider];
      }
    }
    if (hasResolvedAlias) {
      const combined =
        Array.isArray(canonicalEntries) && canonicalEntries.length === 0
          ? []
          : [...moved, ...(canonicalEntries ?? [])];
      order[canonical] = [...new Set(combined)];
    }
  }
  return !isDeepStrictEqual(before, order);
}

function renameMappedProfileIdKeys(
  record: Record<string, unknown>,
  profileIdMap: Map<string, string>,
): boolean {
  let changed = false;
  for (const [key, value] of Object.entries({ ...record })) {
    const nextKey = profileIdMap.get(key);
    if (!nextKey || nextKey === key) {
      continue;
    }
    delete record[key];
    record[nextKey] = value;
    changed = true;
  }
  return changed;
}

function canonicalizeLegacyAuthLastGood(
  record: Record<string, unknown>,
  profileIdMap: Map<string, string>,
  options?: { preserveUnmappedLegacyIds?: boolean },
): boolean {
  const before = structuredClone(record);
  for (const [provider, value] of Object.entries(before)) {
    const canonical = canonicalLegacyAuthProvider(provider);
    const mapped = typeof value === "string" ? profileIdMap.get(value) : undefined;
    if (canonical !== provider && options?.preserveUnmappedLegacyIds && mapped === undefined) {
      continue;
    }
    if (canonical !== provider) {
      delete record[provider];
      if (Object.hasOwn(before, canonical)) {
        continue;
      }
    }
    record[canonical] = mapped ?? value;
  }
  return !isDeepStrictEqual(before, record);
}

export function canonicalizeLegacyAuthStore(
  raw: unknown,
  stateRaw: unknown,
  profileIdMap: ReadonlyMap<string, string>,
): number | null {
  if (!isRecord(raw) || !isRecord(raw.profiles)) {
    if (isRecord(stateRaw)) {
      canonicalizeLegacyAuthRotationState(stateRaw, new Map(profileIdMap));
    }
    return null;
  }
  const rewrite = canonicalizeLegacyAuthProfileEntries(raw.profiles, {
    profileIdMap,
    preserveUnmappedLegacyIds: true,
  });
  // Config-only and store-only profiles must keep the collision decision made before import.
  const effectiveProfileIdMap = new Map([...profileIdMap, ...rewrite.profileIdMap]);
  const rotation = canonicalizeLegacyAuthRotationState(raw, effectiveProfileIdMap);
  if (isRecord(stateRaw)) {
    canonicalizeLegacyAuthRotationState(stateRaw, effectiveProfileIdMap);
  }
  return rewrite.changed || rotation ? rewrite.profileIdMap.size : null;
}

function canonicalizeLegacyAuthRotationState(
  auth: Record<string, unknown>,
  profileIdMap: Map<string, string>,
): boolean {
  // Rotation state has no credential identity of its own. Keep unpaired legacy references
  // unresolved instead of associating them with a canonical credential that shares the suffix.
  const options = { preserveUnmappedLegacyIds: true };
  const orderChanged = canonicalizeLegacyAuthOrder(auth, profileIdMap, options);
  const usageChanged = isRecord(auth.usageStats)
    ? renameMappedProfileIdKeys(auth.usageStats, profileIdMap)
    : false;
  const lastGoodChanged = isRecord(auth.lastGood)
    ? canonicalizeLegacyAuthLastGood(auth.lastGood, profileIdMap, options)
    : false;
  return orderChanged || usageChanged || lastGoodChanged;
}
