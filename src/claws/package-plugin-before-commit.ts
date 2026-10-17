import type { ClawPackage } from "./types.js";

export function bindClawPluginBeforeCommit(
  options: {
    assertPluginOwnerCurrent?: () => Promise<void>;
    onExternalMutation?: (pkg: ClawPackage) => void;
  },
  pkg: ClawPackage,
  assertForwardCurrent: () => void,
): {
  beforePersistentApply: () => void;
  beforePersistentEffect: () => Promise<void>;
  artifactReviewed: () => void;
} {
  let ownerVerified = false;
  let reviewComplete = false;
  let mutationReported = false;
  return {
    artifactReviewed: () => {
      reviewComplete = true;
    },
    beforePersistentApply: () => {
      assertForwardCurrent();
      // The final staged review may still reject. Report mutation at the first
      // package-directory write check, after that review has passed.
      if (reviewComplete && ownerVerified && !mutationReported) {
        mutationReported = true;
        options.onExternalMutation?.(pkg);
      }
    },
    beforePersistentEffect: async () => {
      // Later hooks may observe this install's own index write; the plugin lease excludes rivals.
      if (!ownerVerified && options.assertPluginOwnerCurrent) {
        await options.assertPluginOwnerCurrent();
      }
      assertForwardCurrent();
      ownerVerified = true;
    },
  };
}
