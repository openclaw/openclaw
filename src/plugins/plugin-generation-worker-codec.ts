import {
  isPluginSourceCaptureOperation,
  restorePluginRecoverySourceResolver,
  snapshotPluginRecoverySourceResolver,
  type PluginRecoverySourceResolverSnapshot,
} from "./plugin-generation-source-lookup.js";
import {
  isOwnedPluginNativeRecovery,
  restorePluginNativeRecovery,
  snapshotPluginNativeRecovery,
  type PluginNativeRecoverySnapshot,
} from "./plugin-native-admission.js";

export type GenerationWireValue =
  | { kind: "value"; value: unknown }
  | { kind: "reference"; id: number }
  | { kind: "remote"; id: number }
  | {
      kind: "function";
      id: number;
      asynchronous: boolean;
      sourceCapture: boolean;
      disposal?: true;
    }
  | { kind: "source-resolver"; id: number; snapshot: GenerationWireValue }
  | { kind: "object"; id: number; entries: [string, GenerationWireValue][] }
  | { kind: "array" | "set"; id: number; entries: GenerationWireValue[] }
  | { kind: "map"; id: number; entries: [GenerationWireValue, GenerationWireValue][] }
  | { kind: "url"; id: number; value: string }
  | { kind: "native"; id: number; snapshot: GenerationWireValue };

/** Internal owner-to-owner codec. Stateful functions remain in their producing isolate. */
export class GenerationCodec {
  private next = 0;
  private readonly handles = new Map<number, object>();
  private readonly identities = new WeakMap<object, number>();
  private readonly received = new Map<number, object>();
  private readonly remote = new WeakMap<object, number>();

  constructor(
    private readonly invoke: (
      handle: number,
      args: unknown[],
      asynchronous: boolean,
      sourceCapture: boolean,
      disposal: boolean,
    ) => unknown,
    private readonly retainNativeRoot: (
      root: PluginNativeRecoverySnapshot["roots"][number],
    ) => void,
  ) {}

  encodeArguments(values: unknown[]): GenerationWireValue[] {
    const seen = new Map<object, number>();
    return values.map((value) => this.encode(value, seen));
  }

