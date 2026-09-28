import type { ControlUiLobsterdex } from "../../../src/plugin-sdk/control-ui-lobsterdex.ts";
import type { ApplicationContext } from "../app/context.ts";
import { acquireLobsterdexCatalog } from "../app/lobsterdex-catalog.ts";
import {
  getLobsterdexEntries,
  recordLobsterVisit,
  subscribeLobsterdex,
} from "../components/lobster-dex.ts";

export function createControlUiLobsterdex(options: {
  current: () => ApplicationContext;
  signal: AbortSignal;
}): ControlUiLobsterdex {
  let catalog: ReturnType<typeof acquireLobsterdexCatalog> | undefined;
  const stops = new Set<() => void>();
  const current = () => {
    options.signal.throwIfAborted();
    const context = options.current();
    catalog ??= acquireLobsterdexCatalog(context.gateway);
    return catalog;
  };
  options.signal.addEventListener(
    "abort",
    () => {
      for (const stop of stops) {
        stop();
      }
      stops.clear();
      catalog?.release();
    },
    { once: true },
  );
  return {
    listCatalog: () => structuredClone(current().snapshot.entries),
    getDefinition: (id) =>
      structuredClone(current().snapshot.entries.find((entry) => entry.id === id)),
    listInventory() {
      const available = new Set(current().snapshot.entries.map((entry) => entry.id));
      return [...getLobsterdexEntries()].map(([id, entry]) => ({
        id,
        firstSeenAt: entry.firstSeenAt,
        name: entry.name,
        shinySeenAt: entry.shinySeenAt,
        available: available.has(id),
      }));
    },
    async refresh() {
      await current().refresh();
      current();
    },
    subscribe(listener) {
      const notify = () => {
        current();
        listener();
      };
      const stopCatalog = current().subscribe(notify);
      const stopInventory = subscribeLobsterdex(notify);
      const stop = () => {
        stopCatalog();
        stopInventory();
        stops.delete(stop);
      };
      stops.add(stop);
      return stop;
    },
    recordEncounter(id, details = {}) {
      if (!current().snapshot.entries.some((entry) => entry.id === id)) {
        throw new Error("Choose an available Clawmoji before recording an encounter.");
      }
      if (details.name !== undefined && (!details.name.trim() || details.name.length > 80)) {
        throw new Error("A lobster name must contain 1–80 characters.");
      }
      recordLobsterVisit(id, details);
    },
  };
}
