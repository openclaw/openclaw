import type {
  PluginNativeArtifactFact,
  PluginNativeNamespaceFact,
} from "./plugin-source-admission.types.js";

export type PluginDependencyResolution = { root: string; lookupDirectory: string };
export type PluginGenerationReceipt = { signature: string; sourceDigest: string };
export type PluginPackageCaptureState = "metadata" | "entry" | "body" | { error: unknown };
export type PluginSourceLinkCapture = {
  defer(filename: string, root: string, source?: string): boolean;
  contains(filename: string): boolean;
};
export type PluginNativeAdmissionCaptureState = {
  selected: Map<string, PluginNativeNamespaceFact>;
  priorNamespaces: Set<PluginNativeNamespaceFact>;
  files: Map<string, PluginNativeArtifactFact>;
  targets: Map<string, string>;
  hardlinkedTargets: Set<string>;
  pendingTargets: Set<string>;
  recoveredFiles: Map<string, PluginNativeArtifactFact>;
  hostRoot?: string;
  finalReceipt?: PluginGenerationReceipt;
};

export type PluginNativeDependencyScopeState = {
  source: string;
  dependencies: string[];
  prepared: boolean;
};
export type PluginPackageMetadataState = {
  scopes: Map<
    string,
    {
      source: string;
      manifest?: Record<string, unknown> | null;
      aliasesPrepared: boolean;
    }
  >;
  pending: Set<string>;
};
export type PluginPackageScope = {
  source: string;
  manifest: Record<string, unknown>;
  aliases: Set<string>;
};
export type CapturedModuleState = {
  source: string;
  scope?: PluginPackageScope;
  tsconfigPaths: boolean;
  observed: Map<string, string | null | undefined>;
  dependencies: Map<string, boolean>;
  staticImports?: ReadonlySet<string>;
};
export type CapturedPackageState = {
  entry?: string;
  executableEntry: boolean;
  links: Set<string>;
  state: PluginPackageCaptureState;
  missingTargets: Set<string>;
  sourceLinks: Set<string>;
  scopes: Map<string, string | undefined>;
  references: Map<string, Set<string>>;
  nativeScopes: Map<string, PluginNativeDependencyScopeState>;
  modules: Map<string, CapturedModuleState>;
};
/** Prepared facts cross isolates; acquisition and lazy execution use the same owners. */
export type PluginGenerationCaptureState = {
  sourceRoot: string;
  capturedRoot: string;
  sourceAliases: Record<string, string>;
  capturedPaths: Map<string, string>;
  originalSources: Map<string, string>;
  hardlinkedSources: Set<string>;
  packages: Map<string, CapturedPackageState>;
  dependencies: Map<string, PluginDependencyResolution | undefined>;
  metadata: PluginPackageMetadataState;
  native: PluginNativeAdmissionCaptureState;
  receipt: PluginGenerationReceipt;
};
