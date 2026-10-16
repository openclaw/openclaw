export type NodeBootstrapArtifact = Readonly<{
  tarballPath: string;
  tarballSha256: string;
  tarballBytes: number;
  openclawVersion: string;
  buildId: string;
  enabledPluginIds: readonly string[];
}>;

export type NodeBootstrapArtifactOptions = {
  packageRoot: string;
  runningBuildId: string | null;
  plugins: readonly { id: string; root: string }[];
};

export type NodeBootstrapArtifactWorkerInput = {
  options: NodeBootstrapArtifactOptions;
  temporaryRoot: string;
};
