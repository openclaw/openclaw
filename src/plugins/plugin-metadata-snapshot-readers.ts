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

const readerCustody = resolveGlobalSingleton(
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
    // Live Gateways retain their module graph through the final close join.
    if (readerCustody.owners === 0) {
      for (const key of readerKeys) {
        delete readers[key];
      }
    }
  },
  "close-only",
);

/** Keep the running installation's readers until its final Gateway finishes closing. */
export function retainPluginMetadataSnapshotReaders(): () => void {
  if (readerCustody.owners++ === 0) {
    for (const key of readerKeys) {
      let reader = snapshotReaderSlot[key];
      Object.defineProperty(snapshotReaderSlot, key, {
        configurable: true,
        enumerable: true,
        get: () => reader,
        set: (next: SnapshotReaderSlot[typeof key]) => {
          // Released module copies assign this slot directly. Let bootstrap fill
          // absent readers, but never replace a reader that owns live scope state.
          reader ??= next;
        },
      });
    }
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    if (--readerCustody.owners === 0) {
      for (const key of readerKeys) {
        Object.defineProperty(snapshotReaderSlot, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: snapshotReaderSlot[key],
        });
      }
    }
  };
}

/** Called at module evaluation; a retained Gateway keeps its registered readers. */
export function registerPluginMetadataSnapshotReaders(readers: SnapshotReaderSlot): void {
  Object.assign(snapshotReaderSlot, readers);
}
