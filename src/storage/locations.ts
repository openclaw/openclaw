import { validateProviderSettings } from "../config/provider-settings.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseSecretRef } from "../config/types.secrets.js";
import type { StorageLocationConfig } from "../config/types.storage.js";
import { hasErrnoCode, isMissingPathError } from "../infra/errno.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveStorageProvider } from "../plugins/storage-provider-registry.js";
import {
  decryptStorageObject,
  encryptedStorageSize,
  encryptStorageObject,
  plaintextStorageSize,
} from "./encryption.js";
import { filesystemStorageProvider } from "./filesystem.js";
import { validateStorageKey, validateStoragePrefix } from "./keys.js";
import {
  createStorageMarker,
  readStorageMarker,
  STORAGE_MARKER_KEY,
  StorageLocationError,
  verifyStorageMarker,
  type StorageMarker,
  type StorageState,
} from "./marker.js";
import { acquireStorageProvider, type StorageRegistry } from "./provider.js";
import type { StorageObjectInfo } from "./types.js";

export type StorageLocationParams = {
  name: string;
  config: OpenClawConfig;
  registry?: StorageRegistry;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};
type StorageLocationDescription = {
  name: string;
  provider: string;
  displayTarget: string;
  locationId: string;
  encrypted: boolean;
};
export type StorageProbeResult = {
  state: StorageState;
  freeBytes?: number;
  totalBytes?: number;
  message?: string;
};
type OperationOptions = { signal?: AbortSignal };
type MutationOptions = OperationOptions & {
  precondition?: (signal?: AbortSignal) => Promise<void>;
};
export type StorageLocationObjectInfo = StorageObjectInfo & { storedBytes: number };
export type StorageLocation = {
  describe(): StorageLocationDescription;
  probe(opts?: OperationOptions): Promise<StorageProbeResult>;
  putObject(
    key: string,
    body: AsyncIterable<Uint8Array>,
    opts: MutationOptions & { sizeBytes?: number },
  ): Promise<{ sizeBytes: number; storedBytes: number }>;
  getObject(key: string, opts?: OperationOptions): Promise<AsyncIterable<Uint8Array> | undefined>;
  stat(key: string, opts?: OperationOptions): Promise<StorageLocationObjectInfo | undefined>;
  list(
    prefix?: string,
    opts?: OperationOptions & { acceptKey?: (key: string) => boolean },
  ): AsyncIterable<StorageLocationObjectInfo>;
  delete(key: string, opts?: MutationOptions): Promise<void>;
  scope(prefix: string): StorageLocation;
  close(): Promise<void>;
};

function configuredLocation(params: StorageLocationParams): StorageLocationConfig {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(params.name)) {
    throw new StorageLocationError("error", "Invalid storage location name.");
  }
  const location = params.config.storage?.locations?.[params.name];
  if (!location) {
    throw new StorageLocationError("error", `Storage location "${params.name}" is not configured.`);
  }
  return location;
}

function unavailable(name: string, displayTarget?: string): StorageLocationError {
  return new StorageLocationError(
    "unavailable",
    `Storage location "${name}"${displayTarget ? ` (${displayTarget})` : ""} has no initialization marker. If this is a new location, run \`openclaw storage init ${name}\`; otherwise reconnect the disk or check the bucket and prefix.`,
  );
}

export function storageLocationError(error: unknown): StorageLocationError {
  if (error instanceof StorageLocationError) {
    return error;
  }
  if (isMissingPathError(error) || hasErrnoCode(error, "path-mismatch")) {
    return new StorageLocationError(
      "unavailable",
      "Storage directory is unavailable. Reconnect the disk and check the configured path; storage init requires an existing directory.",
    );
  }
  // Provider errors may contain credentials or signed URLs; do not project them into RPC/CLI output.
  return new StorageLocationError(
    "error",
    "Storage could not be accessed. Check its provider settings, credentials, and connection.",
  );
}

function probeFailure(error: unknown): StorageProbeResult {
  const { state, message } = storageLocationError(error);
  return { state, message };
}

