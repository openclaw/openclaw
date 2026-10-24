import { isOwnedTranscriptPayload } from "../config/sessions/transcript-json.js";
import { projectModelContextMessages } from "../shared/model-context-message.js";
import type { PluginHookName } from "./types.js";

export class HookIsolationError extends Error {}

function containsSharedMemory(value: unknown, seen: Set<object>, sourceData = false): boolean {
  if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) {
    return true;
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  if (ArrayBuffer.isView(value)) {
    // Native clones read backing slots, not custom view properties or accessors.
    const prototype =
      value instanceof DataView ? DataView.prototype : Object.getPrototypeOf(Uint8Array.prototype);
    return (
      typeof SharedArrayBuffer !== "undefined" &&
      Reflect.get(prototype, "buffer", value) instanceof SharedArrayBuffer
    );
  }
  if (value instanceof ArrayBuffer || isOwnedTranscriptPayload(value)) {
    return false;
  }
  const webAssemblyMemory = (
    globalThis as unknown as {
      WebAssembly?: { Memory?: { new (...args: unknown[]): object; prototype: object } };
    }
  ).WebAssembly?.Memory;
  if (
    webAssemblyMemory &&
    value instanceof webAssemblyMemory &&
    typeof SharedArrayBuffer !== "undefined" &&
    Reflect.get(webAssemblyMemory.prototype, "buffer", value) instanceof SharedArrayBuffer
  ) {
    return true;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (value instanceof Map) {
    const entries = Map.prototype.entries.call(value) as IterableIterator<[unknown, unknown]>;
    for (const [key, entry] of entries) {
      if (
        containsSharedMemory(key, seen, sourceData) ||
        containsSharedMemory(entry, seen, sourceData)
      ) {
        return true;
      }
    }
    return false;
  }
  if (value instanceof Set) {
    const entries = Set.prototype.values.call(value) as IterableIterator<unknown>;
    for (const entry of entries) {
      if (containsSharedMemory(entry, seen, sourceData)) {
        return true;
      }
    }
    return false;
  }
  if (sourceData && !(value instanceof Error) && !Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    // Non-plain values retain their native clone semantics. Inspect their
    // actual snapshots below rather than their ignored custom properties.
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    const crossesBoundary =
      !sourceData ||
      (value instanceof Error
        ? key === "cause"
        : typeof key === "string" && descriptor?.enumerable);
    if (
      crossesBoundary &&
      descriptor &&
      "value" in descriptor &&
      containsSharedMemory(descriptor.value, seen, sourceData)
    ) {
      return true;
    }
  }
  return false;
}

export function cloneHookIsolationValue<T>(hookName: PluginHookName, value: T): T {
  try {
    // Bun omits Error.cause, so scan unowned source edges too; owned transcript JSON is frozen.
    // Accessors run only in the native clone; its unowned result is fully scanned below.
    if (containsSharedMemory(value, new Set<object>(), true)) {
      throw new TypeError("shared memory cannot be isolated");
    }
    const cloned = structuredClone(value);
    // Inspect exactly what crosses the boundary, including values produced by getters.
    if (containsSharedMemory(cloned, new Set<object>())) {
      throw new TypeError("shared memory cannot be isolated");
    }
    return cloned;
  } catch (cause) {
    throw new HookIsolationError(`[hooks] ${hookName} mutable input isolation failed`, { cause });
  }
}

/** Copy dispatch envelopes while retaining only payloads sealed by the transcript owner. */
export function clonePromptHookEvent<T extends { messages: unknown[] }>(
  hookName: PluginHookName,
  event: T,
): T {
  try {
    const shared: Array<{ index: number; key: string; value: object }> = [];
    const messages = projectModelContextMessages(event.messages);
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      if (!message || typeof message !== "object") {
        continue;
      }
      const prototype = Object.getPrototypeOf(message);
      // Preserve native cloning for non-record values, including Error.cause.
      if (prototype !== Object.prototype && prototype !== null) {
        continue;
      }
      const original = event.messages[index];
      const ownedMessage =
        original && typeof original === "object" && isOwnedTranscriptPayload(original)
          ? original
          : undefined;
      const envelope: Record<string, unknown> = { ...message };
      for (const key of Object.keys(envelope)) {
        const value = envelope[key];
        // Entry normalization owns the whole message. Projection can replace metadata,
        // so only unchanged fields inherit that owner's deep-freeze guarantee.
        if (
          value &&
          typeof value === "object" &&
          ((ownedMessage && Reflect.get(ownedMessage, key) === value) ||
            isOwnedTranscriptPayload(value))
        ) {
          shared.push({ index, key, value });
          envelope[key] = undefined;
        }
      }
      messages[index] = envelope;
    }
    // Clone the remaining graph with the existing native-value and shared-memory checks.
    const snapshot = cloneHookIsolationValue(hookName, { ...event, messages });
    for (const { index, key, value } of shared) {
      // Each recorded position is an own property of a plain cloned envelope.
      Object.defineProperty(snapshot.messages[index], key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return snapshot;
  } catch (cause) {
    if (cause instanceof HookIsolationError) {
      throw cause;
    }
    throw new HookIsolationError(`[hooks] ${hookName} mutable input isolation failed`, { cause });
  }
}
