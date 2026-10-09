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
import { settleContainerValue } from "./merge-patch.js";

class EnvRefArrayMutationError extends Error {
  constructor() {
    super("Config write would reorder or modify an array containing environment references.");
    this.name = "EnvRefArrayMutationError";
  }
}

// Escaped references also change under substitution and must retain their authored text.
function hasEnvVarRef(value: string): boolean {
  return scanEnvTemplateTokens(value).length > 0;
}

type ArrayIdentityPath = string[];
type EnvRefArrays = { incoming: unknown[]; parsed: unknown[]; resolved: unknown[] };

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

function resolveStableArrayIdentityMatch(params: {
  incoming: unknown[];
  parsed: unknown[];
  parsedIndex: number;
}): { kind: "none" } | { kind: "invalid" } | { kind: "match"; incomingIndex: number } {
  const parsedItem = params.parsed[params.parsedIndex];
  if (!isPlainObject(parsedItem)) {
    return { kind: "none" };
  }
  const identityKey = ["id", "agentId"].find(
    (key) => typeof parsedItem[key] === "string" && !hasEnvVarRef(parsedItem[key]),
  );
  if (!identityKey) {
    return { kind: "none" };
  }
  const identityValue = parsedItem[identityKey];
  const matchesIdentity = (item: unknown) =>
    isPlainObject(item) && isDeepStrictEqual(item[identityKey], identityValue);
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

function matchesRetainedArrayItem(
  params: EnvRefArrays & { incomingIndex: number; parsedIndex: number },
): boolean {
  if (
    matchesArrayElementAtSameIndex(
      params.incoming[params.incomingIndex],
      params.parsed[params.parsedIndex],
      params.resolved[params.parsedIndex],
    )
  ) {
    return true;
  }
  const stableIdentity = resolveStableArrayIdentityMatch(params);
  return stableIdentity.kind === "match" && stableIdentity.incomingIndex === params.incomingIndex;
}

function canMatchEditedArrayItemAtSameIndex(
  params: EnvRefArrays & { parsedIndex: number },
): boolean {
  if (params.incoming.length !== params.parsed.length) {
    return false;
  }
  return (
    params.incoming.length === 1 ||
    hasStableSameIndexLiteralShape(params) ||
    params.parsed.every(
      (item, index) =>
        index === params.parsedIndex ||
        matchesArrayElementAtSameIndex(params.incoming[index], item, params.resolved[index]),
    )
  );
}

function matchUniqueRetainedArrayItems(params: EnvRefArrays): Map<number, number> | undefined {
  if (params.incoming.length >= params.parsed.length) {
    return undefined;
  }

  const matchIndexes = (direction: 1 | -1): number[] | undefined => {
    const indexes: number[] = [];
    let parsedIndex = direction === 1 ? 0 : params.parsed.length - 1;
    for (
      let incomingIndex = direction === 1 ? 0 : params.incoming.length - 1;
      incomingIndex >= 0 && incomingIndex < params.incoming.length;
      incomingIndex += direction
    ) {
      while (
        parsedIndex >= 0 &&
        parsedIndex < params.parsed.length &&
        !matchesRetainedArrayItem({ ...params, incomingIndex, parsedIndex })
      ) {
        parsedIndex += direction;
      }
      if (parsedIndex < 0 || parsedIndex >= params.parsed.length) {
        return undefined;
      }
      indexes[incomingIndex] = parsedIndex;
      parsedIndex += direction;
    }
    return indexes;
  };
  const earliestParsedIndexes = matchIndexes(1);
  if (!earliestParsedIndexes || !isDeepStrictEqual(earliestParsedIndexes, matchIndexes(-1))) {
    return undefined;
  }
  return new Map(
    earliestParsedIndexes.map((parsedIndex, incomingIndex) => [parsedIndex, incomingIndex]),
  );
}

function matchUneditedTemplateArrayItems(
  params: EnvRefArrays,
  templateIndexes: number[],
  usedIncomingIndexes?: ReadonlySet<number>,
): Map<number, number> | undefined {
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
        if (incomingIndex === undefined) {
          return [];
        }
        if (usedIncomingIndexes?.has(incomingIndex)) {
          throw new EnvRefArrayMutationError();
        }
        return [[parsedIndex, incomingIndex]];
      }),
    );
  }
  return undefined;
}

