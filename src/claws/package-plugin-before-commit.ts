import type { ClawPackage } from "./types.js";

export function bindClawPluginBeforeCommit(
  options: {
    assertPluginOwnerCurrent?: () => Promise<void>;
    onExternalMutation?: (pkg: ClawPackage) => void;
  },
  pkg: ClawPackage,
  assertForwardCurrent: () => void,
): () => Promise<void> {
  let ownerVerified = false;
  return async () => {
    // Later hooks may observe this install's own index write; the plugin lease excludes rivals.
    if (!ownerVerified && options.assertPluginOwnerCurrent) {
      await options.assertPluginOwnerCurrent();
    }
    assertForwardCurrent();
    ownerVerified = true;
    options.onExternalMutation?.(pkg);
  };
}
