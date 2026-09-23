// Matches incoming config array items back to the authored rows they were
// parsed from, so env-reference restoration can edit matched rows in place
// instead of reordering or duplicating arrays that carry `${VAR}` references.
import { isDeepStrictEqual } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { isPlainObject } from "../infra/plain-object.js";
import {
  containsAuthoredEscapedEnvTemplate,
  containsAuthoredUnescapedEnvTemplate,
} from "./env-preserve-authored.js";

const ENV_VAR_PATTERN = /\$\{[A-Z_][A-Z0-9_]*\}/;

export class EnvRefArrayMutationError extends Error {
  constructor() {
    super("Config write would reorder or modify an array containing environment references.");
    this.name = "EnvRefArrayMutationError";
  }
}

/**
 * Check if a string contains any `${VAR}` env var references.
 */
export function hasEnvVarRef(value: string): boolean {
  return ENV_VAR_PATTERN.test(value);
}

type ArrayIdentityPath = string[];

function getArrayIdentityPathValue(value: unknown, path: ArrayIdentityPath): unknown {
  let current = value;
  for (const segment of path) {
    if (!isPlainObject(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function collectStableArrayIdentityPaths(value: unknown): ArrayIdentityPath[] {
  if (!isPlainObject(value)) {
    return [];
  }
  for (const key of ["id", "agentId"]) {
    const child = value[key];
    if (typeof child === "string" && !hasEnvVarRef(child)) {
      return [[key]];
    }
  }
  return [];
}

export function resolveStableArrayIdentityMatch(params: {
  incoming: readonly unknown[];
  parsed: readonly unknown[];
  parsedIndex: number;
}): { kind: "none" } | { kind: "invalid" } | { kind: "match"; incomingIndex: number } {
  const parsedItem = params.parsed[params.parsedIndex];
  const identityPaths = collectStableArrayIdentityPaths(parsedItem);
  if (identityPaths.length === 0) {
    return { kind: "none" };
  }

  let incomingIndex: number | undefined;
  let hasUniqueAuthoredIdentity = false;
  for (const identityPath of identityPaths) {
    const identityValue = getArrayIdentityPathValue(parsedItem, identityPath);
    const authoredCount = params.parsed.filter((item) =>
      isDeepStrictEqual(getArrayIdentityPathValue(item, identityPath), identityValue),
    ).length;
    if (authoredCount !== 1) {
      continue;
    }
    hasUniqueAuthoredIdentity = true;
    const incomingMatches = params.incoming.flatMap((item, index) =>
      isDeepStrictEqual(getArrayIdentityPathValue(item, identityPath), identityValue)
        ? [index]
        : [],
    );
    if (
      incomingMatches.length !== 1 ||
      (incomingIndex !== undefined && incomingIndex !== incomingMatches[0])
    ) {
      return { kind: "invalid" };
    }
    incomingIndex = incomingMatches[0];
  }
  if (incomingIndex !== undefined) {
    return { kind: "match", incomingIndex };
  }
  return hasUniqueAuthoredIdentity ? { kind: "invalid" } : { kind: "none" };
}

function collectLiteralArrayIdentityPaths(
  value: unknown,
  path: ArrayIdentityPath = [],
): ArrayIdentityPath[] {
  if (typeof value === "string") {
    return hasEnvVarRef(value) ? [] : [path];
  }
  if (!isPlainObject(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    collectLiteralArrayIdentityPaths(child, [...path, key]),
  );
}

function hasStableSameIndexLiteralShape(params: {
  incoming: unknown[];
  parsed: unknown[];
  parsedIndex: number;
}): boolean {
  if (params.incoming.length !== params.parsed.length) {
    return false;
  }
  const parsedItem = params.parsed[params.parsedIndex];
  const literalPaths = collectLiteralArrayIdentityPaths(parsedItem);
  if (
    literalPaths.length === 0 ||
    literalPaths.some((identityPath) => {
      const identityValue = getArrayIdentityPathValue(parsedItem, identityPath);
      return !isDeepStrictEqual(
        getArrayIdentityPathValue(params.incoming[params.parsedIndex], identityPath),
        identityValue,
      );
    })
  ) {
    return false;
  }
  return literalPaths.some((identityPath) => {
    const identityValue = getArrayIdentityPathValue(parsedItem, identityPath);
    const authoredCount = params.parsed.filter((item) =>
      isDeepStrictEqual(getArrayIdentityPathValue(item, identityPath), identityValue),
    ).length;
    const incomingCount = params.incoming.filter((item) =>
      isDeepStrictEqual(getArrayIdentityPathValue(item, identityPath), identityValue),
    ).length;
    return authoredCount === 1 && incomingCount === 1;
  });
}

function matchesArrayElementAtSameIndex(
  incoming: unknown,
  parsed: unknown,
  resolved: unknown,
): boolean {
  return isDeepStrictEqual(incoming, parsed) || isDeepStrictEqual(incoming, resolved);
}

function matchesRetainedArrayItem(params: {
  incoming: unknown[];
  incomingIndex: number;
  parsed: unknown[];
  parsedIndex: number;
  resolved: unknown[];
}): boolean {
  if (
    matchesArrayElementAtSameIndex(
      params.incoming[params.incomingIndex],
      params.parsed[params.parsedIndex],
      params.resolved[params.parsedIndex],
    )
  ) {
    return true;
  }
  const stableIdentity = resolveStableArrayIdentityMatch({
    incoming: params.incoming,
    parsed: params.parsed,
    parsedIndex: params.parsedIndex,
  });
  return stableIdentity.kind === "match" && stableIdentity.incomingIndex === params.incomingIndex;
}

function hasStableSameIndexNeighbors(params: {
  incoming: unknown[];
  parsed: unknown[];
  parsedIndex: number;
  resolved: unknown[];
}): boolean {
  return (
    params.incoming.length === params.parsed.length &&
    params.parsed.every(
      (item, index) =>
        index === params.parsedIndex ||
        matchesArrayElementAtSameIndex(params.incoming[index], item, params.resolved[index]),
    )
  );
}

function matchUniqueRetainedArrayItems(params: {
  incoming: unknown[];
  parsed: unknown[];
  resolved: unknown[];
}): Map<number, number> | undefined {
  if (params.incoming.length >= params.parsed.length) {
    return undefined;
  }

  const earliestParsedIndexes: number[] = [];
  let nextParsedIndex = 0;
  for (let incomingIndex = 0; incomingIndex < params.incoming.length; incomingIndex += 1) {
    const parsedIndex = params.parsed.findIndex(
      (_parsedItem, index) =>
        index >= nextParsedIndex &&
        matchesRetainedArrayItem({
          ...params,
          incomingIndex,
          parsedIndex: index,
        }),
    );
    if (parsedIndex < 0) {
      return undefined;
    }
    earliestParsedIndexes.push(parsedIndex);
    nextParsedIndex = parsedIndex + 1;
  }

  const latestParsedIndexes = Array.from({ length: params.incoming.length }, () => 0);
  nextParsedIndex = params.parsed.length - 1;
  for (let incomingIndex = params.incoming.length - 1; incomingIndex >= 0; incomingIndex -= 1) {
    let parsedIndex = nextParsedIndex;
    while (
      parsedIndex >= 0 &&
      !matchesRetainedArrayItem({
        ...params,
        incomingIndex,
        parsedIndex,
      })
    ) {
      parsedIndex -= 1;
    }
    if (parsedIndex < 0) {
      return undefined;
    }
    latestParsedIndexes[incomingIndex] = parsedIndex;
    nextParsedIndex = parsedIndex - 1;
  }

  if (!isDeepStrictEqual(earliestParsedIndexes, latestParsedIndexes)) {
    return undefined;
  }
  return new Map(
    earliestParsedIndexes.map((parsedIndex, incomingIndex) => [parsedIndex, incomingIndex]),
  );
}

export function matchAuthoredTemplateArrayItems(params: {
  incoming: unknown[];
  parsed: unknown[];
  resolved: unknown[];
}): Map<number, number> {
  const templateIndexes = params.parsed.flatMap((item, index) =>
    containsAuthoredUnescapedEnvTemplate(item) ? [index] : [],
  );
  if (
    params.incoming.length === params.parsed.length &&
    params.incoming.every((item, index) =>
      matchesArrayElementAtSameIndex(item, params.parsed[index], params.resolved[index]),
    )
  ) {
    return new Map(templateIndexes.map((index) => [index, index]));
  }
  const retainedDeletionMatches = matchUniqueRetainedArrayItems(params);
  if (retainedDeletionMatches) {
    return new Map(
      templateIndexes.flatMap((parsedIndex) => {
        const incomingIndex = retainedDeletionMatches.get(parsedIndex);
        return incomingIndex === undefined ? [] : [[parsedIndex, incomingIndex]];
      }),
    );
  }

  const matches = new Map<number, number>();
  const usedIncomingIndexes = new Set<number>();
  const addMatch = (parsedIndex: number, incomingIndex: number) => {
    if (usedIncomingIndexes.has(incomingIndex)) {
      throw new EnvRefArrayMutationError();
    }
    matches.set(parsedIndex, incomingIndex);
    usedIncomingIndexes.add(incomingIndex);
  };
  for (const parsedIndex of templateIndexes) {
    const parsedItem = params.parsed[parsedIndex];
    const stableIdentity = resolveStableArrayIdentityMatch({
      incoming: params.incoming,
      parsed: params.parsed,
      parsedIndex,
    });
    if (stableIdentity.kind !== "none") {
      if (stableIdentity.kind === "invalid") {
        throw new EnvRefArrayMutationError();
      }
      addMatch(parsedIndex, stableIdentity.incomingIndex);
      continue;
    }

    if (
      parsedIndex < params.incoming.length &&
      matchesArrayElementAtSameIndex(
        params.incoming[parsedIndex],
        parsedItem,
        params.resolved[parsedIndex],
      )
    ) {
      const precedingItemsRemainAligned = params.parsed
        .slice(0, parsedIndex)
        .every((item, index) =>
          matchesArrayElementAtSameIndex(params.incoming[index], item, params.resolved[index]),
        );
      const duplicateAuthoredMatch = params.parsed.some(
        (item, index) =>
          index !== parsedIndex &&
          matchesArrayElementAtSameIndex(
            params.incoming[parsedIndex],
            item,
            params.resolved[index],
          ),
      );
      const duplicateIncomingMatch = params.incoming.some(
        (item, index) =>
          index !== parsedIndex &&
          matchesArrayElementAtSameIndex(item, parsedItem, params.resolved[parsedIndex]),
      );
      const positionRemainsStable =
        params.incoming.length === params.parsed.length || precedingItemsRemainAligned;
      if (!positionRemainsStable || duplicateAuthoredMatch || duplicateIncomingMatch) {
        throw new EnvRefArrayMutationError();
      }
      addMatch(parsedIndex, parsedIndex);
      continue;
    }

    if (isPlainObject(parsedItem) || Array.isArray(parsedItem)) {
      const isSinglePositionEdit = params.incoming.length === 1 && params.parsed.length === 1;
      const hasSameIndexLiteralIdentity = hasStableSameIndexLiteralShape({
        incoming: params.incoming,
        parsed: params.parsed,
        parsedIndex,
      });
      const hasSameIndexNeighbors = hasStableSameIndexNeighbors({
        incoming: params.incoming,
        parsed: params.parsed,
        parsedIndex,
        resolved: params.resolved,
      });
      if (!isSinglePositionEdit && !hasSameIndexLiteralIdentity && !hasSameIndexNeighbors) {
        throw new EnvRefArrayMutationError();
      }
      addMatch(parsedIndex, parsedIndex);
      continue;
    }
    const crossIndexMatches = params.incoming.some(
      (item, incomingIndex) =>
        incomingIndex !== parsedIndex &&
        matchesArrayElementAtSameIndex(item, parsedItem, params.resolved[parsedIndex]),
    );
    if (crossIndexMatches) {
      throw new EnvRefArrayMutationError();
    }
    if (parsedIndex < params.incoming.length) {
      addMatch(parsedIndex, parsedIndex);
    }
  }
  return matches;
}

export function matchAuthoredEscapedTemplateArrayItems(params: {
  incoming: unknown[];
  parsed: unknown[];
  resolved: unknown[];
  usedIncomingIndexes: Set<number>;
}): Map<number, number> {
  const escapedTemplateIndexes = params.parsed.flatMap((item, index) =>
    containsAuthoredEscapedEnvTemplate(item) && !containsAuthoredUnescapedEnvTemplate(item)
      ? [index]
      : [],
  );
  if (
    params.incoming.length === params.parsed.length &&
    params.incoming.every((item, index) =>
      matchesArrayElementAtSameIndex(item, params.parsed[index], params.resolved[index]),
    )
  ) {
    return new Map(escapedTemplateIndexes.map((index) => [index, index]));
  }
  const retainedDeletionMatches = matchUniqueRetainedArrayItems(params);
  if (retainedDeletionMatches) {
    return new Map(
      escapedTemplateIndexes.flatMap((parsedIndex) => {
        const incomingIndex = retainedDeletionMatches.get(parsedIndex);
        if (incomingIndex === undefined) {
          return [];
        }
        if (params.usedIncomingIndexes.has(incomingIndex)) {
          throw new EnvRefArrayMutationError();
        }
        return [[parsedIndex, incomingIndex]];
      }),
    );
  }
  const matches = new Map<number, number>();
  const usedIncomingIndexes = new Set(params.usedIncomingIndexes);
  const addMatch = (parsedIndex: number, incomingIndex: number) => {
    if (usedIncomingIndexes.has(incomingIndex)) {
      throw new EnvRefArrayMutationError();
    }
    matches.set(parsedIndex, incomingIndex);
    usedIncomingIndexes.add(incomingIndex);
  };

  for (const parsedIndex of escapedTemplateIndexes) {
    const parsedItem = params.parsed[parsedIndex];
    const stableIdentity = resolveStableArrayIdentityMatch({
      incoming: params.incoming,
      parsed: params.parsed,
      parsedIndex,
    });
    if (stableIdentity.kind !== "none") {
      if (stableIdentity.kind === "match") {
        addMatch(parsedIndex, stableIdentity.incomingIndex);
        continue;
      }
    }

    const resolvedItem = params.resolved[parsedIndex];
    const incomingMatches = params.incoming.flatMap((item, incomingIndex) =>
      !usedIncomingIndexes.has(incomingIndex) && isDeepStrictEqual(item, resolvedItem)
        ? [incomingIndex]
        : [],
    );
    const authoredMatches = escapedTemplateIndexes.filter((index) =>
      isDeepStrictEqual(params.resolved[index], resolvedItem),
    );
    const authoredRepresentationsAreIdentical = authoredMatches.every((index) =>
      isDeepStrictEqual(params.parsed[index], parsedItem),
    );
    if (
      incomingMatches.length > 0 &&
      incomingMatches.length <= authoredMatches.length &&
      authoredRepresentationsAreIdentical
    ) {
      const sameIndexMatch = incomingMatches.includes(parsedIndex)
        ? parsedIndex
        : incomingMatches[0];
      addMatch(parsedIndex, expectDefined(sameIndexMatch, "env preserve same index match"));
      continue;
    }
    if (incomingMatches.length > 0) {
      throw new EnvRefArrayMutationError();
    }

    if (isPlainObject(parsedItem) || Array.isArray(parsedItem)) {
      const isSinglePositionEdit = params.incoming.length === 1 && params.parsed.length === 1;
      const hasSameIndexLiteralIdentity = hasStableSameIndexLiteralShape({
        incoming: params.incoming,
        parsed: params.parsed,
        parsedIndex,
      });
      const hasSameIndexNeighbors = hasStableSameIndexNeighbors({
        incoming: params.incoming,
        parsed: params.parsed,
        parsedIndex,
        resolved: params.resolved,
      });
      if (
        stableIdentity.kind === "none" &&
        parsedIndex < params.incoming.length &&
        !usedIncomingIndexes.has(parsedIndex) &&
        (isSinglePositionEdit || hasSameIndexLiteralIdentity || hasSameIndexNeighbors)
      ) {
        addMatch(parsedIndex, parsedIndex);
        continue;
      }
    }
  }
  return matches;
}
