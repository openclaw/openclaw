import type { PluginSourceCaptureStorage } from "./plugin-instance-invocation.types.js";
import { snapshotOwners, type AdmissionState } from "./plugin-native-admission-state.js";
import { retainPluginNativeRoot } from "./plugin-native-root-lease.js";
import type { PluginSourceAdmissionPublication } from "./plugin-source-admission.types.js";
import { createPluginNativeCaptureRoot } from "./plugin-source-capture-directory.js";

/** Filesystem custody stays in the host; preparation workers only borrow paths. */
export function createPluginGenerationNativeRoots(
  storage: PluginSourceCaptureStorage,
  admission: AdmissionState,
) {
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
    async publish(
      publication: PluginSourceAdmissionPublication,
      publish: (publication: PluginSourceAdmissionPublication) => Promise<boolean>,
    ) {
      if (closed) {
        return false;
      }
      const directories = new Set(Object.keys(publication.receipt.nativeNamespaces));
      const selected = new Map(
        [...admission.roots, ...[...roots.values()].map(({ root }) => root)]
          .filter((root) => directories.has(root.directory))
          .map((root) => [root.directory, root]),
      );
      // A worker can exit while its receipt write is pending. Publication keeps
      // independent custody and commits it before acknowledging durable acceptance.
      const leases = [...selected.values()].map(retainPluginNativeRoot);
      try {
        const accepted = await publish(publication);
        if (accepted) {
          for (const root of leases) {
            root.commit();
          }
        }
        return accepted;
      } finally {
        await Promise.all(leases.map((root) => root.disposeAsync()));
      }
    },
    async close() {
      closed = true;
      await Promise.all([...roots.values()].map(({ custody }) => custody.disposeAsync()));
      roots.clear();
    },
  };
}
