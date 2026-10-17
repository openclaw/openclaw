import type { WorkerBundleArtifact, WorkerBundleBuildOptions } from "./bundle.js";

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

export type NodeBootstrapArtifactWorkerTasks = {
  bootstrap: {
    input: { options: NodeBootstrapArtifactOptions; temporaryRoot: string };
    output: NodeBootstrapArtifact;
  };
  bundle: {
    input: WorkerBundleBuildOptions;
    output: WorkerBundleArtifact;
  };
};

export type NodeBootstrapArtifactWorkerInput = {
  [Kind in keyof NodeBootstrapArtifactWorkerTasks]: {
    kind: Kind;
    input: NodeBootstrapArtifactWorkerTasks[Kind]["input"];
  };
}[keyof NodeBootstrapArtifactWorkerTasks];
