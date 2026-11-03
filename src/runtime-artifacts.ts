import fs from "node:fs/promises";
import path from "node:path";
import { cloneConfigWithResolutionFacts } from "./config/resolution-facts.js";
import { captureRuntimeConfigWithSource } from "./config/runtime-config-capture-state.js";
import type { OpenClawConfig } from "./config/types.openclaw.js";
import type { NodeBootstrapArtifactOptions } from "./gateway/worker-environments/node-bootstrap-artifact-contract.js";
import type { NodeBootstrapPluginSelection } from "./gateway/worker-environments/node-bootstrap-plugins.js";
import { sha256File } from "./infra/directory-durability.js";

export { resolveNodeBootstrapPlugins } from "./gateway/worker-environments/node-bootstrap-plugins.js";
export type { NodeBootstrapPluginSelection } from "./gateway/worker-environments/node-bootstrap-plugins.js";
export { workerBundleArchiveRelativePath } from "./shared/worker-bundle-hash.js";

/** Qualify only this installed bundled generation, without publishing a Gateway registry. */
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
    { acquirePluginRegistryWithInternalOverrides },
    { resolveBundledDirFromPackageRoot },
  ] = await Promise.all([
    import("./plugins/discovery.js"),
    import("./plugins/manifest-registry.js"),
    import("./plugins/loader-runtime-load.js"),
    import("./plugins/bundled-dir.js"),
  ]);
  options.signal?.throwIfAborted();
  const config = captureRuntimeConfigWithSource(options.config, options.config);
  const installRecords = {};
  const discovery = discoverOpenClawPlugins({
    bundledRoot:
      resolveBundledDirFromPackageRoot(packageRoot) ?? path.join(packageRoot, "extensions"),
    rootScope: "bundled",
    installRecords,
  });
  const manifestRegistry = loadPluginManifestRegistryCore({
    config,
    discovery,
    installRecords,
  });
  const refuseConfigMutation = async () => {
    throw new Error("Offline runtime qualification cannot mutate config");
  };
  const inspection = await acquirePluginRegistryWithInternalOverrides(
    {
      config,
      cache: false,
      activate: false,
      discovery,
      manifestRegistry,
      installRecords,
      mode: "full",
      runtimeSideEffects: false,
      allowProcessHomeSessionCatalogs: false,
      preferBuiltPluginArtifacts: true,
      throwOnLoadError: true,
    },
    {
      moduleLoader: {},
      runtime: {
        config: {
          current: (readOptions?: { clone: true }) =>
            readOptions?.clone ? cloneConfigWithResolutionFacts(config) : config,
          mutateConfigFile: refuseConfigMutation,
          replaceConfigFile: refuseConfigMutation,
        },
      },
    },
  );
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

export type WorkerRuntimeArtifactExportOptions = Omit<NodeBootstrapArtifactOptions, "install"> & {
  outputDirectory: string;
  signal?: AbortSignal;
};

/** Export the canonical node and worker bytes; installation and enrollment remain provider-owned. */
export async function prepareWorkerRuntimeArtifacts(options: WorkerRuntimeArtifactExportOptions) {
  options.signal?.throwIfAborted();
  const packageRoot = await fs.realpath(options.packageRoot);
  const requested = path.resolve(options.outputDirectory);
  const outputDirectory = path.join(
    await fs.realpath(path.dirname(requested)),
    path.basename(requested),
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
    const [{ prepareNodeArtifactInWorker }, { createWorkerBundleProducer }] = await Promise.all([
      import("./gateway/worker-environments/node-bootstrap-artifact-worker.js"),
      import("./gateway/worker-environments/bundle.js"),
    ]);
    options.signal?.throwIfAborted();
    await assertDirectoryCurrent();
    const nodeRoot = path.join(outputDirectory, "node-bootstrap");
    await fs.mkdir(nodeRoot, { mode: 0o700 });
    // Join both producers before returning or removing their shared owned output.
    const [node, worker] = await Promise.allSettled([
      prepareNodeArtifactInWorker("bootstrap", {
        options: {
          packageRoot,
          install: "bundle",
          runningBuildId: options.runningBuildId,
          plugins: options.plugins,
        },
        temporaryRoot: nodeRoot,
      }),
      createWorkerBundleProducer({
        packageRoot,
        cacheDir: path.join(outputDirectory, "worker-bundle"),
      }).prepare(),
    ]);
    await assertDirectoryCurrent();
    options.signal?.throwIfAborted();
    if (node.status === "rejected") {
      throw node.reason;
    }
    if (worker.status === "rejected") {
      throw worker.reason;
    }
    if (node.value.openclawVersion !== worker.value.openclawVersion) {
      throw new Error("Node bootstrap and worker bundle package versions differ");
    }
    const workerPath = path.join(
      outputDirectory,
      "worker-bundle",
      `${worker.value.bundleHash}.tgz`,
    );
    // Packaged installations retain the source archive inside the immutable package.
    // Export those bytes too so the output remains a complete offline transfer.
    if (worker.value.tarballPath !== workerPath) {
      await fs.mkdir(path.dirname(workerPath), { mode: 0o700, recursive: true });
      await fs.copyFile(worker.value.tarballPath, workerPath, fs.constants.COPYFILE_EXCL);
      if (
        (await fs.stat(workerPath)).size !== worker.value.tarballBytes ||
        (await sha256File(workerPath)).digest !== worker.value.tarballSha256
      ) {
        throw new Error("Exported worker archive differs from its producer receipt");
      }
    }
    return Object.freeze({
      schema: "openclaw.worker-runtime-artifacts.v1" as const,
      platform: process.platform,
      arch: process.arch,
      nodeBootstrap: node.value,
      workerBundle: Object.freeze({ ...worker.value, tarballPath: workerPath }),
    });
  } catch (error) {
    await assertDirectoryCurrent();
    await fs.rm(outputDirectory, { recursive: true });
    throw error;
  }
}
