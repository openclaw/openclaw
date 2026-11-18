import { capturePluginStateNativeBindingStore } from "../plugin-state/plugin-state-store.native-binding.js";
import type { PluginStateKeyedStore } from "../plugin-state/plugin-state-store.types.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
export { PluginStateOperationInvalidatedError } from "../plugin-state/plugin-state-operation-error.js";

export type {
  PluginStateOperation,
  PluginStateOperationCommand,
  PluginStateOperationDefinitions,
  PluginStateOperationHandler,
  PluginStateOperationReceipt,
  PluginStateOperationTransaction,
} from "../plugin-state/plugin-state-store.types.js";

export type {
  SessionEntryCurrentCheck,
  SessionEntryCurrentPreparation,
} from "../config/sessions/session-entry-current.types.js";

export function createPluginStateErrorReporter(
  getRuntime: () => Pick<PluginRuntime, "logging"> | null | undefined,
  plugin: string,
  feature: string,
  message: string,
  formatError = (error: unknown): Record<string, unknown> => ({ error: String(error) }),
) {
  return (error: unknown): void => {
    try {
      getRuntime()?.logging.getChildLogger({ plugin, feature }).warn(message, formatError(error));
    } catch {
      // State fallback must remain available even when logger setup or formatting fails.
    }
  };
}

export { configureSqliteConnectionPragmas } from "../infra/sqlite-wal.js";
export {
  migrateSqliteSchemaToStrict,
  type SqliteStrictMigrationOptions,
  type SqliteStrictMigrationResult,
} from "../infra/sqlite-strict.js";
export type {
  OpenAsyncKeyedStoreOptions,
  OpenRetainedKeyedStoreOptions,
  OpenKeyedStoreOptions,
  PluginStateActionAuthority,
  PluginStateComparisonCondition,
  PluginStateCompareIntent,
  PluginStateCompareResult,
  PluginStateEntry,
  PluginStateKeyRange,
  PluginStateKeyedStore,
  PluginStateMoveEntries,
  PluginStateObservation,
  PluginStateSyncKeyedStore,
} from "../plugin-state/plugin-state-store.js";
export type {
  OpenBlobStoreOptions,
  PluginBlobEntry,
  PluginBlobEntryInfo,
  PluginBlobRegistrationReceipt,
  PluginBlobStore,
  PluginBlobStoreWithReceipts,
} from "../plugin-state/plugin-blob-store.js";

/** Pin an owner-published read for a final effect guard; custom stores retain their own reader. */
export async function preparePluginStateRead<T>(
  store: PluginStateKeyedStore<T>,
  key: string,
): Promise<{ read(): T | undefined; release(): void } | undefined> {
  const facts = await preparePluginStateEntry(store, key);
  return (
    facts && {
      // SAFETY: The store owns this namespace's JSON value type, as with lookup.
      read: () => facts.read() as T | undefined,
      release: () => facts.release(),
    }
  );
}

/** Validate committed ownership and every possible pending value without exposing a stale read.
 * The predicate must be pure and synchronous. Release with the effect owner's custody.
 */
export async function preparePluginStateGuard<T>(
  store: PluginStateKeyedStore<T>,
  key: string,
  assertValueCurrent: (value: T | undefined) => void,
): Promise<{ assertCurrent: () => void; release: () => void } | undefined> {
  const facts = await preparePluginStateEntry(store, key, (value) =>
    // SAFETY: The namespace's JSON type is store-owned; predicates must validate its domain shape.
    assertValueCurrent(value as T | undefined),
  );
  return (
    facts && {
      assertCurrent: () => {
        facts.read();
      },
      release: () => facts.release(),
    }
  );
}

async function preparePluginStateEntry(
  store: object,
  key: string,
  assertValueCurrent?: (value: unknown) => void,
) {
  const binding = capturePluginStateNativeBindingStore(store);
  if (!binding) {
    return undefined;
  }
  const [{ capturePluginStateNativeBindingFacts }, { validateKey }] = await Promise.all([
    import("../plugin-state/plugin-state-native-binding-facts.js"),
    import("../plugin-state/plugin-state-store.validation.js"),
  ]);
  const facts = await capturePluginStateNativeBindingFacts(
    binding,
    validateKey(key, "lookup"),
    true,
    assertValueCurrent,
  );
  return facts;
}

/** Deny pending or unknown owner writes before a retained synchronous effect guard reads. */
export function assertPluginStateReadAvailable<T>(store: PluginStateKeyedStore<T>): void {
  capturePluginStateNativeBindingStore(store)?.assertReadable();
}
