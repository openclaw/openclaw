import Module, { createRequire } from "node:module";
import { state, type Runtime } from "./plugin-source-snapshot-module-hooks.js";

const hostRequire = createRequire(import.meta.url);
const nativeWorkers: unknown = hostRequire("node:worker_threads");
const nativeProcesses: unknown = hostRequire("node:child_process");

type Kind =
  | "require"
  | "create-require"
  | "module"
  | "module-prototype"
  | "module-load"
  | "meta"
  | "workers"
  | "processes"
  | "plain";

type Owner = {
  id: string;
  disposed: boolean;
  proxies: Map<object, Map<Kind, object>>;
  revokers: Array<() => void>;
};

function current(owner: Owner): Runtime {
  const runtime = !owner.disposed && state.instances.get(owner.id);
  if (!runtime) {
    throw new Error("Plugin snapshot module loader has been disposed");
  }
  return runtime;
}

function builtin(owner: Owner, request: unknown, value: unknown): unknown {
  if (request === "node:module" || request === "module") {
    return wrap(owner, value, "module");
  }
  if (request === "node:worker_threads" || request === "worker_threads") {
    return value === nativeWorkers ? value : wrap(owner, value, "workers");
  }
  if (request === "node:child_process" || request === "child_process") {
    return value === nativeProcesses ? value : wrap(owner, value, "processes");
  }
  return value;
}

function member(owner: Owner, kind: Kind, key: PropertyKey, value: unknown): unknown {
  if (kind === "require") {
    if (key === "cache" || key === "resolve") {
      return wrap(owner, value, "plain");
    }
  } else if (kind === "module") {
    if (key === "Module") {
      return wrap(owner, value, "module");
    }
    if (key === "prototype") {
      return wrap(owner, value, "module-prototype");
    }
    if (key === "createRequire") {
      return wrap(owner, value, "create-require");
    }
    if (key === "_load") {
      return wrap(owner, value, "module-load");
    }
    if (key === "_cache" || key === "_resolveFilename") {
      return wrap(owner, value, "plain");
    }
  } else if (kind === "module-prototype") {
    if (key === "constructor") {
      return wrap(owner, value, "module");
    }
    if (key === "require") {
      return wrap(owner, value, "module-load");
    }
  } else if (kind === "meta" && typeof value === "function") {
    return wrap(owner, value, key === "require" ? "require" : "plain");
  } else if ((kind === "workers" && key === "Worker") || (kind === "processes" && key === "fork")) {
    return wrap(owner, value, "plain");
  }
  return value;
}

// Handler creation is outside wrap's scope: no handler closes over a raw target.
function handler(owner: Owner, kind: Kind): ProxyHandler<object> {
  return {
    get(target, key, receiver) {
      return member(owner, kind, key, Reflect.get(target, key, receiver));
    },
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (!descriptor) {
        return undefined;
      }
      if ("value" in descriptor) {
        return { ...descriptor, value: member(owner, kind, key, Reflect.get(target, key)) };
      }
      return kind === "require" && key === "main" && descriptor.get
        ? { ...descriptor, get: wrap(owner, descriptor.get, "plain") }
        : descriptor;
    },
    apply(target, receiver, args) {
      if (typeof target !== "function") {
        throw new TypeError("Plugin snapshot export is not callable");
      }
      const value: unknown = Reflect.apply(target, receiver, args);
      if (kind === "create-require") {
        return wrap(owner, value, "require");
      }
      return kind === "require" || kind === "module-load" ? builtin(owner, args[0], value) : value;
    },
  };
}

function wrap<T>(owner: Owner, value: T, kind: Kind): T {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return value;
  }
  let kinds = owner.proxies.get(value);
  if (!kinds) {
    owner.proxies.set(value, (kinds = new Map()));
  }
  const retained = kinds.get(kind);
  if (retained) {
    // SAFETY: This entry was created for this exact target and operation kind.
    return retained as T;
  }
  const { proxy, revoke } = Proxy.revocable(value, handler(owner, kind));
  kinds.set(kind, proxy);
  owner.revokers.push(revoke);
  // SAFETY: Revocable proxies preserve their target's callable and object shape.
  return proxy as T;
}

/** Cached ESM namespaces keep revocable bridges, never permanent runtime ownership. */
export function createPluginSnapshotDispatch(id: string) {
  const owner: Owner = { id, disposed: false, proxies: new Map(), revokers: [] };
  return {
    requireFor(from: string): NodeJS.Require {
      return wrap(owner, current(owner).requireFor(from), "require");
    },
    importFor(from: string, compiled = false): ReturnType<Runtime["importFor"]> {
      return wrap(owner, current(owner).importFor(from, compiled), "plain");
    },
    meta(from: string, suffix: string): Record<string, unknown> {
      return wrap(owner, current(owner).meta(from, suffix), "meta");
    },
    get moduleFacade(): typeof Module {
      return wrap(owner, current(owner).moduleFacade, "module");
    },
    builtin(request: string, from: string): unknown {
      return builtin(owner, request, current(owner).requireFor(from)(request));
    },
    dispose() {
      if (owner.disposed) {
        return;
      }
      owner.disposed = true;
      // Revocation clears each proxy's target and handler, including retained ESM exports.
      for (const revoke of owner.revokers) {
        revoke();
      }
      owner.revokers.length = 0;
      owner.proxies.clear();
    },
  };
}

export type PluginSnapshotDispatch = ReturnType<typeof createPluginSnapshotDispatch>;
