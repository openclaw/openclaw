import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "./config/types.openclaw.js";
import type { NodeBootstrapArtifactOptions } from "./gateway/worker-environments/node-bootstrap-artifact-contract.js";
import type { NodeBootstrapPluginSelection } from "./gateway/worker-environments/node-bootstrap-plugins.js";
export { resolveNodeBootstrapPlugins } from "./gateway/worker-environments/node-bootstrap-plugins.js";
export type { NodeBootstrapPluginSelection } from "./gateway/worker-environments/node-bootstrap-plugins.js";
export { workerBundleArchiveRelativePath } from "./shared/worker-bundle-hash.js";

/** Inspect this installation's bundled generation without activating a Gateway or reading operator state. */
export async function qualifyWorkerRuntimePlugins(options: {
  packageRoot: string;
  config: OpenClawConfig;
  signal?: AbortSignal;
}): Promise<NodeBootstrapPluginSelection> {
  options.signal?.throwIfAborted();
  const packageRoot = await fs.realpath(options.packageRoot);
  const [
    { discoverOpenClawPlugins },
    { loadPluginManifestRegistryCore },
    { acquirePluginRegistryForInspection },
  ] = await Promise.all([
    import("./plugins/discovery.js"),
    import("./plugins/manifest-registry.js"),
    import("./plugins/loader-runtime-load.js"),
  ]);
  options.signal?.throwIfAborted();
  const installRecords = {};
  const discovery = discoverOpenClawPlugins({
    bundledRoot: path.join(packageRoot, "extensions"),
    rootScope: "bundled",
    installRecords,
  });
  const manifestRegistry = loadPluginManifestRegistryCore({
    config: options.config,
    discovery,
    installRecords,
  });
  const inspection = await acquirePluginRegistryForInspection({
    config: options.config,
    discovery,
    manifestRegistry,
    installRecords,
    mode: "full",
    runtimeSideEffects: false,
    allowProcessHomeSessionCatalogs: false,
    preferBuiltPluginArtifacts: true,
    throwOnLoadError: true,
  });
  try {
    options.signal?.throwIfAborted();
    const registry = inspection.registry;
    return {
      executionMode: "remote-exec",
      registry: {
        plugins: registry.plugins.map(
          ({ id, enabled, status, rootDir, packageName, packageVersion }) => ({
            id,
            enabled,
            status,
            rootDir,
            packageName,
            packageVersion,
          }),
        ),
        agentHarnesses: registry.agentHarnesses.map(({ pluginId, harness }) => ({
          pluginId,
          harness: { cloudPlacement: harness.cloudPlacement },
        })),
        nodeHostCommands: registry.nodeHostCommands.map(({ pluginId, command }) => ({
          pluginId,
          command: { command: command.command },
        })),
      },
      metadata: {
        byPluginId: new Map(
          manifestRegistry.plugins.map(
            ({ id, origin, trustedOfficialInstall, rootDir, packageName, packageVersion }) => [
              id,
              { origin, trustedOfficialInstall, rootDir, packageName, packageVersion },
            ],
          ),
        ),
      },
    };
  } finally {
    await inspection.release();
  }
}

export type WorkerRuntimeArtifactExportOptions = NodeBootstrapArtifactOptions & {
  /** New caller-owned directory outside the immutable installed package. */
  outputDirectory: string;
  signal?: AbortSignal;
};

/** Offline packaging only; the canonical producers never enroll a node or read session state. */
export async function prepareWorkerRuntimeArtifacts(options: WorkerRuntimeArtifactExportOptions) {
  options.signal?.throwIfAborted();
  const packageRoot = await fs.realpath(options.packageRoot);
  const requestedOutput = path.resolve(options.outputDirectory);
  const outputDirectory = path.join(
    await fs.realpath(path.dirname(requestedOutput)),
    path.basename(requestedOutput),
  );
  const relative = path.relative(packageRoot, outputDirectory);
  if (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  ) {
    throw new Error("Runtime artifact output must be outside the installed package");
  }
  await fs.mkdir(outputDirectory, { mode: 0o700 });
  const original = await fs.stat(outputDirectory);
  const assertDirectoryCurrent = async () => {
    const current = await fs.lstat(outputDirectory);
    if (!current.isDirectory() || current.dev !== original.dev || current.ino !== original.ino) {
      throw new Error("Runtime artifact output directory was replaced");
    }
  };
  try {
    const [{ prepareNodeBootstrapArtifactInWorker }, { createWorkerBundleProducer }] =
      await Promise.all([
        import("./gateway/worker-environments/node-bootstrap-artifact-worker.js"),
        import("./gateway/worker-environments/bundle.js"),
      ]);
    options.signal?.throwIfAborted();
    await assertDirectoryCurrent();
    const nodeRoot = path.join(outputDirectory, "node-bootstrap");
    await fs.mkdir(nodeRoot, { mode: 0o700 });
    // Both producers must join, including a sibling failure, before publication or cleanup.
    const results = await Promise.allSettled([
      prepareNodeBootstrapArtifactInWorker(
        {
          packageRoot,
          runningBuildId: options.runningBuildId,
          plugins: options.plugins,
        },
        nodeRoot,
      ),
      createWorkerBundleProducer({
        packageRoot,
        cacheDir: path.join(outputDirectory, "worker-bundle"),
      }).prepare(),
    ]);
    await assertDirectoryCurrent();
    options.signal?.throwIfAborted();
    const [node, worker] = results;
    if (node.status === "rejected") {
      throw node.reason;
    }
    if (worker.status === "rejected") {
      throw worker.reason;
    }
    if (node.value.openclawVersion !== worker.value.openclawVersion) {
      throw new Error("Node bootstrap and worker bundle package versions differ");
    }
    return Object.freeze({
      schema: "openclaw.worker-runtime-artifacts.v1" as const,
      platform: process.platform,
      arch: process.arch,
      nodeBootstrap: node.value,
      workerBundle: Object.freeze(worker.value),
    });
  } catch (error) {
    await assertDirectoryCurrent();
    await fs.rm(outputDirectory, { recursive: true });
    throw error;
  }
}
