import type { PluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { disposePluginSnapshotModuleFacade } from "./plugin-snapshot-module-facade.js";
import {
  buildPluginTypeScriptSource,
  type PluginSourceFile,
  type PluginSourceLoadMode,
} from "./plugin-source-build.js";

export type SourceBuilds = Map<string, ReturnType<typeof buildPluginTypeScriptSource>>;

export function createSourceOutputLookup(builds: SourceBuilds) {
  const sourceForOutput = (filename: string): PluginSourceFile => {
    for (const build of builds.values()) {
      const source = build.sourceForOutput(filename);
      if (source) {
        return source;
      }
    }
    return { source: filename };
  };
  return {
    sourceForOutput,
    moduleSource: (filename: string) => {
      const entry = sourceForOutput(filename);
      return entry.generated ? filename : entry.source;
    },
  };
}

export function disposeModuleSources(builds: SourceBuilds, artifact?: PluginGenerationArtifact) {
  for (const build of builds.values()) {
    build.dispose();
  }
  builds.clear();
  if (artifact) {
    disposePluginSnapshotModuleFacade(artifact);
  }
  return artifact?.disposeAsync();
}

export function createPluginInstanceSourceBuilder(
  artifact: PluginGenerationArtifact,
  sourceBuilds: SourceBuilds,
  execute: <T>(run: () => T) => T,
) {
  return (filename: string, mode?: PluginSourceLoadMode, nativeFormat?: string | null) => {
    const root = artifact.moduleRoot(filename);
    if (!root) {
      return filename;
    }
    return execute(() => {
      let build = sourceBuilds.get(root);
      if (!build) {
        build = buildPluginTypeScriptSource(root);
        sourceBuilds.set(root, build);
      }
      return build.resolve(filename, mode, nativeFormat);
    });
  };
}
