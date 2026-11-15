/** Plugin-provided transport for one kind of storage location. */
export type StorageProvider = {
  id: string;
  label: string;
  /** Return a user-facing settings error, or undefined when valid. */
  validateSettings?: (settings: Readonly<Record<string, unknown>>) => string | undefined;
  /** Pure, synchronous, non-secret display target from settings; no I/O or secret resolution. */
  describeTarget?: (settings: Readonly<Record<string, unknown>>) => string | undefined;
  open: (params: StorageProviderOpenParams) => Promise<StorageBackend>;
};

export type StorageProviderOpenParams = {
  locationName: string;
  settings: Readonly<Record<string, unknown>>;
  /** Resolves a SecretRef through the core secret owner. */
  resolveSecret: (ref: unknown) => Promise<string>;
  signal?: AbortSignal;
};

export type StorageObjectInfo = { key: string; sizeBytes: number; modifiedAt?: number };

export type StorageBackend = {
  /** Non-secret human-readable target. */
  displayTarget: string;
  probe: (opts?: { signal?: AbortSignal }) => Promise<{ freeBytes?: number; totalBytes?: number }>;
  /** Never overwrite an existing key; sizeBytes is exact when provided. */
  putObject: (
    key: string,
    body: AsyncIterable<Uint8Array>,
    opts: { sizeBytes?: number; signal?: AbortSignal },
  ) => Promise<{ sizeBytes: number }>;
  getObject: (
    key: string,
    opts?: { signal?: AbortSignal },
  ) => Promise<AsyncIterable<Uint8Array> | undefined>;
  statObject: (
    key: string,
    opts?: { signal?: AbortSignal },
  ) => Promise<StorageObjectInfo | undefined>;
  listObjects: (
    prefix: string,
    opts?: { signal?: AbortSignal },
  ) => AsyncIterable<StorageObjectInfo>;
  deleteObject: (key: string, opts?: { signal?: AbortSignal }) => Promise<void>;
  close?: () => Promise<void>;
};
