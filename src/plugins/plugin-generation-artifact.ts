import path from "node:path";
import {
  capturePluginGenerationArtifactInScope,
  createPluginGenerationArtifactSteps,
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

/** Cooperative reconstruction is only used with an already retained worker capture. */
export function* capturePreparedPluginGenerationArtifactSteps(
  ...args: Parameters<typeof createPluginGenerationArtifactSteps>
): Generator<void, PluginGenerationArtifact, void> {
  if (!args[6]) {
    throw new Error("Prepared capture requires source custody");
  }
  const state = nativeAdmissionStateFor();
  const publisher =
    state.owners.has(path.resolve(args[0])) && !state.artifactPreservingReadOnly
      ? createPluginSourceAdmissionPublisher({ stateDir: state.publicationStateDir })
      : undefined;
  const steps = createPluginGenerationArtifactSteps(...args);
  let step = withPluginSourceAdmissionPublisher(publisher, () => steps.next());
  while (!step.done) {
    try {
      yield;
    } catch (error) {
      step = withPluginSourceAdmissionPublisher(publisher, () => steps.throw(error));
      continue;
    }
    step = withPluginSourceAdmissionPublisher(publisher, () => steps.next());
  }
  return step.value;
}