  encode(value: unknown, seen = new Map<object, number>(), key?: string): GenerationWireValue {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
      return { kind: "value", value };
    }
    const remote = this.remote.get(value);
    if (remote !== undefined) {
      return { kind: "remote", id: remote };
    }
    const existing = seen.get(value);
    if (existing !== undefined) {
      return { kind: "reference", id: existing };
    }
    const sourceResolver =
      typeof value === "function" ? snapshotPluginRecoverySourceResolver(value) : undefined;
    const native = isOwnedPluginNativeRecovery(value);
    const persistent = native || (typeof value === "function" && !sourceResolver);
    let id = persistent ? this.identities.get(value) : undefined;
    if (id !== undefined && native) {
      return { kind: "reference", id };
    }
    if (id === undefined) {
      id = ++this.next;
      if (persistent) {
        this.identities.set(value, id);
        this.handles.set(id, value);
      }
    }
    seen.set(value, id);
    if (typeof value === "function") {
      if (sourceResolver) {
        return { kind: "source-resolver", id, snapshot: this.encode(sourceResolver, seen) };
      }
      return {
        kind: "function",
        id,
        asynchronous: value.constructor.name === "AsyncFunction" || Boolean(key?.endsWith("Async")),
        sourceCapture: isPluginSourceCaptureOperation(value),
        ...(key === "dispose" || key === "disposeAsync" ? { disposal: true as const } : {}),
      };
    }
    if (isOwnedPluginNativeRecovery(value)) {
      const snapshot = snapshotPluginNativeRecovery(value);
      snapshot.roots.forEach(this.retainNativeRoot);
      return { kind: "native", id, snapshot: this.encode(snapshot, seen) };
    }
    if (value instanceof URL) {
      return { kind: "url", id, value: value.href };
    }
    if (value instanceof Map) {
      return {
        kind: "map",
        id,
        entries: [...value].map(([k, v]) => [this.encode(k, seen), this.encode(v, seen)]),
      };
    }
    if (value instanceof Set) {
      return { kind: "set", id, entries: [...value].map((v) => this.encode(v, seen)) };
    }
    if (Array.isArray(value)) {
      return { kind: "array", id, entries: value.map((v) => this.encode(v, seen)) };
    }
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw new Error("Unsupported plugin generation transport object");
    }
    return {
      kind: "object",
      id,
      entries: Object.entries(value).map(([k, v]) => [k, this.encode(v, seen, k)]),
    };
  }

  decode(value: GenerationWireValue, message = new Map<number, object>()): unknown {
    if (value.kind === "value") {
      return value.value;
    }
    if (value.kind === "reference" || value.kind === "remote") {
      const result =
        value.kind === "remote"
          ? this.handles.get(value.id)
          : (message.get(value.id) ?? this.received.get(value.id));
      if (!result) {
        throw new Error("Expired plugin generation handle");
      }
      return result;
    }
    const known = message.get(value.id) ?? this.received.get(value.id);
    if (known) {
      return known;
    }
    let result: object;
    if (value.kind === "function") {
      result = (...args: unknown[]) =>
        this.invoke(
          value.id,
          args,
          value.asynchronous,
          value.sourceCapture,
          value.disposal === true,
        );
    } else if (value.kind === "source-resolver") {
      result = restorePluginRecoverySourceResolver(
        // SAFETY: the internal source-resolver encoder emits the lookup owner's snapshot.
        this.decode(value.snapshot, message) as PluginRecoverySourceResolverSnapshot,
      );
    } else if (value.kind === "url") {
      result = new URL(value.value);
    } else if (value.kind === "native") {
      // Both endpoints use this codec and the native admission owner's descriptor.
      result = restorePluginNativeRecovery(
        // SAFETY: the internal native encoder emits snapshotPluginNativeRecovery's descriptor.
        this.decode(value.snapshot, message) as PluginNativeRecoverySnapshot,
      );
    } else if (value.kind === "map") {
      result = new Map();
    } else if (value.kind === "set") {
      result = new Set();
    } else if (value.kind === "array") {
      result = [];
    } else {
      result = {};
    }
    message.set(value.id, result);
    if (value.kind === "function" || value.kind === "native") {
      this.received.set(value.id, result);
      this.remote.set(result, value.id);
    }
    if (value.kind === "object") {
      for (const [key, entry] of value.entries) {
        Object.defineProperty(result, key, {
          value: this.decode(entry, message),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      const native: unknown = Object.getOwnPropertyDescriptor(result, "native")?.value;
      if (native && typeof native === "object" && isOwnedPluginNativeRecovery(native)) {
        const dispose: unknown = Object.getOwnPropertyDescriptor(result, "dispose")?.value;
        const disposeAsync: unknown = Object.getOwnPropertyDescriptor(
          result,
          "disposeAsync",
        )?.value;
        if (typeof dispose === "function" && typeof disposeAsync === "function") {
          Object.defineProperty(result, "dispose", {
            value: () => {
              try {
                Reflect.apply(dispose, undefined, []);
              } finally {
                native.dispose();
              }
            },
            enumerable: true,
            configurable: true,
          });
          Object.defineProperty(result, "disposeAsync", {
            value: async () => {
              try {
                await Reflect.apply(disposeAsync, undefined, []);
              } finally {
                await native.disposeAsync();
              }
            },
            enumerable: true,
            configurable: true,
          });
        }
      }
    } else if (value.kind === "map" && result instanceof Map) {
      for (const [key, entry] of value.entries) {
        result.set(this.decode(key, message), this.decode(entry, message));
      }
    } else if (value.kind === "set" && result instanceof Set) {
      for (const entry of value.entries) {
        result.add(this.decode(entry, message));
      }
    } else if (value.kind === "array" && Array.isArray(result)) {
      for (const entry of value.entries) {
        result.push(this.decode(entry, message));
      }
    }
    return result;
  }

  call(handle: number, args: GenerationWireValue[]): unknown {
    const fn = this.handles.get(handle);
    if (typeof fn !== "function") {
      throw new Error("Invalid plugin generation method");
    }
    const message = new Map<number, object>();
    return Reflect.apply(
      fn,
      undefined,
      args.map((arg) => this.decode(arg, message)),
    );
  }
}
