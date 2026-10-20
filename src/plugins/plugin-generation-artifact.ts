import path from "node:path";
import {
  capturePluginGenerationArtifactInScope,
  type PluginGenerationArtifact,
} from "./plugin-generation-capture.js";
import { nativeAdmissionStateFor } from "./plugin-native-admission-state.js";
import { withPluginSourceAdmissionPublisher } from "./plugin-source-admission-context.js";
import { createPluginSourceAdmissionPublisher } from "./plugin-source-admission-store.js";

export type { PluginGenerationArtifact } from "./plugin-generation-capture.js";

/** Host captures pin publication authority before source acquisition or later lazy imports. */
export function capturePluginGenerationArtifact(
  ...args: Parameters<typeof capturePluginGenerationArtifactInScope>
): PluginGenerationArtifact {
  const state = nativeAdmissionStateFor();
  const publisher =
    state.owners.has(path.resolve(args[0])) && !state.artifactPreservingReadOnly
      ? createPluginSourceAdmissionPublisher({ stateDir: state.publicationStateDir })
      : undefined;
  // Bind the custody seed and fork together; deferred materialization retains this
  // publisher in its admission owner after the synchronous scope has exited.
  return withPluginSourceAdmissionPublisher(publisher, () =>
    capturePluginGenerationArtifactInScope(...args),
  );
}
