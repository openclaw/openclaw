import { isDeepStrictEqual } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { isPlainObject } from "../infra/plain-object.js";
import {
  containsAuthoredUnescapedEnvTemplate,
  containsAuthoredEscapedEnvTemplate,
  containsUnaccountedActiveEscapedEnvRef,
  preservesAuthoredEscapedEnvRefs,
} from "./env-preserve-authored.js";
import { resolveConfigEnvVars, scanEnvTemplateTokens } from "./env-substitution.js";

class EnvRefArrayMutationError extends Error {
  constructor() {
    super("Config write would reorder or modify an array containing environment references.");
    this.name = "EnvRefArrayMutationError";
  }
}

/**
 * Check if a string contains any `${VAR}` env var references, escaped or not.
 *
 * Escaped `$${VAR}` counts: it still changes under substitution, so the authored text
 * must be restored on write-back the same way an active reference is.
 */
function hasEnvVarRef(value: string): boolean {
  return scanEnvTemplateTokens(value).length > 0;
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

function findStableArrayIdentityPath(value: unknown): ArrayIdentityPath | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  for (const key of ["id", "agentId"]) {
    const child = value[key];
    if (typeof child === "string" && !hasEnvVarRef(child)) {
      return [key];
    }
  }
  return undefined;
}

