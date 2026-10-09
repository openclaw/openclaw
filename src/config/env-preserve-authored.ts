import { isDeepStrictEqual } from "node:util";
import { isPlainObject } from "../infra/plain-object.js";
import {
  containsEnvVarReference,
  scanEnvTemplateTokens,
  type EnvTemplateToken,
} from "./env-substitution.js";

// Walks the value tree on an explicit work stack so a schema-valid deep
// document cannot overflow the call stack while callers probe for templates.
function containsDeepAuthoredEnvTemplate(
  value: unknown,
  isTemplate: (text: string) => boolean,
): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (isTemplate(current)) {
        return true;
      }
      continue;
    }
    if (Array.isArray(current)) {
      for (const item of current) {
        pending.push(item);
      }
      continue;
    }
    if (isPlainObject(current)) {
      for (const item of Object.values(current)) {
        pending.push(item);
      }
    }
  }
  return false;
}

export function containsAuthoredUnescapedEnvTemplate(value: unknown): boolean {
  return containsDeepAuthoredEnvTemplate(value, containsEnvVarReference);
}

export function containsAuthoredEscapedEnvTemplate(value: unknown): boolean {
  return containsDeepAuthoredEnvTemplate(value, (text) =>
    scanEnvTemplateTokens(text).some((ref) => ref.kind === "escaped"),
  );
}

function addEnvRefCounts(
  countsByName: Map<string, Map<string, number>>,
  value: string,
  kind: EnvTemplateToken["kind"],
  path: string[],
): void {
  for (const ref of scanEnvTemplateTokens(value)) {
    if (ref.kind === kind) {
      const pathCounts = countsByName.get(ref.name) ?? new Map<string, number>();
      const pathKey = JSON.stringify(path);
      pathCounts.set(pathKey, (pathCounts.get(pathKey) ?? 0) + 1);
      countsByName.set(ref.name, pathCounts);
    }
  }
}

/**
 * Keyed by bare variable name: `${VAR}` and `${VAR:-x}` are one identity, so changing
 * an authored `$${VAR}` literal into either active reference is rejected.
 */
function countAuthoredEnvRefsByPath(
  value: unknown,
  kind: EnvTemplateToken["kind"],
): Map<string, Map<string, number>> {
  const countsByName = new Map<string, Map<string, number>>();
  const visit = (item: unknown, path: string[]) => {
    if (typeof item === "string") {
      addEnvRefCounts(countsByName, item, kind, path);
      return;
    }
    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, [...path, String(index)]));
      return;
    }
    if (isPlainObject(item)) {
      Object.entries(item).forEach(([key, child]) => visit(child, [...path, key]));
    }
  };
  visit(value, []);
  return countsByName;
}

function countResolvedActiveEnvRefsByPath(
  incoming: unknown,
  parsed: unknown,
  resolved: unknown,
): Map<string, Map<string, number>> {
  const countsByName = new Map<string, Map<string, number>>();
  const visit = (
    incomingItem: unknown,
    parsedItem: unknown,
    resolvedItem: unknown,
    path: string[],
  ) => {
    if (typeof incomingItem === "string" && typeof parsedItem === "string") {
      if (!isDeepStrictEqual(incomingItem, resolvedItem)) {
        return;
      }
      addEnvRefCounts(countsByName, parsedItem, "substitution", path);
      return;
    }
    if (Array.isArray(incomingItem) && Array.isArray(parsedItem) && Array.isArray(resolvedItem)) {
      parsedItem.forEach((child, index) =>
        visit(incomingItem[index], child, resolvedItem[index], [...path, String(index)]),
      );
      return;
    }
    if (isPlainObject(incomingItem) && isPlainObject(parsedItem) && isPlainObject(resolvedItem)) {
      Object.entries(parsedItem).forEach(([key, child]) =>
        visit(incomingItem[key], child, resolvedItem[key], [...path, key]),
      );
    }
  };
  visit(incoming, parsed, resolved, []);
  return countsByName;
}

export function containsUnaccountedActiveEscapedEnvRef(
  incoming: unknown,
  escapedParsed: unknown,
  matchedIncoming: unknown,
  matchedParsed: unknown,
  matchedResolved: unknown,
  explicitSetPaths?: readonly (readonly string[])[],
): boolean {
  const escapedCounts = countAuthoredEnvRefsByPath(escapedParsed, "escaped");
  const incomingActiveCounts = countAuthoredEnvRefsByPath(incoming, "substitution");
  const incomingEscapedCounts = countAuthoredEnvRefsByPath(incoming, "escaped");
  const matchedActiveCounts = countResolvedActiveEnvRefsByPath(
    matchedIncoming,
    matchedParsed,
    matchedResolved,
  );
  const matchedEscapedCounts = countAuthoredEnvRefsByPath(matchedParsed, "escaped");
  return [...escapedCounts].some(([name, escapedPathCounts]) => {
    const isExplicitActivation = (path: string) => {
      if (!escapedPathCounts.has(path) || !explicitSetPaths?.length) {
        return false;
      }
      const segments: string[] = JSON.parse(path);
      return explicitSetPaths.some((supplied) =>
        supplied.every((segment, index) => segments[index] === segment),
      );
    };
    return (
      [...(incomingActiveCounts.get(name) ?? new Map())].some(
        ([path, count]) =>
          !isExplicitActivation(path) && count > (matchedActiveCounts.get(name)?.get(path) ?? 0),
      ) ||
      [...escapedPathCounts.keys()].some((path) => {
        const incomingActiveCount = incomingActiveCounts.get(name)?.get(path) ?? 0;
        return (
          !isExplicitActivation(path) &&
          incomingActiveCount > 0 &&
          (incomingEscapedCounts.get(name)?.get(path) ?? 0) <
            (matchedEscapedCounts.get(name)?.get(path) ?? 0)
        );
      })
    );
  });
}

export function preservesAuthoredEscapedEnvRefs(incoming: unknown, parsed: unknown): boolean {
  const parsedEscapedCounts = countAuthoredEnvRefsByPath(parsed, "escaped");
  const incomingEscapedCounts = countAuthoredEnvRefsByPath(incoming, "escaped");
  return [...parsedEscapedCounts].every(([name, parsedPathCounts]) =>
    [...parsedPathCounts].every(
      ([path, count]) => (incomingEscapedCounts.get(name)?.get(path) ?? 0) >= count,
    ),
  );
}