async function prepare(params: StorageLocationParams) {
  params.signal?.throwIfAborted();
  const location = configuredLocation(params);
  const invalid = validateProviderSettings(location.settings, "Storage location");
  if (invalid) {
    throw new StorageLocationError("error", invalid);
  }
  const acquired = await acquireStorageProvider({
    providerId: location.provider,
    config: params.config,
    registry: params.registry,
    env: params.env,
  }).catch((error: unknown) => {
    throw storageLocationError(error);
  });
  try {
    const message = acquired.provider.validateSettings?.(location.settings);
    if (message) {
      throw new StorageLocationError("error", message);
    }
    const env = params.env ?? process.env;
    let passphrase: string | undefined;
    if (location.encryption !== "none") {
      const { materializeSecretInput } = await import("../secrets/resolve-secret-input-string.js");
      passphrase = await materializeSecretInput({
        config: params.config,
        value: location.encryption.passphrase,
        env,
        // Passphrase bytes, including whitespace, are part of the encryption key.
        normalize: (value) => (typeof value === "string" && value.length > 0 ? value : undefined),
      });
    }
    if (location.encryption !== "none" && passphrase === undefined) {
      throw new StorageLocationError(
        "wrong-key",
        `Storage location "${params.name}" requires a nonempty encryption passphrase.`,
      );
    }
    const backend = await acquired.provider.open({
      locationName: params.name,
      settings: location.settings,
      signal: params.signal,
      resolveSecret: async (value) => {
        const ref = parseSecretRef(value, params.config.secrets?.defaults);
        if (!ref) {
          throw new Error("Storage provider credentials must use SecretRefs.");
        }
        const { resolveSecretRefString } = await import("../secrets/resolve.js");
        return await resolveSecretRefString(ref, { config: params.config, env });
      },
    });
    let closed = false;
    const close = async () => {
      if (closed) {
        return;
      }
      closed = true;
      try {
        try {
          await backend.close?.();
        } finally {
          await acquired.release();
        }
      } catch (error) {
        throw storageLocationError(error);
      }
    };
    return { backend, passphrase, provider: location.provider, close };
  } catch (error) {
    await acquired.release().catch((releaseError: unknown) => {
      throw storageLocationError(releaseError);
    });
    throw storageLocationError(error);
  }
}

async function makeLocation(
  params: StorageLocationParams,
  prepared: Awaited<ReturnType<typeof prepare>>,
  marker: StorageMarker,
): Promise<StorageLocation> {
  const { backend, passphrase } = prepared;
  const masterKey = await verifyStorageMarker(params.name, marker, passphrase);
  let closed = false;
  const markerIdentity = JSON.stringify(marker);
  const assertOpen = (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (closed) {
      throw new StorageLocationError("unavailable", "Storage location is closed.");
    }
  };
  const check = async (signal?: AbortSignal) => {
    assertOpen(signal);
    const current = await readStorageMarker(backend, signal).catch((error: unknown) => {
      throw storageLocationError(error);
    });
    if (!current) {
      throw unavailable(params.name, backend.displayTarget);
    }
    if (JSON.stringify(current) !== markerIdentity) {
      throw new StorageLocationError(
        "unavailable",
        `Storage location "${params.name}" identity changed; reopen the location before using it.`,
      );
    }
    assertOpen(signal);
  };
  const info = (object: StorageObjectInfo): StorageLocationObjectInfo => ({
    ...object,
    storedBytes: object.sizeBytes,
    sizeBytes: masterKey ? plaintextStorageSize(object.sizeBytes) : object.sizeBytes,
  });
  const scoped = (namespace: string): StorageLocation => {
    const keyFor = (key: string) => {
      validateStorageKey(key);
      const fullKey = namespace + key;
      validateStorageKey(fullKey);
      if (fullKey === STORAGE_MARKER_KEY) {
        throw new Error("The storage marker is reserved for the storage owner.");
      }
      return fullKey;
    };
    const options = (opts?: OperationOptions) => ({ signal: opts?.signal ?? params.signal });
    return {
      describe: () => ({
        name: params.name,
        provider: prepared.provider,
        displayTarget: backend.displayTarget,
        locationId: marker.locationId,
        encrypted: masterKey !== undefined,
      }),
      probe: async (opts) => {
        try {
          const operation = options(opts);
          await check(operation.signal);
          return { state: "ok", ...(await backend.probe(operation)) };
        } catch (error) {
          return probeFailure(error);
        }
      },
      putObject: async (key, body, opts) => {
        const fullKey = keyFor(key);
        const operation = options(opts);
        if (opts.sizeBytes !== undefined) {
          encryptedStorageSize(opts.sizeBytes);
        }
        await check(operation.signal);
        let plaintextBytes = 0;
        let preconditionFailure: { error: unknown } | undefined;
        async function* counted() {
          for await (const chunk of body) {
            operation.signal?.throwIfAborted();
            plaintextBytes += chunk.byteLength;
            if (opts.sizeBytes !== undefined && plaintextBytes > opts.sizeBytes) {
              throw new Error("Storage object is larger than its declared size.");
            }
            yield chunk;
          }
          if (opts.sizeBytes !== undefined && plaintextBytes !== opts.sizeBytes) {
            throw new Error("Storage object does not match its declared size.");
          }
          // Recheck identity after consuming a potentially long producer, before publication.
          await check(operation.signal);
          try {
            await opts.precondition?.(operation.signal);
            assertOpen(operation.signal);
          } catch (error) {
            preconditionFailure = { error };
            throw error;
          }
        }
        const stored = await backend
          .putObject(fullKey, masterKey ? encryptStorageObject(counted(), masterKey) : counted(), {
            ...operation,
            sizeBytes:
              opts.sizeBytes === undefined
                ? undefined
                : masterKey
                  ? encryptedStorageSize(opts.sizeBytes)
                  : opts.sizeBytes,
          })
          .catch((error: unknown) => {
            if (!preconditionFailure || error === preconditionFailure.error) {
              throw error;
            }
            // Keep the caller's refusal and provider diagnostics, including failed cleanup.
            throw new Error(
              `${formatErrorMessage(preconditionFailure.error)}\n${formatErrorMessage(error)}`,
              { cause: error },
            );
          });
        return { sizeBytes: plaintextBytes, storedBytes: stored.sizeBytes };
      },
      getObject: async (key, opts) => {
        const fullKey = keyFor(key);
        const operation = options(opts);
        await check(operation.signal);
        const body = await backend.getObject(fullKey, operation);
        return body && masterKey ? decryptStorageObject(body, masterKey) : body;
      },
      stat: async (key, opts) => {
        const fullKey = keyFor(key);
        const operation = options(opts);
        assertOpen(operation.signal);
        const object = await backend.statObject(fullKey, operation);
        assertOpen(operation.signal);
        return object ? { ...info(object), key } : undefined;
      },
      async *list(prefix, opts) {
        const requestedPrefix = prefix ?? "";
        validateStoragePrefix(requestedPrefix);
        const fullPrefix = namespace + requestedPrefix;
        validateStoragePrefix(fullPrefix);
        const operation = options(opts);
        assertOpen(operation.signal);
        for await (const object of backend.listObjects(fullPrefix, operation)) {
          assertOpen(operation.signal);
          if (!object.key.startsWith(fullPrefix)) {
            throw new Error("Storage provider returned an object outside the requested prefix.");
          }
          try {
            validateStorageKey(object.key);
          } catch {
            continue;
          }
          const key = object.key.slice(namespace.length);
          // Consumers can ignore foreign objects before interpreting encrypted sizes.
          if (object.key !== STORAGE_MARKER_KEY && (!opts?.acceptKey || opts.acceptKey(key))) {
            yield {
              ...info(object),
              key,
            };
          }
        }
      },
      delete: async (key, opts) => {
        const fullKey = keyFor(key);
        const operation = options(opts);
        await check(operation.signal);
        await opts?.precondition?.(operation.signal);
        assertOpen(operation.signal);
        await backend.deleteObject(fullKey, operation);
      },
      scope: (prefix) => {
        const next = keyFor(prefix) + "/";
        validateStoragePrefix(next);
        return scoped(next);
      },
      close: async () => {
        closed = true;
        await prepared.close();
      },
    };
  };
  return scoped("");
}

