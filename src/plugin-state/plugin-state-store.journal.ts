import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  allocatePluginStateNamespaceCreatedAt,
  bindPluginStateEntry,
  createPluginStateError,
  deleteExpiredPluginStateEntries,
  hasPluginStateEntry,
  MAX_PLUGIN_STATE_VALUE_BYTES,
  parseStoredJson,
  selectPluginStateEntry,
  selectPluginStateEntriesInKeyRange,
  upsertPluginStateEntry,
  type PluginStateDatabase,
} from "./plugin-state-store.kernel.js";
import { enforcePostRegisterLimits } from "./plugin-state-store.retention.js";
import { serializePluginStoreJson, validatePluginStoreKey } from "./plugin-store-validation.js";

export type PluginStateSequencedJournalParams = {
  pluginId: string;
  cursorNamespace: string;
  cursorKey: string;
  cursorMaxEntries: number;
  journalNamespace: string;
  journalMaxEntries: number;
  journalKeyPrefix: string;
  journalKeyRange: {
    keyStartInclusive: string;
    keyEndExclusive: string;
    valueKind?: string;
  };
  journalValueJson: string;
};

const journalValueErrors = {
  invalid: (message: string) =>
    createPluginStateError({
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation: "register",
      message,
    }),
  limit: (message: string) =>
    createPluginStateError({
      code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      operation: "register",
      message,
    }),
};

function serializeJournalValue(value: unknown): string {
  return serializePluginStoreJson({
    value,
    label: "plugin state value",
    maxBytes: MAX_PLUGIN_STATE_VALUE_BYTES,
    errors: journalValueErrors,
  });
}

/** Capture caller data before worker admission; allocation owns the sequence field. */
export function preparePluginStateJournalValue(value: Record<string, unknown>): string {
  if (!isRecord(value) || Object.hasOwn(value, "sequence")) {
    throw journalValueErrors.invalid(
      "Plugin state journal value must be an object without a sequence field.",
    );
  }
  return serializeJournalValue(value);
}

function readCursorSequence(valueJson: string): number | undefined {
  try {
    const value: unknown = JSON.parse(valueJson);
    return isRecord(value) &&
      value.kind === "cursor" &&
      typeof value.lastSequence === "number" &&
      Number.isSafeInteger(value.lastSequence)
      ? value.lastSequence
      : undefined;
  } catch {
    return undefined;
  }
}

function prepareSequencedEntry(params: PluginStateSequencedJournalParams, sequence: number) {
  const fields: unknown = JSON.parse(params.journalValueJson);
  if (!isRecord(fields)) {
    throw journalValueErrors.invalid(
      "Plugin state journal value must be an object without a sequence field.",
    );
  }
  const journalKey = validatePluginStoreKey({
    value: `${params.journalKeyPrefix}${sequence.toString().padStart(16, "0")}`,
    label: "plugin state",
    errors: { invalid: journalValueErrors.invalid, limit: journalValueErrors.invalid },
  });
  return {
    cursorValueJson: serializeJournalValue({ kind: "cursor", lastSequence: sequence }),
    journalKey,
    journalValueJson: serializeJournalValue({ ...fields, sequence }),
  };
}

/** The worker owns the transaction containing allocation, both writes, and retention. */
export function registerPluginStateSequencedJournalEntryInDatabase(
  store: PluginStateDatabase,
  params: PluginStateSequencedJournalParams,
): number {
  const now = Date.now();
  deleteExpiredPluginStateEntries(store.db, now, {
    pluginId: params.pluginId,
    namespace: params.cursorNamespace,
  });
  deleteExpiredPluginStateEntries(store.db, now, {
    pluginId: params.pluginId,
    namespace: params.journalNamespace,
  });
  const cursor = selectPluginStateEntry(store.db, {
    pluginId: params.pluginId,
    namespace: params.cursorNamespace,
    key: params.cursorKey,
    now,
  });
  const cursorSequence = cursor ? readCursorSequence(cursor.value_json) : undefined;
  // Cursor eviction must not let an admitted append reuse a retained sequence.
  const tail = selectPluginStateEntriesInKeyRange(store.db, {
    pluginId: params.pluginId,
    namespace: params.journalNamespace,
    ...params.journalKeyRange,
    limit: 1,
    order: "desc",
    now,
  })[0];
  let retainedSequence = 0;
  if (tail) {
    const value = parseStoredJson(tail.value_json, "entries", store.path);
    if (value === null) {
      throw new TypeError("Plugin state journal tail must not be null.");
    }
    if (
      typeof value === "object" &&
      (params.journalKeyRange.valueKind === undefined ||
        ("kind" in value && value.kind === params.journalKeyRange.valueKind))
    ) {
      retainedSequence = Math.max(0, Number("sequence" in value ? (value.sequence ?? 0) : 0));
      if (!Number.isSafeInteger(retainedSequence)) {
        throw createPluginStateError({
          code: "PLUGIN_STATE_INVALID_INPUT",
          operation: "register",
          message: "Plugin state journal sequence must be a safe non-negative integer.",
        });
      }
    }
  }
  const lastSequence = Math.max(retainedSequence, cursorSequence ?? 0);
  const sequence = lastSequence + 1;
  if (!Number.isSafeInteger(sequence)) {
    throw new RangeError("Plugin state journal sequence exhausted safe integer range");
  }
  const prepared = prepareSequencedEntry(params, sequence);
  if (
    prepared.journalKey < params.journalKeyRange.keyStartInclusive ||
    prepared.journalKey >= params.journalKeyRange.keyEndExclusive
  ) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation: "register",
      message: "Plugin state journal key must be inside its retained key range.",
    });
  }
  const existingJournalEntry = hasPluginStateEntry(store.db, {
    pluginId: params.pluginId,
    namespace: params.journalNamespace,
    key: prepared.journalKey,
    now,
  });
  if (existingJournalEntry) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_WRITE_FAILED",
      operation: "register",
      message: "Plugin state journal sequence already exists.",
      path: store.path,
    });
  }
  upsertPluginStateEntry(
    store.db,
    bindPluginStateEntry({
      pluginId: params.pluginId,
      namespace: params.cursorNamespace,
      key: params.cursorKey,
      valueJson: prepared.cursorValueJson,
      createdAt: now,
      expiresAt: null,
    }),
  );
  enforcePostRegisterLimits({
    store,
    pluginId: params.pluginId,
    namespace: params.cursorNamespace,
    maxEntries: params.cursorMaxEntries,
    overflowPolicy: "evict-oldest",
    now,
    protectedKey: params.cursorKey,
  });
  upsertPluginStateEntry(
    store.db,
    bindPluginStateEntry({
      pluginId: params.pluginId,
      namespace: params.journalNamespace,
      key: prepared.journalKey,
      valueJson: prepared.journalValueJson,
      createdAt: allocatePluginStateNamespaceCreatedAt(store.db, {
        pluginId: params.pluginId,
        namespace: params.journalNamespace,
        now,
      }),
      expiresAt: null,
    }),
  );
  enforcePostRegisterLimits({
    store,
    pluginId: params.pluginId,
    namespace: params.journalNamespace,
    maxEntries: params.journalMaxEntries,
    overflowPolicy: "evict-oldest",
    now,
    protectedKey: prepared.journalKey,
  });
  return sequence;
}
