import { isProxy } from "node:util/types";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  freezeJsonSnapshot,
  freezeTrustedJsonSnapshot,
  isDeeplyFrozenPlainData,
} from "../../shared/immutable-data.js";
import type { SessionTranscriptReadSnapshot } from "./session-history-read.types.js";
import { isOwnedTranscriptPayload, retainOwnedTranscriptPayload } from "./transcript-json.js";

function rejectTranscriptMapMutation(): never {
  throw new TypeError("Transcript snapshot maps are immutable");
}

const immutableMapMethods = {
  set: { value: rejectTranscriptMapMutation },
  delete: { value: rejectTranscriptMapMutation },
  clear: { value: rejectTranscriptMapMutation },
};

/** Admit decoded history roots independently of the generic freezer's rotating memo. */
export function freezeTranscriptSnapshot<T extends SessionTranscriptReadSnapshot>(snapshot: T): T {
  if (isOwnedTranscriptPayload(snapshot)) {
    return snapshot;
  }
  for (const value of Object.values(snapshot)) {
    if (value instanceof Map) {
      for (const member of value.values()) {
        freezeTrustedJsonSnapshot(member);
      }
      // Freezing a Map's properties alone does not prevent set/delete/clear.
      Object.defineProperties(value, immutableMapMethods);
      Object.freeze(value);
    } else {
      freezeTrustedJsonSnapshot(value);
    }
  }
  for (const event of snapshot.events) {
    if (isRecord(event) && event.type === "message" && isRecord(event.message)) {
      retainOwnedTranscriptPayload(event.message);
    }
  }
  retainOwnedTranscriptPayload(snapshot.events);
  retainOwnedTranscriptPayload(snapshot);
  return Object.freeze(snapshot);
}

class NativeCloneRequired extends Error {
  constructor() {
    super("Opaque session snapshot requires native cloning");
  }
}

/** Detach mutable containers while sharing sealed transcript payloads. */
export function cloneTranscriptView<T>(
  snapshot: T,
  {
    shareImmutablePayloads = true,
    freeze = false,
  }: {
    shareImmutablePayloads?: boolean;
    freeze?: boolean;
  } = {},
): T {
  const copies = new Map<object, object>();
  let plain = true;
  const copy = (value: unknown): unknown => {
    if (typeof value === "function" || typeof value === "symbol") {
      throw new NativeCloneRequired();
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    if (isProxy(value)) {
      throw new NativeCloneRequired();
    }
    // Public mutable SDK views can also alias frozen descendants outside admitted roots.
    if (
      shareImmutablePayloads &&
      (isOwnedTranscriptPayload(value) || isDeeplyFrozenPlainData(value))
    ) {
      return value;
    }
    if (copies.has(value)) {
      return copies.get(value);
    }
    const prototype = Object.getPrototypeOf(value);
    if (value instanceof Map && prototype === Map.prototype) {
      plain = false;
      const result = new Map<unknown, unknown>();
      copies.set(value, result);
      value.forEach((member, key) => result.set(copy(key), copy(member)));
      return result;
    }
    if (value instanceof Set && prototype === Set.prototype) {
      plain = false;
      const result = new Set<unknown>();
      copies.set(value, result);
      value.forEach((member) => result.add(copy(member)));
      return result;
    }
    if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) {
      throw new NativeCloneRequired();
    }
    const result: object = Array.isArray(value) ? [] : {};
    if (Array.isArray(result) && Array.isArray(value)) {
      result.length = value.length;
    }
    copies.set(value, result);
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in descriptor)) {
        throw new NativeCloneRequired();
      }
      descriptor.value = copy(descriptor.value);
      descriptor.enumerable = true;
      descriptor.configurable = true;
      descriptor.writable = true;
      Object.defineProperty(result, key, descriptor);
    }
    for (const key of Object.getOwnPropertySymbols(value)) {
      plain = false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if ("value" in descriptor) {
        descriptor.value = copy(descriptor.value);
        Object.defineProperty(result, key, descriptor);
      }
    }
    return result;
  };
  try {
    // SAFETY: Copying containers preserves the snapshot's shape and shared references.
    const cloned = copy(snapshot) as T;
    // The copier owns plain containers; opaque/symbol members still need inspection.
    return freeze
      ? plain
        ? freezeTrustedJsonSnapshot(cloned)
        : freezeJsonSnapshot(cloned)
      : cloned;
  } catch (error) {
    if (!(error instanceof NativeCloneRequired)) {
      throw error;
    }
    // fromEntries accepts opaque structured-cloneable SDK data. Clone the whole
    // graph so references crossing an opaque value retain their original identity.
    const cloned = structuredClone(snapshot);
    return freeze ? freezeJsonSnapshot(cloned) : cloned;
  }
}
