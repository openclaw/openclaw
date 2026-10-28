import type { PluginSourceCustodyFork } from "./plugin-generation-source-lookup.js";
import type { PluginModuleCapture } from "./plugin-package-metadata-capture.js";

/** Captured source custody and module lookup operations owned by one generation. */
export type PluginGenerationArtifact = {
  sourceRoot: string;
  rootDir: string;
  boundaryRoot: string;
  sourceAliases: Record<string, string>;
  sourceDigest: string;
  linkHost: (hostRoot: string) => void;
  hasSource: (source: string) => boolean;
  resolve: (source: string, rejectHardlinks?: boolean) => string;
  captureRecoverySource: () => PluginSourceCustodyFork["source"];
  retainSourceCustody: () => PluginSourceCustodyFork;
  sourceForCaptured: (file: string) => string | undefined;
  moduleFacts: (importer: string) => Readonly<PluginModuleCapture> | undefined;
  moduleRoot: (filename: string) => string | undefined;
  assertModuleAvailable: (filename: string) => void;
  prepareModule: (filename: string) => string[];
  prepareDependency: (importer: string, specifier: string) => string[];
  prepareNativeScopes: (importer?: string) => { value: void; additions: string[] } | undefined;
  prepareNativeModule: (importer: string, specifier: string) => boolean;
  captureModule: (
    importer: string,
    specifier: string,
    conditions: readonly string[],
  ) => (({ target: URL } | { retryNative: true }) & { additions: string[] }) | undefined;
  captureResolvedModule: (filename: string) => string | undefined;
  dispose: () => void;
  disposeAsync: () => Promise<void>;
};
