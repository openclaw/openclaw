// Shared validation for plugin-owned keyed JSON and blob stores.
const MAX_PLUGIN_STORE_NAMESPACE_BYTES = 128;
const MAX_PLUGIN_STORE_KEY_BYTES = 512;
const MAX_PLUGIN_STORE_JSON_BYTES = 65_536;
const MAX_PLUGIN_STORE_JSON_DEPTH = 64;

const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/iu;
const textEncoder = new TextEncoder();

type PluginStoreValidationErrors = {
  invalid(message: string): Error;
  limit(message: string): Error;
};

type PluginStoreOptionSignature = Record<string, string | number | undefined>;

type PluginStoreOptionPolicy<T extends PluginStoreOptionSignature> = {
  resolveOverflowPolicy(value: unknown): "evict-oldest" | "reject-new";
  assertConsistent(pluginId: string, namespace: string, signature: T): void;
  clear(): void;
};

export function createPluginStoreOptionPolicy<T extends PluginStoreOptionSignature>(params: {
  label: string;
  invalid: (message: string) => Error;
}): PluginStoreOptionPolicy<T> {
  const signatures = new Map<string, T>();

  return {
    resolveOverflowPolicy(value) {
      if (value === undefined || value === "evict-oldest") {
        return "evict-oldest";
      }
      if (value === "reject-new") {
        return value;
      }
      throw params.invalid(`${params.label} overflowPolicy must be evict-oldest or reject-new`);
    },
    assertConsistent(pluginId, namespace, signature) {
      const key = `${pluginId}\0${namespace}`;
      const existing = signatures.get(key);
      if (!existing) {
        signatures.set(key, signature);
        return;
      }
      const compatible =
        Object.entries(existing).every(([name, value]) => signature[name] === value) &&
        Object.entries(signature).every(([name, value]) => existing[name] === value);
      if (!compatible) {
        throw params.invalid(
          `${params.label} namespace ${namespace} for ${pluginId} was reopened with incompatible options`,
        );
      }
    },
    clear() {
      signatures.clear();
    },
  };
}

function assertMaxUtf8Bytes(params: {
  label: string;
  value: string;
  maxBytes: number;
  invalid: (message: string) => Error;
}): void {
  if (textEncoder.encode(params.value).byteLength > params.maxBytes) {
    throw params.invalid(`${params.label} must be <= ${params.maxBytes} bytes`);
  }
}

export function validatePluginStoreNamespace(params: {
  value: string;
  label: string;
  invalid: (message: string) => Error;
}): string {
  const trimmed = params.value.trim();
  if (!NAMESPACE_PATTERN.test(trimmed)) {
    throw params.invalid(`${params.label} namespace must be a safe path segment: ${params.value}`);
  }
  assertMaxUtf8Bytes({
    label: `${params.label} namespace`,
    value: trimmed,
    maxBytes: MAX_PLUGIN_STORE_NAMESPACE_BYTES,
    invalid: params.invalid,
  });
  return trimmed;
}

export function validatePluginStoreKey(params: {
  value: string;
  label: string;
  invalid: (message: string) => Error;
}): string {
  const trimmed = params.value.trim();
  if (!trimmed) {
    throw params.invalid(`${params.label} entry key must not be empty`);
  }
  assertMaxUtf8Bytes({
    label: `${params.label} entry key`,
    value: trimmed,
    maxBytes: MAX_PLUGIN_STORE_KEY_BYTES,
    invalid: params.invalid,
  });
  return trimmed;
}

export function validatePluginStorePositiveInteger(params: {
  value: number;
  label: string;
  invalid: (message: string) => Error;
}): number {
  if (!Number.isSafeInteger(params.value) || params.value < 1) {
    throw params.invalid(`${params.label} must be a positive safe integer`);
  }
  return params.value;
}

export function validateOptionalPluginStoreTtlMs(params: {
  value: number | undefined;
  label: string;
  invalid: (message: string) => Error;
}): number | undefined {
  const value = params.value;
  if (value == null) {
    return undefined;
  }
  return validatePluginStorePositiveInteger({ ...params, value });
}

export function serializePluginStoreJson(params: {
  value: unknown;
  label: string;
  errors: PluginStoreValidationErrors;
  maxBytes?: number;
}): string {
  const seen = new WeakSet<object>();
  function assertValue(value: unknown, pathname: string, depth: number): void {
    if (depth > MAX_PLUGIN_STORE_JSON_DEPTH) {
      throw params.errors.limit(
        `${params.label} nesting exceeds maximum depth of ${MAX_PLUGIN_STORE_JSON_DEPTH}`,
      );
    }
    if (value === null) {
      return;
    }
    const valueType = typeof value;
    if (valueType === "string" || valueType === "boolean") {
      return;
    }
    if (valueType === "number") {
      if (!Number.isFinite(value)) {
        throw params.errors.invalid(`${params.label} at ${pathname} must be a finite number`);
      }
      return;
    }
    if (valueType !== "object") {
      throw params.errors.invalid(`${params.label} at ${pathname} must be JSON-serializable`);
    }

    const objectValue = value as object;
    if (seen.has(objectValue)) {
      throw params.errors.invalid(
        `${params.label} at ${pathname} must not contain circular references`,
      );
    }
    seen.add(objectValue);
    try {
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
          if (!(index in value)) {
            throw params.errors.invalid(`${params.label} array at ${pathname} must not be sparse`);
          }
          assertValue(value[index], `${pathname}[${index}]`, depth + 1);
        }
        return;
      }

      // Source-plugin realms have their own Object.prototype; class and custom prototypes stay invalid.
      const prototype = Object.getPrototypeOf(objectValue);
      const constructor =
        prototype && Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
      if (
        !prototype ||
        Object.getPrototypeOf(prototype) !== null ||
        typeof constructor !== "function" ||
        Object.getOwnPropertyDescriptor(constructor, "prototype")?.value !== prototype ||
        Function.prototype.toString.call(constructor) !== Function.prototype.toString.call(Object)
      ) {
        throw params.errors.invalid(`${params.label} object at ${pathname} must be a plain object`);
      }
      const descriptorEntries = Object.entries(Object.getOwnPropertyDescriptors(objectValue));
      if (Object.getOwnPropertySymbols(objectValue).length > 0) {
        throw params.errors.invalid(
          `${params.label} object at ${pathname} must not use symbol keys`,
        );
      }
      if (descriptorEntries.length !== Object.keys(objectValue).length) {
        throw params.errors.invalid(
          `${params.label} object at ${pathname} must not use non-enumerable properties`,
        );
      }
      for (const [key, descriptor] of descriptorEntries) {
        if (descriptor.get || descriptor.set || !("value" in descriptor)) {
          throw params.errors.invalid(
            `${params.label} object at ${pathname}.${key} must use data properties`,
          );
        }
        assertValue(descriptor.value, `${pathname}.${key}`, depth + 1);
      }
    } finally {
      seen.delete(objectValue);
    }
  }
  assertValue(params.value, "value", 0);
  const json = JSON.stringify(params.value);
  if (json === undefined) {
    throw params.errors.invalid(`${params.label} must be JSON-serializable`);
  }
  const maxBytes = params.maxBytes ?? MAX_PLUGIN_STORE_JSON_BYTES;
  if (textEncoder.encode(json).byteLength > maxBytes) {
    throw params.errors.limit(`${params.label} exceeds ${maxBytes} byte limit`);
  }
  return json;
}
