import { types } from "node:util";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { PluginHostObject } from "./plugin-instance-owned-values.js";

type ToolExecutionBinding = <T extends object>(tool: T) => T;

// Definition views may be rebuilt by host policy; their source edge keeps the
// exact invocation/registry binding, never a fresh lookup by plugin id.
const ToolExecutionOwner = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginToolExecutionOwner"),
  () =>
    class extends PluginHostObject {
      #bind: ToolExecutionBinding;

      constructor(tool: object, bind: ToolExecutionBinding) {
        super(tool);
        this.#bind = bind;
      }

      static bindSource<T extends object>(target: object, source: T): T {
        return #bind in target ? target.#bind(source) : source;
      }
    },
);

export function bindPluginToolExecutionSource<T extends object>(target: object, source: T): T {
  return ToolExecutionOwner.bindSource(target, source);
}

const SOURCE_TOOL = Symbol.for("openclaw.beforeToolCallSourceTool");

/** Public tool objects adapt definition data to one captured execution scope. */
export function createPluginToolExecutionBinding(context: {
  admit: <T>(run: () => T) => T;
  call: (method: Function, receiver: object, args: unknown[]) => unknown;
  register: (view: object, source: object) => void;
  wrapProxy: <T>(value: T) => T;
}) {
  const views = new WeakMap<object, object>();
  const bind: ToolExecutionBinding = <T extends object>(tool: T): T => {
    const cached = views.get(tool);
    if (cached) {
      // SAFETY: Each view adapts this exact tool without changing its public shape.
      return cached as T;
    }
    for (let source: object | null = tool; source; source = Object.getPrototypeOf(source)) {
      // Callable tools and Proxy fields require the generic callable/reflective contract.
      if (typeof source === "function" || types.isProxy(source)) {
        const view = context.wrapProxy(tool);
        views.set(tool, view);
        views.set(view, view);
        void new ToolExecutionOwner(view, context.wrapProxy);
        return view;
      }
    }
    const view = Object.create(Object.getPrototypeOf(tool));
    views.set(tool, view);
    views.set(view, view);
    void new ToolExecutionOwner(view, bind);
    context.register(view, tool);
    const bindValue = (key: PropertyKey, value: unknown): unknown => {
      if (
        key === SOURCE_TOOL &&
        value !== null &&
        (typeof value === "object" || typeof value === "function")
      ) {
        return bind(value);
      }
      return typeof value === "function"
        ? (...args: unknown[]) => context.call(value, tool, args)
        : value;
    };
    for (
      let owner: object | null = tool;
      owner && owner !== Object.prototype;
      owner = Object.getPrototypeOf(owner)
    ) {
      for (const key of Reflect.ownKeys(owner)) {
        if (key === "constructor" || Object.hasOwn(view, key)) {
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(owner, key);
        if (!descriptor) {
          continue;
        }
        // Accessors remain lazy so an unreadable schema reaches tool quarantine,
        // and class-backed tools keep their private-field receiver.
        descriptor.configurable = true;
        if ("value" in descriptor) {
          descriptor.writable = true;
          descriptor.value = bindValue(key, descriptor.value);
        } else {
          descriptor.get = descriptor.get
            ? () => context.admit(() => bindValue(key, Reflect.get(tool, key, tool)))
            : undefined;
          descriptor.set = descriptor.set
            ? (value: unknown) => context.admit(() => Reflect.set(tool, key, value, tool))
            : undefined;
        }
        Object.defineProperty(view, key, descriptor);
      }
    }
    // SAFETY: Data fields retain their values; callable fields retain their signatures and receiver.
    return view as T;
  };
  const bindResultItem = (tool: unknown) =>
    tool !== null && (typeof tool === "object" || typeof tool === "function") ? bind(tool) : tool;
  return <T>(value: T): T => {
    // SAFETY: Tool factories preserve their scalar/array/null result shape.
    return (Array.isArray(value) ? value.map(bindResultItem) : bindResultItem(value)) as T;
  };
}