function resolveStableArrayIdentityMatch(params: {
  incoming: unknown[];
  parsed: unknown[];
  parsedIndex: number;
}): { kind: "none" } | { kind: "invalid" } | { kind: "match"; incomingIndex: number } {
  const parsedItem = params.parsed[params.parsedIndex];
  const identityPath = findStableArrayIdentityPath(parsedItem);
  if (!identityPath) {
    return { kind: "none" };
  }
  const identityValue = getArrayIdentityPathValue(parsedItem, identityPath);
  const matchesIdentity = (item: unknown) =>
    isDeepStrictEqual(getArrayIdentityPathValue(item, identityPath), identityValue);
  if (params.parsed.filter(matchesIdentity).length !== 1) {
    return { kind: "none" };
  }
  const incomingMatches = params.incoming.flatMap((item, index) =>
    matchesIdentity(item) ? [index] : [],
  );
  return incomingMatches.length === 1
    ? {
        kind: "match",
        incomingIndex: expectDefined(incomingMatches[0], "env preserve identity match"),
      }
    : { kind: "invalid" };
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

function canMatchEditedArrayItemAtSameIndex(params: {
  incoming: unknown[];
  parsed: unknown[];
  parsedIndex: number;
  resolved: unknown[];
}): boolean {
  return (
    (params.incoming.length === 1 && params.parsed.length === 1) ||
    hasStableSameIndexLiteralShape(params) ||
    hasStableSameIndexNeighbors(params)
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

function matchAuthoredTemplateArrayItems(params: {
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
      if (!canMatchEditedArrayItemAtSameIndex({ ...params, parsedIndex })) {
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

function matchAuthoredEscapedTemplateArrayItems(params: {
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
    if (stableIdentity.kind === "match") {
      addMatch(parsedIndex, stableIdentity.incomingIndex);
      continue;
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
      if (
        stableIdentity.kind === "none" &&
        parsedIndex < params.incoming.length &&
        !usedIncomingIndexes.has(parsedIndex) &&
        canMatchEditedArrayItemAtSameIndex({ ...params, parsedIndex })
      ) {
        addMatch(parsedIndex, parsedIndex);
        continue;
      }
    }
  }
  return matches;
}

function resolveEnvVarRefsForComparison(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") {
    return hasEnvVarRef(value) ? resolveConfigEnvVars(value, env, { onMissing: () => {} }) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveEnvVarRefsForComparison(item, env));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveEnvVarRefsForComparison(item, env)]),
    );
  }
  return value;
}

/**
 * Deep-walk the incoming config and restore `${VAR}` references from the
 * pre-substitution parsed config wherever the resolved value matches.
 *
 * @param incoming - The resolved config about to be written
 * @param parsed - The pre-substitution parsed config (from the current file on disk)
 * @param env - Environment variables for verification
 * @returns A new config object with env var references restored where appropriate
 */
export function restoreEnvVarRefs(
  incoming: unknown,
  parsed: unknown,
  env: NodeJS.ProcessEnv = process.env,
): unknown {
  return restoreEnvVarRefsFromResolved(
    incoming,
    parsed,
    resolveEnvVarRefsForComparison(parsed, env),
  );
}

/** Restore only references owned by the matching authored/resolved planning read. */
export function restoreEnvVarRefsFromResolved(
  incoming: unknown,
  parsed: unknown,
  resolved: unknown,
  explicitSetPaths?: readonly (readonly string[])[],
): unknown {
  if (parsed === null || parsed === undefined) {
    return incoming;
  }

  if (typeof incoming === "string" && typeof parsed === "string") {
    // An explicitly authored template is intent, even when an old escaped
    // template resolved to the same string. Literal descendants still restore.
    if (hasEnvVarRef(incoming) && explicitSetPaths?.some((path) => path.length === 0)) {
      return incoming;
    }
    return hasEnvVarRef(parsed) && resolved === incoming ? parsed : incoming;
  }

  const childExplicitPaths = (key: string) =>
    explicitSetPaths?.flatMap((path) =>
      path.length === 0 ? [path] : path[0] === key ? [path.slice(1)] : [],
    );

  // Array template entries must retain a unique identity before authored refs
  // can be restored; ambiguous moves would attach secrets or activate escaped
  // literals on the wrong entry.
  if (Array.isArray(incoming) && Array.isArray(parsed) && Array.isArray(resolved)) {
    if (
      !containsAuthoredUnescapedEnvTemplate(parsed) &&
      !containsAuthoredEscapedEnvTemplate(parsed)
    ) {
      return incoming.map((item, index) =>
        index < parsed.length
          ? restoreEnvVarRefsFromResolved(
              item,
              parsed[index],
              resolved[index],
              childExplicitPaths(String(index)),
            )
          : item,
      );
    }
    // Keep same-name real/escaped scalar reorders fail-closed: a raw `${VAR}`
    // is indistinguishable from a moved escaped literal or a newly active ref.
    const unescapedMatches = matchAuthoredTemplateArrayItems({ incoming, parsed, resolved });
    const escapedMatches = matchAuthoredEscapedTemplateArrayItems({
      incoming,
      parsed,
      resolved,
      usedIncomingIndexes: new Set(unescapedMatches.values()),
    });
    const matches = new Map([...unescapedMatches, ...escapedMatches]);
    const next = [...incoming];
    const matchedIncomingIndexes = new Set(matches.values());
    for (const [parsedIndex, incomingIndex] of matches) {
      next[incomingIndex] = restoreEnvVarRefsFromResolved(
        incoming[incomingIndex],
        parsed[parsedIndex],
        resolved[parsedIndex],
        childExplicitPaths(String(incomingIndex)),
      );
    }
    for (let index = 0; index < incoming.length && index < parsed.length; index += 1) {
      if (
        !matchedIncomingIndexes.has(index) &&
        !containsAuthoredUnescapedEnvTemplate(parsed[index]) &&
        !containsAuthoredEscapedEnvTemplate(parsed[index])
      ) {
        next[index] = restoreEnvVarRefsFromResolved(
          incoming[index],
          parsed[index],
          resolved[index],
          childExplicitPaths(String(index)),
        );
      }
    }
    const matchedParsedIndexByIncoming = new Map(
      [...matches].map(([parsedIndex, incomingIndex]) => [incomingIndex, parsedIndex]),
    );
    for (const [escapedParsedIndex, escapedParsedItem] of parsed.entries()) {
      if (!containsAuthoredEscapedEnvTemplate(escapedParsedItem)) {
        continue;
      }
      const matchedIncomingIndex = matches.get(escapedParsedIndex);
      if (
        matchedIncomingIndex !== undefined &&
        preservesAuthoredEscapedEnvRefs(next[matchedIncomingIndex], escapedParsedItem)
      ) {
        continue;
      }
      const stableIdentity = resolveStableArrayIdentityMatch({
        incoming,
        parsed,
        parsedIndex: escapedParsedIndex,
      });
      const hasUnaccountedActiveReference = next.some((item, incomingIndex) => {
        const matchedParsedIndex = matchedParsedIndexByIncoming.get(incomingIndex);
        return containsUnaccountedActiveEscapedEnvRef(
          item,
          escapedParsedItem,
          incoming[incomingIndex],
          matchedParsedIndex === undefined ? undefined : parsed[matchedParsedIndex],
          matchedParsedIndex === undefined ? undefined : resolved[matchedParsedIndex],
          // Explicit intent may activate only the same escaped leaf on its
          // uniquely retained owner, never a scalar move or another owner.
          matchedParsedIndex === escapedParsedIndex &&
            stableIdentity.kind === "match" &&
            stableIdentity.incomingIndex === incomingIndex
            ? childExplicitPaths(String(incomingIndex))
            : undefined,
        );
      });
      if (hasUnaccountedActiveReference) {
        throw new EnvRefArrayMutationError();
      }
    }
    return next;
  }

  if (isPlainObject(incoming) && isPlainObject(parsed) && isPlainObject(resolved)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (Object.hasOwn(parsed, key)) {
        result[key] = restoreEnvVarRefsFromResolved(
          value,
          parsed[key],
          resolved[key],
          childExplicitPaths(key),
        );
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  return incoming;
}

export function resolveWriteEnvSnapshotForPath(params: {
  actualConfigPath: string;
  expectedConfigPath?: string;
  envSnapshotForRestore?: Record<string, string | undefined>;
}): Record<string, string | undefined> | undefined {
  if (
    params.expectedConfigPath === undefined ||
    params.expectedConfigPath === params.actualConfigPath
  ) {
    return params.envSnapshotForRestore;
  }
  return undefined;
}
