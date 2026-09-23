import { getPluginSdkAliasFacts } from "./plugin-cache-sdk.js";
import { getPluginCache } from "./plugin-cache.js";

const JITI_NORMALIZED_ALIAS_SYMBOL = Symbol.for("pathe:normalizedAlias");
const JITI_ALIAS_ROOT_SENTINELS = new Set<string | undefined>(["/", "\\", undefined]);
const JITI_CONCRETE_ALIAS_TARGET_PATTERN = /^(?:[A-Za-z]:[/\\]|[/\\])/;

function hasJitiNormalizedAliasMarker(aliasMap: Record<string, string>) {
  return Boolean(Reflect.get(aliasMap, JITI_NORMALIZED_ALIAS_SYMBOL));
}

export function createJitiAliasContentCacheKey(aliasMap: Record<string, string>) {
  return Object.entries(aliasMap)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}\0${value}`)
    .join("\0");
}

function isConcreteJitiAliasTarget(target: string | undefined): boolean {
  return typeof target === "string" && JITI_CONCRETE_ALIAS_TARGET_PATTERN.test(target);
}

function resolveJitiAliasTarget(
  aliasKey: string,
  aliasKeys: string[],
  aliasMap: Record<string, string>,
) {
  let target = aliasMap[aliasKey];
  const seenTargets = new Set<string>();
  const seenAliasKeys = new Set<string>();
  while (target && !isConcreteJitiAliasTarget(target) && !seenTargets.has(target)) {
    seenTargets.add(target);
    let nextTarget: string | undefined;
    for (const candidateKey of aliasKeys) {
      if (
        candidateKey === aliasKey ||
        aliasKey.startsWith(candidateKey) ||
        !target.startsWith(candidateKey) ||
        !JITI_ALIAS_ROOT_SENTINELS.has(target[candidateKey.length])
      ) {
        continue;
      }
      if (seenAliasKeys.has(candidateKey)) {
        return target;
      }
      seenAliasKeys.add(candidateKey);
      nextTarget = aliasMap[candidateKey] + target.slice(candidateKey.length);
      break;
    }
    if (!nextTarget || nextTarget === target) {
      break;
    }
    target = nextTarget;
  }
  return target;
}

export function normalizePluginLoaderAliasMapForJiti(
  aliasMap: Record<string, string>,
): Record<string, string> {
  if (hasJitiNormalizedAliasMarker(aliasMap)) {
    return aliasMap;
  }
  const facts = getPluginSdkAliasFacts(getPluginCache().sdk, aliasMap);
  const cachedByInput = facts.normalizedJiti;
  if (cachedByInput) {
    return cachedByInput;
  }
  const cacheKey = createJitiAliasContentCacheKey(aliasMap);
  const normalizedJitiAliasMapCache = getPluginCache().sdk.normalizedJitiAliases;
  const cached = normalizedJitiAliasMapCache.get(cacheKey);
  if (cached) {
    facts.normalizedJiti = cached;
    return cached;
  }
  const aliasDepth = new Map<string, number>();
  const getAliasDepth = (key: string) => {
    const cachedDepth = aliasDepth.get(key);
    if (cachedDepth !== undefined) {
      return cachedDepth;
    }
    const depth = key.split("/").length;
    aliasDepth.set(key, depth);
    return depth;
  };
  const normalizedAliasMap = Object.fromEntries(
    Object.entries(aliasMap).toSorted(
      ([left], [right]) => getAliasDepth(right) - getAliasDepth(left),
    ),
  );
  const aliasKeys = Object.keys(normalizedAliasMap);
  for (const aliasKey of aliasKeys) {
    const target = normalizedAliasMap[aliasKey];
    if (!target || isConcreteJitiAliasTarget(target)) {
      continue;
    }
    const resolvedTarget = resolveJitiAliasTarget(aliasKey, aliasKeys, normalizedAliasMap);
    if (resolvedTarget) {
      normalizedAliasMap[aliasKey] = resolvedTarget;
    }
  }
  Object.defineProperty(normalizedAliasMap, JITI_NORMALIZED_ALIAS_SYMBOL, {
    value: true,
    enumerable: false,
  });
  normalizedJitiAliasMapCache.set(cacheKey, normalizedAliasMap);
  facts.normalizedJiti = normalizedAliasMap;
  return normalizedAliasMap;
}
