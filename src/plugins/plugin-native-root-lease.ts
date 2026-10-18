import { snapshotOwners } from "./plugin-native-admission-state.js";
import type { createPluginNativeCaptureRoot } from "./plugin-source-capture-directory.js";

/** A transferred root holds independent custody until its receiving owner releases it. */
export function retainPluginNativeRoot(root: ReturnType<typeof createPluginNativeCaptureRoot>) {
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
  return {
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
}
