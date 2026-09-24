import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntryReadSource } from "../config/sessions/session-accessor.types.js";
import { canonicalSessionKeyMigrationRequiredError } from "../config/sessions/session-canonical-key.js";
import type { SessionEntry } from "../config/sessions/types.js";

export type GatewaySessionStoreLookup = {
  storePath: string;
  store: Record<string, SessionEntry>;
  readSource?: SessionEntryReadSource;
  match: { entry: SessionEntry; key: string } | undefined;
  canonicalValidationError?: Error;
};

export function findCanonicalStoreMatch<Entry extends SessionEntry>(
  store: Record<string, Entry>,
  candidates: readonly string[],
  onCanonicalError?: (error: Error) => void,
): { entry: Entry; key: string } | undefined {
  const matches = new Map<string, { entry: Entry; key: string }>();
  for (const candidate of candidates) {
    const trimmed = normalizeOptionalString(candidate) ?? "";
    if (!trimmed) {
      continue;
    }
    const exact = store[trimmed];
    if (exact) {
      matches.set(trimmed, { entry: exact, key: trimmed });
    }
  }
  if (matches.size === 0) {
    return undefined;
  }
  const canonicalKey = candidates[0] ?? "";
  const selected = matches.get(canonicalKey) ?? matches.values().next().value;
  if (matches.size > 1) {
    const error = canonicalSessionKeyMigrationRequiredError(
      `duplicate rows resolve to canonical session key ${canonicalKey || selected?.key || ""}`,
    );
    if (!onCanonicalError) {
      throw error;
    }
    onCanonicalError(error);
  }
  if (selected && selected.key !== canonicalKey) {
    const error = canonicalSessionKeyMigrationRequiredError(
      `non-canonical persisted row resolves to session key ${canonicalKey || selected.key}`,
    );
    if (!onCanonicalError) {
      throw error;
    }
    onCanonicalError(error);
  }
  return selected;
}

/** Selects canonical rows in read order; callers own acquisition or admitted reads. */
export function resolveGatewaySessionStoreReadResults<
  Read extends { storePath: string; readSource?: SessionEntryReadSource },
>(params: {
  reads: readonly Read[];
  readStore: (read: Read) => Record<string, SessionEntry>;
  scanTargets: readonly string[];
  canonicalKey: string;
  deferCanonicalValidation?: boolean;
}): GatewaySessionStoreLookup {
  const first = expectDefined(params.reads[0], "first configured or discovered session store");
  let selectedStorePath = first.storePath;
  let selectedStore = params.readStore(first);
  let selectedReadSource = first.readSource;
  let canonicalValidationError: Error | undefined;
  const recordCanonicalError = params.deferCanonicalValidation
    ? (error: Error) => {
        canonicalValidationError ??= error;
      }
    : undefined;
  let selectedMatch = findCanonicalStoreMatch(
    selectedStore,
    params.scanTargets,
    recordCanonicalError,
  );
  for (const candidate of params.reads.slice(1)) {
    const store = params.readStore(candidate);
    const match = findCanonicalStoreMatch(store, params.scanTargets, recordCanonicalError);
    if (!match) {
      continue;
    }
    if (selectedMatch) {
      const error = canonicalSessionKeyMigrationRequiredError(
        `duplicate rows resolve to canonical session key ${params.canonicalKey}`,
      );
      if (!recordCanonicalError) {
        throw error;
      }
      recordCanonicalError(error);
      if (match.key !== params.canonicalKey || selectedMatch.key === params.canonicalKey) {
        continue;
      }
    }
    selectedStorePath = candidate.storePath;
    selectedStore = store;
    selectedReadSource = candidate.readSource;
    selectedMatch = match;
  }
  return {
    storePath: selectedStorePath,
    store: selectedStore,
    ...(selectedReadSource ? { readSource: selectedReadSource } : {}),
    match: selectedMatch,
    ...(canonicalValidationError ? { canonicalValidationError } : {}),
  };
}
