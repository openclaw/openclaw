import type { PluginRegistry } from "./registry-types.js";
import type { PluginServicesOwner } from "./service-lifecycle.types.js";

export function preparePluginServicesOwner(
  registry: PluginRegistry,
  previous: PluginServicesOwner | undefined,
): PluginServicesOwner {
  // Failed starts still own their cleanup and remain selectable for a later retry.
  const owner: PluginServicesOwner = {
    services: [],
    attempts: previous?.attempts ?? new WeakMap(),
    registrations: new Set(registry.services),
    stopped: new Set(),
    closed: false,
  };
  if (previous) {
    for (const registration of owner.registrations) {
      previous.registrations.delete(registration);
      const entry = owner.attempts.get(registration);
      if (!entry) {
        continue;
      }
      // Rollback can reclaim an earlier attempt that the rejected candidate did not select.
      const source = entry.owner;
      source.registrations.delete(registration);
      source.services.splice(source.services.indexOf(entry), 1);
      // Explicitly stopped, fully cleaned registrations can start again in a new
      // generation. Failed attempts stay in the inventory until an explicit reload.
      if (source.stopped.has(registration) && entry.cleaned && !entry.startup) {
        owner.attempts.delete(registration);
        continue;
      }
      if (source.stopped.has(registration)) {
        owner.stopped.add(registration);
      }
      entry.owner = owner;
      owner.services.push(entry);
    }
  }
  return owner;
}
