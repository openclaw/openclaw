import {
  isRetainedPluginStateNamespace,
  MAX_PLUGIN_STATE_VALUE_BYTES,
  RETAINED_PLUGIN_STATE_NAMESPACE_PREFIX,
} from "./plugin-state-store.kernel.js";
import {
  PluginStateStoreError,
  type OpenAsyncKeyedStoreOptions,
  type OpenKeyedStoreOptions,
  type PluginStateOverflowPolicy,
  type PluginStateStoreOperation,
} from "./plugin-state-store.types.js";
import {
  createPluginStoreOptionPolicy,
  serializePluginStoreJson,
  validateOptionalPluginStoreTtlMs,
  validatePluginStoreKey,
  validatePluginStoreNamespace,
} from "./plugin-store-validation.js";
type StoreOptionSignature = {
  maxEntries: number | undefined;
  overflowPolicy: PluginStateOverflowPolicy;
  defaultTtlMs?: number;
};

export type PreparedKeyedStoreOptions = StoreOptionSignature & {
  pluginId: string;
  namespace: string;
  env?: NodeJS.ProcessEnv;
};

export type PreparedRegisterParams = {
  key: string;
  valueJson: string;
  ttlMs?: number;
};

export type PluginStateImportEntry = {
  key: string;
  value: unknown;
  createdAt: number;
  ttlMs?: number;
};

export function invalidInput(
  message: string,
  operation: PluginStateStoreOperation = "register",
): PluginStateStoreError {
  return new PluginStateStoreError(message, {
    code: "PLUGIN_STATE_INVALID_INPUT",
    operation,
  });
}

export function validateNamespace(
  value: string,
  operation: PluginStateStoreOperation = "open",
): string {
  return validatePluginStoreNamespace({
    value,
    label: "plugin state",
    errors: {
      invalid: (message) => invalidInput(message, operation),
      limit: (message) => invalidInput(message, operation),
    },
  });
}

export function requireBoundedOptions(
  options: OpenAsyncKeyedStoreOptions,
): asserts options is OpenKeyedStoreOptions {
  if (options.retention !== undefined && options.retention !== "bounded") {
    throw invalidInput("This plugin state operation requires a bounded store.", "open");
  }
}

export function validateKey(
  value: string,
  operation: PluginStateStoreOperation = "register",
): string {
  return validatePluginStoreKey({
    value,
    label: "plugin state",
    errors: {
      invalid: (message) => invalidInput(message, operation),
      limit: (message) => invalidInput(message, operation),
    },
  });
}

export function validateMaxEntries(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw invalidInput("plugin state maxEntries must be an integer >= 1", "open");
  }
  return value;
}

export const optionPolicy = createPluginStoreOptionPolicy<StoreOptionSignature>({
  label: "plugin state",
  invalid: (message) => invalidInput(message, "open"),
});

export function validateOptionalTtlMs(
  value: number | undefined,
  operation: PluginStateStoreOperation = "register",
): number | undefined {
  return validateOptionalPluginStoreTtlMs({
    value,
    label: "plugin state ttlMs",
    errors: {
      invalid: (message) => invalidInput(message, operation),
      limit: (message) => invalidInput(message, operation),
    },
  });
}

export function prepareRegisterParams(
  key: string,
  value: unknown,
  defaultTtlMs?: number,
  opts?: { ttlMs?: number },
  namespace?: string,
): PreparedRegisterParams {
  const normalizedKey = validateKey(key, "register");
  const json = serializePluginStoreJson({
    value,
    label: "plugin state value",
    maxBytes: MAX_PLUGIN_STATE_VALUE_BYTES,
    errors: {
      invalid: (message) => invalidInput(message, "register"),
      limit: (message) =>
        new PluginStateStoreError(message, {
          code: "PLUGIN_STATE_LIMIT_EXCEEDED",
          operation: "register",
        }),
    },
  });
  const ttlMs = validateOptionalTtlMs(opts?.ttlMs, "register") ?? defaultTtlMs;
  if (namespace && isRetainedPluginStateNamespace(namespace) && ttlMs !== undefined) {
    throw invalidInput("Retained plugin state does not accept a TTL.");
  }
  return {
    key: normalizedKey,
    valueJson: json,
    ...(ttlMs != null ? { ttlMs } : {}),
  };
}

export function prepareLookupKeys(keys: readonly string[]): string[] {
  if (keys.length > 10_000) {
    throw invalidInput("plugin state lookupMany accepts at most 10000 keys", "lookup");
  }
  return Array.from(keys, (key) => validateKey(key, "lookup"));
}
export function prepareKeyedStoreOptions(
  pluginId: string,
  options: OpenAsyncKeyedStoreOptions,
): PreparedKeyedStoreOptions {
  const logicalNamespace = validateNamespace(options.namespace);
  if (options.retention === "retained") {
    if (
      options.maxEntries !== undefined ||
      options.overflowPolicy !== undefined ||
      options.defaultTtlMs !== undefined
    ) {
      throw invalidInput(
        "Retained plugin state does not accept count, overflow or TTL options.",
        "open",
      );
    }
    const namespace = `${RETAINED_PLUGIN_STATE_NAMESPACE_PREFIX}${logicalNamespace}`;
    return {
      pluginId,
      namespace,
      maxEntries: undefined,
      overflowPolicy: "evict-oldest",
      env: options.env,
    };
  }
  requireBoundedOptions(options);
  const namespace = logicalNamespace;
  const maxEntries = validateMaxEntries(options.maxEntries);
  const overflowPolicy = optionPolicy.resolveOverflowPolicy(options.overflowPolicy);
  const defaultTtlMs = validateOptionalTtlMs(options.defaultTtlMs);
  const env = options.env;
  optionPolicy.assertConsistent(pluginId, namespace, {
    maxEntries,
    overflowPolicy,
    defaultTtlMs,
  });
  return { pluginId, namespace, maxEntries, overflowPolicy, defaultTtlMs, env };
}
