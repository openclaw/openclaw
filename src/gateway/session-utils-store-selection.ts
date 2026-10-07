import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isInternalSessionEffectsKey } from "../config/sessions/internal-session-key.js";
import { canonicalSessionKeyMigrationRequiredError } from "../config/sessions/session-canonical-key.js";
import type {
  CapturedSessionEntryReadSource,
  SessionEntryReadSource,
} from "../config/sessions/session-entry-read-source.types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { GatewaySessionStoreRead } from "./session-utils-store-read.js";
import type { GatewaySessionStoreTargetWithStore } from "./session-utils-store.types.js";

export type GatewaySessionStorePlan<T> = {
  reads: GatewaySessionStoreRead[];
  resolve: () => T;
};

export type GatewaySessionStoreLookup = {
  storePath: string;
  store: Record<string, SessionEntry>;
  readSource?: SessionEntryReadSource;
  capturedReadSource?: CapturedSessionEntryReadSource;
  capturedReadSources?: CapturedSessionEntryReadSource[];
  match: { entry: SessionEntry; key: string } | undefined;
  canonicalValidationError?: Error;
};

/** Ordinary Gateway lookups exclude rows reserved for suppressed run effects. */
export function omitInternalSessionEffectsEntries(
  store: Record<string, SessionEntry>,
  storeKeys: readonly string[],
): void {
  for (const storeKey of storeKeys) {
    if (isInternalSessionEffectsKey(storeKey)) {
      delete store[storeKey];
    }
  }
}

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
  Read extends {
    storePath: string;
    readSource?: SessionEntryReadSource;
    capturedReadSource?: CapturedSessionEntryReadSource;
  },
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
  let selectedCapturedReadSource = first.capturedReadSource;
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
    selectedCapturedReadSource = candidate.capturedReadSource;
    selectedMatch = match;
  }
  return {
    storePath: selectedStorePath,
    store: selectedStore,
    ...(selectedReadSource ? { readSource: selectedReadSource } : {}),
    ...(selectedCapturedReadSource ? { capturedReadSource: selectedCapturedReadSource } : {}),
    capturedReadSources: params.reads.flatMap((read) =>
      read.capturedReadSource ? [read.capturedReadSource] : [],
    ),
    match: selectedMatch,
    ...(canonicalValidationError ? { canonicalValidationError } : {}),
  };
}

/** Retain scanned stages without planning a replacement before legacy selection finishes. */
export async function prepareGatewaySessionStoreReadPlan(params: {
  legacy: GatewaySessionStorePlan<GatewaySessionStoreTargetWithStore | null> | null;
  prepareCurrent: () => GatewaySessionStorePlan<GatewaySessionStoreTargetWithStore>;
  prepareReads: <T>(reads: readonly GatewaySessionStoreRead[], select: () => T) => Promise<T>;
}): Promise<{
  target: GatewaySessionStoreTargetWithStore;
  plan: GatewaySessionStorePlan<GatewaySessionStoreTargetWithStore>;
}> {
  const resolve = async <T>(plan: GatewaySessionStorePlan<T>) =>
    await params.prepareReads(plan.reads, () => {
      if (plan.reads.some((read) => read.result === undefined)) {
        throw new Error("Session lookup facts were not prepared");
      }
      return plan.resolve();
    });
  const deletedMain = params.legacy;
  if (deletedMain) {
    const target = await resolve(deletedMain);
    if (target) {
      return {
        target,
        plan: {
          reads: deletedMain.reads,
          resolve() {
            const current = deletedMain.resolve();
            if (!current) {
              throw new Error("Prepared legacy session target changed");
            }
            return current;
          },
        },
      };
    }
  }
  const current = params.prepareCurrent();
  const target = await resolve(current);
  return {
    target,
    plan: {
      reads: [...(deletedMain?.reads ?? []), ...current.reads],
      resolve: () => deletedMain?.resolve() ?? current.resolve(),
    },
  };
}
