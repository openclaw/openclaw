import { snapshotOwners } from "./plugin-native-admission-state.js";
import {
  retainPluginNativeRoot,
  snapshotPluginNativeRootLease,
  type PluginNativeCaptureRoot,
} from "./plugin-native-root-lease.js";

/** Host leases retain the capture owner; execution workers only borrow paths. */
export function createPluginGenerationNativeRoots() {
  const roots = new Map<
    number,
    {
      root: PluginNativeCaptureRoot;
      custody: ReturnType<typeof retainPluginNativeRoot>;
    }
  >();
  let nextId = 0;
  let closed = false;
  return {
    allocate(root: PluginNativeCaptureRoot) {
      if (closed) {
        throw new Error("Plugin native preparation custody has closed");
      }
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
