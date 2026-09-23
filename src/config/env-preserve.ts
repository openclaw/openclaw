// Normalizes preserved environment-variable config for subprocess launches.
import { isPlainObject } from "../infra/plain-object.js";
import {
  EnvRefArrayMutationError,
  hasEnvVarRef,
  matchAuthoredEscapedTemplateArrayItems,
  matchAuthoredTemplateArrayItems,
  resolveStableArrayIdentityMatch,
} from "./env-preserve-array-identity.js";
import {
  containsAuthoredUnescapedEnvTemplate,
  containsAuthoredEscapedEnvTemplate,
  containsUnaccountedActiveEscapedEnvRef,
  preservesAuthoredEscapedEnvRefs,
} from "./env-preserve-authored.js";
import { resolveConfigEnvVars } from "./env-substitution.js";
import { settleContainerValue } from "./merge-patch.js";

/**
 * Preserves `${VAR}` environment variable references during config write-back.
 *
 * When config is read, `${VAR}` references are resolved to their values.
 * When writing back, callers pass the resolved config. This module detects
 * values that match what a `${VAR}` reference would resolve to and restores
 * the original reference, so env var references survive config round-trips.
 *
 * A value is restored only if:
 * 1. The pre-substitution value contained a `${VAR}` pattern
 * 2. The corresponding resolved source value matches the incoming value
 *
 * If a caller intentionally set a new value (different from what the env var
 * resolves to), the new value is kept as-is.
 */

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
      readonly incoming: readonly unknown[];
      readonly parsed: readonly unknown[];
      readonly resolved: readonly unknown[];
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
      const unescapedMatches = matchAuthoredTemplateArrayItems({
        incoming: frameIncoming,
        parsed: frameParsed,
        resolved: frameResolved,
      });
      const escapedMatches = matchAuthoredEscapedTemplateArrayItems({
        incoming: frameIncoming,
        parsed: frameParsed,
        resolved: frameResolved,
        usedIncomingIndexes: new Set(unescapedMatches.values()),
      });
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
