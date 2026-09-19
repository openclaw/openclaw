import type { Result } from "@openclaw/normalization-core/result";

// Public plugin-state store contracts. Stores are keyed by plugin id and
// namespace, persist JSON-compatible values, and enforce per-namespace limits.
export type PluginStateEntry<T> = {
  key: string;
  value: T;
  createdAt: number;
  expiresAt?: number;
};

/** An opaque comparison of one store/key's live value and storage metadata, not ownership. */
export type PluginStateObservation<T> = {
  value: T | undefined;
  comparison: string;
};

export type PluginStateCompareIntent<T> =
  | { operation: "update"; action: "set"; value: T; ttlMs?: number }
  | { operation: "update" | "delete"; action: "keep" }
  | { operation: "delete"; action: "delete" };

export type PluginStateCompareResult<T> =
  | { status: "applied" | "unchanged" }
  | { status: "conflict"; current: PluginStateObservation<T> };

export type PluginStateKeyRange = {
  keyStartInclusive: string;
  keyEndExclusive: string;
  limit: number;
  order?: "asc" | "desc";
};

export type PluginStateMoveEntries = {
  /** Bounded logical source namespace belonging to the same plugin. */
  namespace: string;
  entries: Array<{ sourceKey: string; targetKey: string }>;
};

/** Async plugin state API exposed to plugin runtimes. */
export type PluginStateKeyedStore<T> = {
  /** Prepares a mutation observation through canonical writable admission; may create state. */
  observe?: (key: string) => Promise<PluginStateObservation<T>>;
  /** Compares the observed row before applying prepared data; only explicit conflicts may retry. */
  compareAndApply?: (
    key: string,
    comparison: string,
    intent: PluginStateCompareIntent<T>,
  ) => Promise<PluginStateCompareResult<T>>;
  register(key: string, value: T, opts?: { ttlMs?: number }): Promise<void>;
  registerIfAbsent(key: string, value: T, opts?: { ttlMs?: number }): Promise<boolean>;
  /**
   * The updater runs synchronously in the transaction; undefined leaves the entry unchanged.
   * @deprecated This callback blocks the main thread. Use data-only operations when they preserve
   * the complete atomic change. Retained through the next Plugin SDK major.
   */
  update?: (
    key: string,
    updateValue: (current: T | undefined) => T | undefined,
    opts?: { ttlMs?: number },
  ) => Promise<boolean>;
  /**
   * The synchronous predicate and conditional deletion run in one transaction.
   * @deprecated This callback blocks the main thread. Use deleteIfEqual for scalar comparisons;
   * other atomic predicates remain supported through the next Plugin SDK major.
   */
  deleteIf?: (key: string, predicate: (current: T) => boolean) => Promise<boolean>;
  /** Atomically deletes a live entry equal to the supplied JSON scalar, without a callback. */
  deleteIfEqual?: (key: string, expected: string | number | boolean | null) => Promise<boolean>;
  lookup(key: string): Promise<T | undefined>;
  /** Positional outcomes for at most 10,000 keys; missing/expired values are undefined. */
  lookupMany?: (
    keys: readonly string[],
  ) => Promise<Array<Result<T | undefined, PluginStateStoreError>>>;
  consume(key: string): Promise<T | undefined>;
  delete(key: string): Promise<boolean>;
  entries(): Promise<PluginStateEntry<T>[]>;
  /** Reads a lexical key range with ordering and limit applied by storage. */
  entriesInKeyRange?: (range: PluginStateKeyRange) => Promise<PluginStateEntry<T>[]>;
  /**
   * Atomically settles at most 10,000 bounded source rows into this retained store.
   * Existing targets win; live expiring sources reject the entire operation.
   */
  moveEntriesFrom?: (source: PluginStateMoveEntries) => Promise<number>;
  /** Counts live stored rows without decoding values; absent on older hosts and adapters. */
  count?: () => Promise<number>;
  clear(): Promise<void>;
};

/**
 * Synchronous plugin-state compatibility contract.
 * @deprecated Use PluginStateKeyedStore from api.runtime.state.openKeyedStore
 * and await its operations. Retained through the next Plugin SDK major.
 */
export type PluginStateSyncKeyedStore<T> = {
  register(key: string, value: T, opts?: { ttlMs?: number }): void;
  registerIfAbsent(key: string, value: T, opts?: { ttlMs?: number }): boolean;
  update?: (
    key: string,
    updateValue: (current: T | undefined) => T | undefined,
    opts?: { ttlMs?: number },
  ) => boolean;
  /** Atomically deletes an existing entry when its current value matches. */
  deleteIf?: (key: string, predicate: (current: T) => boolean) => boolean;
  lookup(key: string): T | undefined;
  /** Positional outcomes for at most 10,000 keys; missing/expired values are undefined. */
  lookupMany?: (keys: readonly string[]) => Array<Result<T | undefined, PluginStateStoreError>>;
  consume(key: string): T | undefined;
  delete(key: string): boolean;
  entries(): PluginStateEntry<T>[];
  /** Counts live stored rows without decoding values; absent on older hosts and adapters. */
  count?: () => number;
  clear(): void;
};

/** Options for opening a keyed plugin-state namespace. */
export type PluginStateOverflowPolicy = "evict-oldest" | "reject-new";

/** Published bounded-store options; also used by sync stores, imports, and journals. */
export type OpenKeyedStoreOptions = {
  namespace: string;
  maxEntries: number;
  retention?: "bounded";
  overflowPolicy?: PluginStateOverflowPolicy;
  defaultTtlMs?: number;
  env?: NodeJS.ProcessEnv;
};

/** Retained stores are available only through asynchronous keyed-store openers. */
export type OpenRetainedKeyedStoreOptions = {
  namespace: string;
  retention: "retained";
  maxEntries?: never;
  overflowPolicy?: never;
  defaultTtlMs?: never;
  env?: NodeJS.ProcessEnv;
};

export type OpenAsyncKeyedStoreOptions = OpenKeyedStoreOptions | OpenRetainedKeyedStoreOptions;

export type PluginStateStoreErrorCode =
  | "PLUGIN_STATE_SQLITE_UNAVAILABLE"
  | "PLUGIN_STATE_OPEN_FAILED"
  | "PLUGIN_STATE_WRITE_FAILED"
  | "PLUGIN_STATE_READ_FAILED"
  | "PLUGIN_STATE_CORRUPT"
  | "PLUGIN_STATE_LIMIT_EXCEEDED"
  | "PLUGIN_STATE_INVALID_INPUT";

export type PluginStateStoreOperation =
  | "load-sqlite"
  | "open"
  | "ensure-schema"
  | "register"
  | "lookup"
  | "consume"
  | "delete"
  | "entries"
  | "count"
  | "clear"
  | "sweep"
  | "probe"
  | "close";

type PluginStateStoreErrorOptions = {
  code: PluginStateStoreErrorCode;
  operation: PluginStateStoreOperation;
  path?: string;
  cause?: unknown;
};

/** Typed error thrown for plugin-state validation and sqlite failures. */
export class PluginStateStoreError extends Error {
  readonly code: PluginStateStoreErrorCode;
  readonly operation: PluginStateStoreOperation;
  readonly path?: string;

  constructor(message: string, options: PluginStateStoreErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "PluginStateStoreError";
    this.code = options.code;
    this.operation = options.operation;
    if (options.path) {
      this.path = options.path;
    }
  }
}
