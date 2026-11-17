import { snapshotOwners } from "./plugin-native-admission-state.js";
import { retainPluginNativeRoot } from "./plugin-native-root-lease.js";
import type { PluginNativeCaptureRoot } from "./plugin-native-root.types.js";

/** Filesystem custody stays in the host; preparation workers only borrow paths. */
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
    async close() {
      closed = true;
      await Promise.all([...roots.values()].map(({ custody }) => custody.disposeAsync()));
      roots.clear();
    },
  };
}