export async function openStorageLocation(params: StorageLocationParams): Promise<StorageLocation> {
  const prepared = await prepare(params);
  try {
    const marker = await readStorageMarker(prepared.backend, params.signal);
    if (!marker) {
      throw unavailable(params.name, prepared.backend.displayTarget);
    }
    return await makeLocation(params, prepared, marker);
  } catch (error) {
    await prepared.close();
    throw storageLocationError(error);
  }
}

export async function initStorageLocation(params: StorageLocationParams): Promise<StorageLocation> {
  const prepared = await prepare(params);
  try {
    let marker = await readStorageMarker(prepared.backend, params.signal);
    if (!marker) {
      const candidate = await createStorageMarker(params.name, prepared.passphrase);
      const bytes = Buffer.from(JSON.stringify(candidate) + "\n");
      try {
        await prepared.backend.putObject(
          STORAGE_MARKER_KEY,
          (async function* () {
            yield bytes;
          })(),
          { sizeBytes: bytes.length, signal: params.signal },
        );
        marker = candidate;
      } catch (error) {
        // Concurrent init may have won its conditional create; verify that winner.
        marker = await readStorageMarker(prepared.backend, params.signal);
        if (!marker || marker.locationId === candidate.locationId) {
          throw error;
        }
      }
    }
    return await makeLocation(params, prepared, marker);
  } catch (error) {
    await prepared.close();
    throw storageLocationError(error);
  }
}

export async function probeStorageLocation(
  params: StorageLocationParams,
): Promise<StorageProbeResult> {
  try {
    const location = await openStorageLocation(params);
    try {
      return await location.probe();
    } finally {
      await location.close();
    }
  } catch (error) {
    return probeFailure(error);
  }
}

/** Configuration projection only; no provider activation or destination I/O. */
export function listStorageLocations(
  config: OpenClawConfig,
  registry?: StorageRegistry,
): Array<{ name: string; provider: string; encrypted: boolean; displayTarget?: string }> {
  return Object.entries(config.storage?.locations ?? {})
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([name, location]) => {
      const provider =
        location.provider === "filesystem"
          ? filesystemStorageProvider
          : registry
            ? resolveStorageProvider(registry, location.provider)
            : undefined;
      const displayTarget = provider?.describeTarget?.(location.settings);
      const description = {
        name,
        provider: location.provider,
        encrypted: location.encryption !== "none",
      };
      return displayTarget === undefined
        ? description
        : Object.assign(description, { displayTarget });
    });
}
