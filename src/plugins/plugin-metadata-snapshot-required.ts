import { fileURLToPath } from "node:url";
import { isPluginSourceModulePath, tryNativeRequireModule } from "./native-module-require.js";
import {
  snapshotReaderSlot,
  type CurrentSnapshotModule,
  type SnapshotLoaderModule,
} from "./plugin-metadata-snapshot-readers.js";

// Required policy readers must preserve loader failures. Source and built code
// select one owner entry; neither falls back to optional/empty policy on error.
function loadRequiredSnapshotReaders(): typeof import("./plugin-metadata-readers.runtime.js") {
  const source = isPluginSourceModulePath(fileURLToPath(import.meta.url));
  const modulePath = fileURLToPath(
    new URL(
      source ? "./plugin-metadata-readers.runtime.ts" : "./plugin-metadata-readers.runtime.js",
      import.meta.url,
    ),
  );
  const native = tryNativeRequireModule(modulePath);
  if (!native.ok) {
    throw new Error(`Host plugin metadata runtime requires native loading: ${modulePath}`);
  }
  // SAFETY: Both fixed targets expose the typed metadata owner exports through the same entry.
  return native.moduleExport as typeof import("./plugin-metadata-readers.runtime.js");
}

/** Reads current policy through its canonical owner, requiring a working runtime. */
export function getCurrentPluginMetadataSnapshotRequiredRuntime(
  params: Parameters<CurrentSnapshotModule["getCurrentPluginMetadataSnapshot"]>[0],
): ReturnType<CurrentSnapshotModule["getCurrentPluginMetadataSnapshot"]> {
  const reader =
    snapshotReaderSlot.getCurrentPluginMetadataSnapshot ??
    loadRequiredSnapshotReaders().getCurrentPluginMetadataSnapshot;
  return reader(params);
}

/** Loads metadata through its canonical owner without suppressing discovery errors. */
export function loadPluginMetadataSnapshotRuntime(
  params: Parameters<SnapshotLoaderModule["loadPluginMetadataSnapshot"]>[0],
): ReturnType<SnapshotLoaderModule["loadPluginMetadataSnapshot"]> {
  const reader =
    snapshotReaderSlot.loadPluginMetadataSnapshot ??
    loadRequiredSnapshotReaders().loadPluginMetadataSnapshot;
  return reader(params);
}
