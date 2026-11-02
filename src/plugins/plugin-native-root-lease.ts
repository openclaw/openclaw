import { snapshotOwners } from "./plugin-native-admission-state.js";
import type { createPluginNativeCaptureRoot } from "./plugin-source-capture-directory.js";

type NativeRoot = ReturnType<typeof createPluginNativeCaptureRoot>;
const leases = new WeakMap<object, { root: NativeRoot; release(): void }>();

/** Only leases made by the custody owner may cross the preparation transport. */
export function snapshotPluginNativeRootLease(value: object) {
  return leases.get(value);
}

/** A transferred root holds independent custody until its receiving owner releases it. */
export function retainPluginNativeRoot(root: NativeRoot) {
  const owner = {};
  const owners = snapshotOwners.get(root)!;
  owners.add(owner);
  let released = false;
  const release = () => {
    if (released) {
      return false;
    }
    released = true;
    owners.delete(owner);
    return owners.size === 0;
  };
  const lease = {
    directory: root.directory,
    commit: () => root.commit(),
    dispose: () => {
      if (release()) {
        root.dispose();
      }
    },
    disposeAsync: async () => {
      if (release()) {
        await root.disposeAsync();
      }
    },
  };
  leases.set(lease, { root: leases.get(root)?.root ?? root, release: lease.dispose });
  return lease;
}
