import { loadBundledPluginPublicArtifactModuleFromCandidatesSync } from "../../plugins/public-surface-loader.js";

// Missing artifacts are optional; errors from resolved artifacts must propagate.
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Callers supply the artifact's own public module surface type.
export function loadOptionalBundledChannelPublicArtifact<T extends object = object>(params: {
  channelId: string;
  artifactBasename: string;
}): T | undefined {
  return (
    loadBundledPluginPublicArtifactModuleFromCandidatesSync<T>({
      dirName: params.channelId.trim(),
      artifactCandidates: [params.artifactBasename],
    }) ?? undefined
  );
}
