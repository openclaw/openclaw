import type { PluginSourceCaptureStorage } from "./plugin-instance-invocation.types.js";
import type {
  PluginNativeArtifactFact,
  PluginNativeNamespaceFact,
} from "./plugin-source-admission.types.js";

export type PluginSourceCaptureDirectory = { directory: string; managedRoot?: string };

export type PluginRecoveryCopyInput = {
  rootDir: string;
  boundaryRoot: string;
  references?: ReadonlyMap<string, PluginNativeArtifactFact>;
  namespaces?: ReadonlyMap<string, PluginNativeNamespaceFact>;
};
export type PluginRecoveryCaptureInput = PluginRecoveryCopyInput & {
  storage: PluginSourceCaptureStorage;
  directory?: PluginSourceCaptureDirectory;
};
