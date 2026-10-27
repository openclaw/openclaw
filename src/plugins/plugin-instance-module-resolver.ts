import Module from "node:module";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";
import type { PluginModuleLoaderOwner } from "./plugin-instance.types.js";

// Failed acquisitions stay known without retaining their registration after collection.
export const retainedNativeEsmOwners = resolveGlobalSingleton(
  Symbol.for("openclaw.retainedNativeEsmPluginOwners"),
  () => new WeakMap<PluginModuleLoaderOwner, { owners: Set<PluginModuleLoaderOwner> }>(),
);

type ModuleResolver = {
  instance: PluginModuleLoaderOwner;
  resolve: Module.ResolveHookSync;
};
const moduleResolvers = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginInstanceModuleResolvers"),
  (): {
    boundaries: Map<string, ModuleResolver[]>;
    hooks?: ReturnType<typeof Module.registerHooks>;
  } => ({ boundaries: new Map() }),
);

function findModuleResolver(url: string | undefined): Module.ResolveHookSync | undefined {
  if (!url?.startsWith("file:")) {
    return undefined;
  }
  for (let end = url.lastIndexOf("/"); end >= 7; end = url.lastIndexOf("/", end - 1)) {
    const owners = moduleResolvers.boundaries.get(url.slice(0, end + 1));
    if (owners) {
      const requested = pluginInstanceInvocation.getStore()?.instance;
      // Retained native ESM shares bytes, but each registration still owns its authority.
      return (owners.find((owner) => owner.instance === requested) ?? owners.at(-1))?.resolve;
    }
  }
  return undefined;
}

export function registerPluginInstanceModuleResolver(
  boundaryUrl: string,
  owner: ModuleResolver,
): () => void {
  let owners = moduleResolvers.boundaries.get(boundaryUrl);
  if (!owners) {
    owners = [];
    moduleResolvers.boundaries.set(boundaryUrl, owners);
  }
  owners.push(owner);
  moduleResolvers.hooks ??= Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const requested = pluginInstanceInvocation.getStore()?.instance;
      const retained = requested && retainedNativeEsmOwners.get(requested);
      if (requested && retained && !retained.owners.has(requested)) {
        throw new Error("Plugin native ESM capture has no live workspace owner for this load");
      }
      const parent = findModuleResolver(context.parentURL);
      if (parent) {
        return parent(specifier, context, nextResolve);
      }
      const resolved = nextResolve(specifier, context);
      // Entry loads start outside their capture. Resolve first, then let its owner
      // admit/prepare that target without repeating native resolution.
      const target = findModuleResolver(resolved.url);
      return target ? target(specifier, context, () => resolved) : resolved;
    },
  });
  return () => {
    owners.splice(owners.indexOf(owner), 1);
    if (owners.length === 0) {
      moduleResolvers.boundaries.delete(boundaryUrl);
    }
    if (moduleResolvers.boundaries.size === 0) {
      moduleResolvers.hooks?.deregister();
      moduleResolvers.hooks = undefined;
    }
  };
}
