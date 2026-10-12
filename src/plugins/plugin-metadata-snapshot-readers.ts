// Shares the canonical metadata owner functions across source and built module graphs.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type CurrentSnapshotModule = Pick<
  typeof import("./current-plugin-metadata-snapshot.js"),
  "adoptCurrentPluginMetadataSnapshotIfAbsent" | "getCurrentPluginMetadataSnapshot"
>;
export type SnapshotLoaderModule = Pick<
  typeof import("./plugin-metadata-snapshot.js"),
  "resolvePluginMetadataSnapshot" | "loadPluginMetadataSnapshot"
>;

type SnapshotReaderSlot = Partial<CurrentSnapshotModule & SnapshotLoaderModule>;

const readerLifetime = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginMetadataSnapshotReaderCustody"),
  () => ({ owners: 0 }),
);
const readerKeys = [
  "adoptCurrentPluginMetadataSnapshotIfAbsent",
  "getCurrentPluginMetadataSnapshot",
  "resolvePluginMetadataSnapshot",
  "loadPluginMetadataSnapshot",
] as const satisfies readonly (keyof SnapshotReaderSlot)[];

// globalThis-keyed so a require-loaded second module instance shares the slot.
export const snapshotReaderSlot = resolveGlobalSingleton<SnapshotReaderSlot>(
  Symbol.for("openclaw.pluginMetadataSnapshotReaders"),
  () => ({}),
  (readers) => {
    // A running Gateway retains its module graph through shutdown.
    if (!readerLifetime.owners) {
      for (const key of readerKeys) {
        delete readers[key];
      }
    }
  },
  "close-only",
);

/** Keep the running installation's readers until the Gateway finishes closing. */
export function retainPluginMetadataSnapshotReaders(): () => void {
  readerLifetime.owners = 1;
  for (const key of readerKeys) {
    let reader = snapshotReaderSlot[key];
    Object.defineProperty(snapshotReaderSlot, key, {
      configurable: true,
      enumerable: true,
      get: () => reader,
      set: (next: SnapshotReaderSlot[typeof key]) => {
        // Released module copies assign directly after an in-place package update.
        reader ??= next;
      },
    });
  }
  return () => {
    readerLifetime.owners = 0;
    for (const key of readerKeys) {
      Object.defineProperty(snapshotReaderSlot, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: snapshotReaderSlot[key],
      });
    }
  };
}

/** Called at module evaluation; a retained Gateway keeps its registered readers. */
export function registerPluginMetadataSnapshotReaders(readers: SnapshotReaderSlot): void {
  Object.assign(snapshotReaderSlot, readers);
}
