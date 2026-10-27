import type { ExpectedWorkerBuild } from "../../worker/worker-build-identity.js";
import type { TransferArtifact } from "./artifact-transfer-service.js";

export type WorkerBundleArtifact = ExpectedWorkerBuild & {
  install: "bundle";
  tarballBytes: number;
  tarballSha256: string;
  tarballPath: string;
};

export type WorkerBundleBuildOptions = {
  packageRoot: string;
  cacheDir: string;
  openclawVersion: string;
  protocolFeatures: string[];
};

export type NodeBootstrapArtifact = Readonly<{
  tarballPath: string;
  tarballSha256: string;
  tarballBytes: number;
  openclawVersion: string;
  buildId: string;
  enabledPluginIds: readonly string[];
  installLock?: TransferArtifact;
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
