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
    // Bun omits Error.cause, so only it needs a source scan in addition to the snapshot.
    if (process.versions.bun && containsSharedMemory(value, new Set<object>(), true)) {
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
    const unowned: unknown[] = [];
    const positions: Array<{ target: object; key: string }> = [];
    const isolate = (target: object, key: string, value: unknown, owned = false) => {
      const kind = typeof value;
      if (
        value === null ||
        (kind !== "object" && kind !== "function" && kind !== "symbol") ||
        owned
      ) {
        return;
      }
      unowned.push(value);
      positions.push({ target, key });
    };
    const messages = projectModelContextMessages(event.messages);
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      if (message && typeof message === "object") {
        const prototype = Object.getPrototypeOf(message);
        if (prototype === Object.prototype || prototype === null) {
          const original = event.messages[index];
          const ownedMessage =
            original && typeof original === "object" && isOwnedTranscriptPayload(original)
              ? original
              : undefined;
          const entries: [string, unknown][] = Object.entries(message);
          const envelope = Object.fromEntries(entries);
          for (const [key, value] of entries) {
            // Projection may replace metadata; only unchanged fields inherit ownership.
            isolate(
              envelope,
              key,
              value,
              value !== null &&
                typeof value === "object" &&
                ((ownedMessage !== undefined && Reflect.get(ownedMessage, key) === value) ||
                  isOwnedTranscriptPayload(value)),
            );
          }
          messages[index] = envelope;
          continue;
        }
      }
      isolate(messages, String(index), message);
    }
    const snapshot = { ...event, messages };
    for (const key of Reflect.ownKeys(snapshot)) {
      if (typeof key === "symbol") {
        Reflect.deleteProperty(snapshot, key);
      } else if (key !== "messages") {
        isolate(snapshot, key, Reflect.get(snapshot, key));
      }
    }
    if (unowned.length) {
      // One graph clone preserves aliases among unowned values and native-value checks.
      const cloned = cloneHookIsolationValue(hookName, unowned);
      for (const [index, { target, key }] of positions.entries()) {
        Object.defineProperty(target, key, {
          value: cloned[index],
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    return snapshot;
  } catch (cause) {
    if (cause instanceof HookIsolationError) {
      throw cause;
    }
    throw new HookIsolationError(`[hooks] ${hookName} mutable input isolation failed`, { cause });
  }
}
