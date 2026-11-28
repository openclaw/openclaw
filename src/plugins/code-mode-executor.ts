import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CodeModeExecutor } from "../agents/code-mode-executor-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig } from "./config-state.js";
import {
  hasManifestContractValue,
  isManifestPluginAvailableForControlPlane,
  isManifestPluginOwnerAllowedByControlPlanePolicy,
  loadManifestMetadataSnapshot,
} from "./manifest-contract-eligibility.js";
import { passesManifestOwnerBasePolicy } from "./manifest-owner-policy.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import { loadValidatedPublicSurfaceModule } from "./public-surface-loader.js";
import { resolvePluginRootPublicSurfaceLocation } from "./public-surface-runtime.js";
import {
  WORKER_DEPLOY_BUNDLED_CODE_MODE_EXECUTOR_PLUGIN_IDS,
  workerDeployCodeModeExecutors,
  type WorkerDeployCodeModeExecutorOwner,
} from "./worker-deploy-code-mode-executors.js";

type CodeModeExecutorCandidate =
  | {
      kind: "manifest";
      plugin: ReturnType<typeof loadManifestMetadataSnapshot>["plugins"][number];
    }
  | {
      kind: "composed";
      plugin: WorkerDeployCodeModeExecutorOwner["manifest"];
      executor: CodeModeExecutor;
    };

function selectPluginCodeModeExecutorOwner(
  executorId: CodeModeExecutor["id"],
  config?: OpenClawConfig,
  preparedMetadata?: PluginMetadataSnapshot,
): CodeModeExecutorCandidate {
  const normalizedConfig = normalizePluginsConfig(config?.plugins);
  // The sealed archive runs the same bundled owner admitted by the Gateway, even if host plugins are discoverable.
  const snapshot = workerDeployCodeModeExecutors.length
    ? undefined
    : (preparedMetadata ?? loadManifestMetadataSnapshot({ config }));
  const candidates: CodeModeExecutorCandidate[] = snapshot
    ? snapshot.plugins.map((plugin) => ({ kind: "manifest", plugin }))
    : workerDeployCodeModeExecutors.map(({ manifest, executor }) => ({
        kind: "composed",
        plugin: manifest,
        executor,
      }));
  const owners = candidates.filter(({ plugin }) => {
    if (!hasManifestContractValue({ plugin, contract: "codeModeExecutors", value: executorId })) {
      return false;
    }
    const policy = { plugin, config, normalizedConfig };
    return plugin.origin === "bundled"
      ? isManifestPluginOwnerAllowedByControlPlanePolicy({
          ...policy,
          // A selected bundled executor replaces a core runtime and keeps its availability.
          allowRestrictiveAllowlistBypass: true,
        })
      : snapshot !== undefined &&
          isManifestPluginAvailableForControlPlane({ snapshot, ...policy }) &&
          passesManifestOwnerBasePolicy(policy);
  });
  const [owner, ...otherOwners] = owners;
  if (!owner || otherOwners.length > 0) {
    throw new Error(
      !owner
        ? `Code Mode executor "${executorId}" is unavailable or disabled. Enable its plugin or select another executor.`
        : `Code Mode executor "${executorId}" has multiple plugin owners: ${owners.map(({ plugin }) => plugin.id).join(", ")}. Enable only one owner.`,
    );
  }
  return owner;
}

/**
 * Validates that a selected Code Mode executor resolves to a bundled owner composed
 * into portable worker bundles, refusing denied/disabled owners and external host plugins.
 */
export function assertWorkerPluginCodeModeExecutorAllowed(
  executorId: CodeModeExecutor["id"],
  config?: OpenClawConfig,
  metadataSnapshot?: PluginMetadataSnapshot,
): void {
  const owner = selectPluginCodeModeExecutorOwner(executorId, config, metadataSnapshot);
  if (
    owner.plugin.origin !== "bundled" ||
    !WORKER_DEPLOY_BUNDLED_CODE_MODE_EXECUTOR_PLUGIN_IDS.has(owner.plugin.id)
  ) {
    throw new Error(
      `Code Mode executor "${executorId}" is provided by plugin "${owner.plugin.id}", ` +
        "which is unavailable in portable workers. Enable the bundled owner, select another executor, or run locally.",
    );
  }
}

/** Explicit executor selection activates only its admitted manifest owner. */
export function resolvePluginCodeModeExecutor(
  executorId: CodeModeExecutor["id"],
  config?: OpenClawConfig,
): CodeModeExecutor {
  const owner = selectPluginCodeModeExecutorOwner(executorId, config);
  let executor: unknown;
  if (owner.kind === "composed") {
    executor = owner.executor;
  } else {
    const location = resolvePluginRootPublicSurfaceLocation({
      pluginRoot: owner.plugin.rootDir,
      pluginId: owner.plugin.id,
      entrySource: owner.plugin.source,
      artifactBasename: "code-mode-executor-api.js",
    });
    if (!location) {
      throw new Error(
        `Code Mode executor "${executorId}" plugin "${owner.plugin.id}" is missing its runtime artifact.`,
      );
    }
    const module = loadValidatedPublicSurfaceModule({
      ...location,
      surfaceLabel: "Code Mode executor",
      origin: owner.plugin.origin,
      pluginId: owner.plugin.id,
    });
    executor = "codeModeExecutor" in module ? module.codeModeExecutor : undefined;
  }
  if (!isRecord(executor) || executor.id !== executorId || typeof executor.execute !== "function") {
    throw new Error(
      `Code Mode executor "${executorId}" plugin "${owner.plugin.id}" has an invalid runtime artifact.`,
    );
  }
  // SAFETY: Admitted native artifacts implement the SDK contract; the selected id and callable entry are checked above.
  return executor as CodeModeExecutor;
}