function matchAuthoredTemplateArrayItems(
  params: EnvRefArrays,
  kind: "substitution" | "escaped",
  claimedIncomingIndexes?: ReadonlySet<number>,
): Map<number, number> {
  const templateIndexes = params.parsed.flatMap((item, index) =>
    (
      kind === "substitution"
        ? containsAuthoredUnescapedEnvTemplate(item)
        : containsAuthoredEscapedEnvTemplate(item) && !containsAuthoredUnescapedEnvTemplate(item)
    )
      ? [index]
      : [],
  );
  const uneditedMatches = matchUneditedTemplateArrayItems(
    params,
    templateIndexes,
    claimedIncomingIndexes,
  );
  if (uneditedMatches) {
    return uneditedMatches;
  }

  const matches = new Map<number, number>();
  const usedIncomingIndexes = new Set(claimedIncomingIndexes);
  const addMatch = (parsedIndex: number, incomingIndex: number) => {
    if (usedIncomingIndexes.has(incomingIndex)) {
      throw new EnvRefArrayMutationError();
    }
    matches.set(parsedIndex, incomingIndex);
    usedIncomingIndexes.add(incomingIndex);
  };
  for (const parsedIndex of templateIndexes) {
    const parsedItem = params.parsed[parsedIndex];
    const stableIdentity = resolveStableArrayIdentityMatch({ ...params, parsedIndex });
    if (stableIdentity.kind === "match") {
      addMatch(parsedIndex, stableIdentity.incomingIndex);
      continue;
    }
    if (kind === "escaped") {
      const resolvedItem = params.resolved[parsedIndex];
      const incomingMatches = params.incoming.flatMap((item, incomingIndex) =>
        !usedIncomingIndexes.has(incomingIndex) && isDeepStrictEqual(item, resolvedItem)
          ? [incomingIndex]
          : [],
      );
      const authoredMatches = templateIndexes.filter((index) =>
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

      if (
        (isPlainObject(parsedItem) || Array.isArray(parsedItem)) &&
        stableIdentity.kind === "none" &&
        parsedIndex < params.incoming.length &&
        !usedIncomingIndexes.has(parsedIndex) &&
        canMatchEditedArrayItemAtSameIndex({ ...params, parsedIndex })
      ) {
        addMatch(parsedIndex, parsedIndex);
      }
      continue;
    }
    if (stableIdentity.kind === "invalid") {
      throw new EnvRefArrayMutationError();
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

type EnvRefResolveSlot = {
  readonly source: unknown;
  readonly container: Record<string, unknown> | unknown[];
  readonly key: string | number;
};

function settleEnvRefResolveSlot(slot: EnvRefResolveSlot, value: unknown): void {
  settleContainerValue(slot.container, slot.key, value);
}

function resolveEnvVarRefsForComparison(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") {
    return hasEnvVarRef(value) ? resolveConfigEnvVars(value, env, { onMissing: () => {} }) : value;
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    return value;
  }
  // Walks the parsed document on an explicit work stack: document nesting
  // costs heap rather than call frames, so a schema-valid deep config cannot
  // crash comparison with a RangeError before restoration sees the values.
  const root: Record<string, unknown> = {};
  const pending: EnvRefResolveSlot[] = [{ source: value, container: root, key: "resolved" }];
  while (pending.length > 0) {
    const slot = pending.pop();
    if (slot === undefined) {
      break;
    }
    const source = slot.source;
    if (typeof source === "string") {
      settleEnvRefResolveSlot(
        slot,
        hasEnvVarRef(source) ? resolveConfigEnvVars(source, env, { onMissing: () => {} }) : source,
      );
      continue;
    }
    if (Array.isArray(source)) {
      const next: unknown[] = Array.from({ length: source.length });
      settleEnvRefResolveSlot(slot, next);
      for (let index = source.length - 1; index >= 0; index -= 1) {
        pending.push({ source: source[index], container: next, key: index });
      }
      continue;
    }
    if (isPlainObject(source)) {
      const next: Record<string, unknown> = {};
      settleEnvRefResolveSlot(slot, next);
      const entries = Object.entries(source);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry === undefined) {
          continue;
        }
        pending.push({ source: entry[1], container: next, key: entry[0] });
      }
      continue;
    }
    settleEnvRefResolveSlot(slot, source);
  }
  return root.resolved;
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
/** Restore authored references wherever their resolved values match the incoming config. */
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

/**
 * Explicitly authored paths still pending restoration, one segment per
 * nesting level. A path consumed at the current node (length 0) marks an
 * authored template the caller set deliberately.
 */
type ExplicitSetPaths = readonly (readonly string[])[] | undefined;

function childExplicitPaths(explicitSetPaths: ExplicitSetPaths, key: string): ExplicitSetPaths {
  return explicitSetPaths?.flatMap((path) =>
    path.length === 0 ? [path] : path[0] === key ? [path.slice(1)] : [],
  );
}

/**
 * Frame for the iterative env-ref restoration walk. `enter` frames resolve one
 * node and schedule their children; children write their restored values into
 * the parent container slot, so document nesting costs heap rather than call
 * frames and a schema-valid deep config cannot overflow the call stack here.
 * `escape-check` frames run after a template array's children have settled and
 * keep the fail-closed mutation check over the fully restored array.
 */
type EnvRefRestoreFrame =
  | {
      readonly kind: "enter";
      readonly incoming: unknown;
      readonly parsed: unknown;
      readonly resolved: unknown;
      readonly explicitSetPaths: ExplicitSetPaths;
      readonly container: Record<string, unknown> | unknown[];
      readonly key: string | number;
    }
  | {
      readonly kind: "escape-check";
      readonly incoming: unknown[];
      readonly parsed: unknown[];
      readonly resolved: unknown[];
      readonly explicitSetPaths: ExplicitSetPaths;
      readonly next: unknown[];
      readonly matches: ReadonlyMap<number, number>;
      readonly matchedParsedIndexByIncoming: ReadonlyMap<number, number>;
      readonly container: Record<string, unknown> | unknown[];
      readonly key: string | number;
    };

function settleEnvRefRestoreFrame(frame: EnvRefRestoreFrame, value: unknown): void {
  settleContainerValue(frame.container, frame.key, value);
}

/** Restore only references owned by the matching authored/resolved planning read. */
export function restoreEnvVarRefsFromResolved(
  incoming: unknown,
  parsed: unknown,
  resolved: unknown,
  explicitSetPaths?: readonly (readonly string[])[],
): unknown {
  const root: Record<string, unknown> = {};
  const pending: EnvRefRestoreFrame[] = [
    {
      kind: "enter",
      incoming,
      parsed,
      resolved,
      explicitSetPaths,
      container: root,
      key: "resolved",
    },
  ];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) {
      break;
    }
    if (frame.kind === "escape-check") {
      // Keep same-name real/escaped scalar reorders fail-closed: a raw `${VAR}`
      // is indistinguishable from a moved escaped literal or a newly active ref.
      for (const [escapedParsedIndex, escapedParsedItem] of frame.parsed.entries()) {
        if (!containsAuthoredEscapedEnvTemplate(escapedParsedItem)) {
          continue;
        }
        const matchedIncomingIndex = frame.matches.get(escapedParsedIndex);
        if (
          matchedIncomingIndex !== undefined &&
          preservesAuthoredEscapedEnvRefs(frame.next[matchedIncomingIndex], escapedParsedItem)
        ) {
          continue;
        }
        const stableIdentity = resolveStableArrayIdentityMatch({
          incoming: frame.incoming,
          parsed: frame.parsed,
          parsedIndex: escapedParsedIndex,
        });
        const hasUnaccountedActiveReference = frame.next.some((item, incomingIndex) => {
          const matchedParsedIndex = frame.matchedParsedIndexByIncoming.get(incomingIndex);
          return containsUnaccountedActiveEscapedEnvRef(
            item,
            escapedParsedItem,
            frame.incoming[incomingIndex],
            matchedParsedIndex === undefined ? undefined : frame.parsed[matchedParsedIndex],
            matchedParsedIndex === undefined ? undefined : frame.resolved[matchedParsedIndex],
            // Explicit intent may activate only the same escaped leaf on its
            // uniquely retained owner, never a scalar move or another owner.
            matchedParsedIndex === escapedParsedIndex &&
              stableIdentity.kind === "match" &&
              stableIdentity.incomingIndex === incomingIndex
              ? childExplicitPaths(frame.explicitSetPaths, String(incomingIndex))
              : undefined,
          );
        });
        if (hasUnaccountedActiveReference) {
          throw new EnvRefArrayMutationError();
        }
      }
      continue;
    }
    const { incoming: frameIncoming, parsed: frameParsed, resolved: frameResolved } = frame;
    // If parsed has no env var refs at this level, return incoming as-is
    if (frameParsed === null || frameParsed === undefined) {
      settleEnvRefRestoreFrame(frame, frameIncoming);
      continue;
    }

    // String leaf: check if parsed was a ${VAR} template that resolves to incoming
    if (typeof frameIncoming === "string" && typeof frameParsed === "string") {
      // An explicitly authored template is intent, even when an old escaped
      // template resolved to the same string. Literal descendants still restore.
      if (
        hasEnvVarRef(frameIncoming) &&
        frame.explicitSetPaths?.some((path) => path.length === 0)
      ) {
        settleEnvRefRestoreFrame(frame, frameIncoming);
        continue;
      }
      if (hasEnvVarRef(frameParsed) && frameResolved === frameIncoming) {
        // The incoming value matches what the env var resolves to — restore the reference
        settleEnvRefRestoreFrame(frame, frameParsed);
        continue;
      }
      settleEnvRefRestoreFrame(frame, frameIncoming);
      continue;
    }

    // Array template entries must retain a unique identity before authored refs
    // can be restored; ambiguous moves would attach secrets or activate escaped
    // literals on the wrong entry.
    if (
      Array.isArray(frameIncoming) &&
      Array.isArray(frameParsed) &&
      Array.isArray(frameResolved)
    ) {
      if (
        !containsAuthoredUnescapedEnvTemplate(frameParsed) &&
        !containsAuthoredEscapedEnvTemplate(frameParsed)
      ) {
        const next = [...frameIncoming];
        settleEnvRefRestoreFrame(frame, next);
        for (let index = frameIncoming.length - 1; index >= 0; index -= 1) {
          if (index >= frameParsed.length) {
            continue;
          }
          pending.push({
            kind: "enter",
            incoming: frameIncoming[index],
            parsed: frameParsed[index],
            resolved: frameResolved[index],
            explicitSetPaths: childExplicitPaths(frame.explicitSetPaths, String(index)),
            container: next,
            key: index,
          });
        }
        continue;
      }
      const arrays = { incoming: frameIncoming, parsed: frameParsed, resolved: frameResolved };
      const unescapedMatches = matchAuthoredTemplateArrayItems(arrays, "substitution");
      const escapedMatches = matchAuthoredTemplateArrayItems(
        arrays,
        "escaped",
        new Set(unescapedMatches.values()),
      );
      const matches = new Map([...unescapedMatches, ...escapedMatches]);
      const next = [...frameIncoming];
      settleEnvRefRestoreFrame(frame, next);
      const matchedIncomingIndexes = new Set(matches.values());
      const matchedParsedIndexByIncoming = new Map(
        [...matches].map(([parsedIndex, incomingIndex]) => [incomingIndex, parsedIndex]),
      );
      // Pushed in reverse so the escape check runs only after every child slot
      // has been restored into `next`.
      pending.push({
        kind: "escape-check",
        incoming: frameIncoming,
        parsed: frameParsed,
        resolved: frameResolved,
        explicitSetPaths: frame.explicitSetPaths,
        next,
        matches,
        matchedParsedIndexByIncoming,
        container: frame.container,
        key: frame.key,
      });
      for (const [parsedIndex, incomingIndex] of matches) {
        pending.push({
          kind: "enter",
          incoming: frameIncoming[incomingIndex],
          parsed: frameParsed[parsedIndex],
          resolved: frameResolved[parsedIndex],
          explicitSetPaths: childExplicitPaths(frame.explicitSetPaths, String(incomingIndex)),
          container: next,
          key: incomingIndex,
        });
      }
      for (let index = 0; index < frameIncoming.length && index < frameParsed.length; index += 1) {
        if (
          matchedIncomingIndexes.has(index) ||
          containsAuthoredUnescapedEnvTemplate(frameParsed[index]) ||
          containsAuthoredEscapedEnvTemplate(frameParsed[index])
        ) {
          continue;
        }
        pending.push({
          kind: "enter",
          incoming: frameIncoming[index],
          parsed: frameParsed[index],
          resolved: frameResolved[index],
          explicitSetPaths: childExplicitPaths(frame.explicitSetPaths, String(index)),
          container: next,
          key: index,
        });
      }
      continue;
    }

    // Objects: walk key by key
    if (
      isPlainObject(frameIncoming) &&
      isPlainObject(frameParsed) &&
      isPlainObject(frameResolved)
    ) {
      const result: Record<string, unknown> = {};
      settleEnvRefRestoreFrame(frame, result);
      // Pushed in reverse so keys settle into `result` in document order; keys
      // the parsed document does not own pass through with `parsed: undefined`
      // and keep the caller-added value as-is.
      const entries = Object.entries(frameIncoming);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry === undefined) {
          continue;
        }
        const key = entry[0];
        const hasParsedKey = Object.hasOwn(frameParsed, key);
        pending.push({
          kind: "enter",
          incoming: entry[1],
          parsed: hasParsedKey ? frameParsed[key] : undefined,
          resolved: hasParsedKey ? frameResolved[key] : undefined,
          explicitSetPaths: childExplicitPaths(frame.explicitSetPaths, key),
          container: result,
          key,
        });
      }
      continue;
    }

    // Mismatched types or primitives — keep incoming
    settleEnvRefRestoreFrame(frame, frameIncoming);
  }
  return root.resolved;
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
