import type { PluginSourceCaptureStorage } from "./plugin-instance-invocation.types.js";
import { snapshotOwners } from "./plugin-native-admission-state.js";
import {
  retainPluginNativeRoot,
  snapshotPluginNativeRootLease,
} from "./plugin-native-root-lease.js";
import { createPluginNativeCaptureRoot } from "./plugin-source-capture-directory.js";

/** Filesystem custody stays in the host; preparation workers only borrow paths. */
export function createPluginGenerationNativeRoots(storage: PluginSourceCaptureStorage) {
  const roots = new Map<
    number,
    {
      root: ReturnType<typeof createPluginNativeCaptureRoot>;
      custody: ReturnType<typeof retainPluginNativeRoot>;
    }
  >();
  let nextId = 0;
  let closed = false;
  return {
    allocate() {
      if (closed) {
        throw new Error("Plugin native preparation custody has closed");
      }
      const root = createPluginNativeCaptureRoot(storage.stateDir, storage.placement);
      snapshotOwners.set(root, new Set());
      const id = ++nextId;
      roots.set(id, { root, custody: retainPluginNativeRoot(root) });
      return { id, directory: root.directory };
    },
    retain(id: number) {
      const entry = roots.get(id);
      if (closed || !entry) {
        throw new Error("Unknown plugin native preparation root");
      }
      // The returned closures retain only filesystem custody, never this client.
      return retainPluginNativeRoot(entry.root);
    },
    retainByDirectory(directory: string) {
      if (closed) {
        return undefined;
      }
      const entry = [...roots.values()].find(({ root }) => root.directory === directory);
      return entry && retainPluginNativeRoot(entry.root);
    },
    adopt(custody: ReturnType<typeof retainPluginNativeRoot>) {
      const snapshot = snapshotPluginNativeRootLease(custody);
      if (closed || !snapshot) {
        custody.dispose();
        throw new Error("Plugin native preparation custody has closed");
      }
      const id = ++nextId;
      roots.set(id, { root: snapshot.root, custody });
      return { id, directory: snapshot.root.directory };
    },
    async close() {
      closed = true;
      await Promise.all([...roots.values()].map(({ custody }) => custody.disposeAsync()));
      roots.clear();
    },
  };
}
