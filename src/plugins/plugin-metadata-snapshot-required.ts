import { fileURLToPath } from "node:url";
import { isPluginSourceModulePath, tryNativeRequireModule } from "./native-module-require.js";
import {
  snapshotReaderSlot,
  type CurrentSnapshotModule,
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

/** Explicit legacy SDK compatibility; ordinary runtime owners prepare asynchronously. */
export function loadLegacyPluginMetadataSnapshotRuntime(
  params: Parameters<
    typeof import("./plugin-metadata-readers.runtime.js").loadLegacyPluginMetadataSnapshot
  >[0],
) {
  const current = getCurrentPluginMetadataSnapshotRequiredRuntime({
    config: params.config,
    env: params.env,
    workspaceDir: params.workspaceDir,
    allowWorkspaceScopedSnapshot: true,
    allowSynchronousPolicyRead: false,
    ...(params.config === undefined ? { requireDefaultDiscoveryContext: true } : {}),
  });
  if (current) {
    return current;
  }
  const reader =
    snapshotReaderSlot.loadLegacyPluginMetadataSnapshot ??
    loadRequiredSnapshotReaders().loadLegacyPluginMetadataSnapshot;
  return reader(params);
}
