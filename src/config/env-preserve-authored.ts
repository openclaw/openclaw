import { isDeepStrictEqual } from "node:util";
import { isPlainObject } from "../infra/plain-object.js";
import { containsEnvVarReference, scanEnvTemplateTokens } from "./env-substitution.js";

/**
 * Keyed by bare variable name, deliberately: `${VAR}` and `${VAR:-x}` are one identity
 * here. These counts feed fail-closed guards against a write turning an authored
 * `$${VAR}` literal into an active reference. Keying on the authored text instead would
 * let `$${VAR}` to `${VAR:-x}` slip past the guard that already rejects `$${VAR}` to
 * `${VAR}`.
 */
type AuthoredEnvRef = { kind: "escaped" | "unescaped"; name: string };

function collectAuthoredEnvRefs(value: string): AuthoredEnvRef[] {
  return scanEnvTemplateTokens(value).map((token) => ({
    kind: token.kind === "escaped" ? ("escaped" as const) : ("unescaped" as const),
    name: token.name,
  }));
}

function hasEscapedEnvVarRef(value: string): boolean {
  return collectAuthoredEnvRefs(value).some((ref) => ref.kind === "escaped");
}

export function containsAuthoredUnescapedEnvTemplate(value: unknown): boolean {
  if (typeof value === "string") {
    return containsEnvVarReference(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsAuthoredUnescapedEnvTemplate(item));
  }
  if (isPlainObject(value)) {
    return Object.values(value).some((item) => containsAuthoredUnescapedEnvTemplate(item));
  }
  return false;
}

export function containsAuthoredEscapedEnvTemplate(value: unknown): boolean {
  if (typeof value === "string") {
    return hasEscapedEnvVarRef(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsAuthoredEscapedEnvTemplate(item));
  }
  if (isPlainObject(value)) {
    return Object.values(value).some((item) => containsAuthoredEscapedEnvTemplate(item));
  }
  return false;
}

function countAuthoredEnvRefsByPath(
  value: unknown,
  kind: AuthoredEnvRef["kind"],
): Map<string, Map<string, number>> {
  const countsByName = new Map<string, Map<string, number>>();
  const visit = (item: unknown, path: string[]) => {
    if (typeof item === "string") {
      for (const ref of collectAuthoredEnvRefs(item)) {
        if (ref.kind === kind) {
          const pathCounts = countsByName.get(ref.name) ?? new Map<string, number>();
          const pathKey = JSON.stringify(path);
          pathCounts.set(pathKey, (pathCounts.get(pathKey) ?? 0) + 1);
          countsByName.set(ref.name, pathCounts);
        }
      }
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
      for (const ref of collectAuthoredEnvRefs(parsedItem)) {
        if (ref.kind === "unescaped") {
          const pathCounts = countsByName.get(ref.name) ?? new Map<string, number>();
          const pathKey = JSON.stringify(path);
          pathCounts.set(pathKey, (pathCounts.get(pathKey) ?? 0) + 1);
          countsByName.set(ref.name, pathCounts);
        }
      }
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
  const incomingActiveCounts = countAuthoredEnvRefsByPath(incoming, "unescaped");
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
