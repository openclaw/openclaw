import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CodeModeExecutor } from "../agents/code-mode-executor-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig } from "./config-state.js";
import {
  hasManifestContractValue,
  isManifestPluginAvailableForControlPlane,
  loadManifestMetadataSnapshot,
} from "./manifest-contract-eligibility.js";
import { passesManifestOwnerBasePolicy } from "./manifest-owner-policy.js";
import { loadValidatedPublicSurfaceModule } from "./public-surface-loader.js";
import { resolvePluginRootPublicSurfacePath } from "./public-surface-runtime.js";

/** Explicit executor selection activates only its admitted manifest owner. */
export function resolvePluginCodeModeExecutor(
  executorId: CodeModeExecutor["id"],
  config?: OpenClawConfig,
): CodeModeExecutor {
  const snapshot = loadManifestMetadataSnapshot({ config });
  const normalizedConfig = normalizePluginsConfig(config?.plugins);
  const owners = snapshot.plugins.filter(
    (plugin) =>
      hasManifestContractValue({ plugin, contract: "codeModeExecutors", value: executorId }) &&
      isManifestPluginAvailableForControlPlane({
        snapshot,
        plugin,
        config,
        normalizedConfig,
        // A selected bundled executor replaces a core runtime and keeps its availability.
        allowRestrictiveAllowlistBypass: plugin.origin === "bundled",
      }) &&
      (plugin.origin === "bundled" || passesManifestOwnerBasePolicy({ plugin, normalizedConfig })),
  );
  const [owner, ...otherOwners] = owners;
  if (!owner || otherOwners.length > 0) {
    throw new Error(
      !owner
        ? `Code Mode executor "${executorId}" is unavailable or disabled. Enable its plugin or select another executor.`
        : `Code Mode executor "${executorId}" has multiple plugin owners: ${owners.map((candidate) => candidate.id).join(", ")}. Enable only one owner.`,
    );
  }
  const modulePath = resolvePluginRootPublicSurfacePath({
    pluginRoot: owner.rootDir,
    pluginId: owner.id,
    entrySource: owner.source,
    artifactBasename: "code-mode-executor-api.js",
  });
  if (!modulePath) {
    throw new Error(
      `Code Mode executor "${executorId}" plugin "${owner.id}" is missing its runtime artifact.`,
    );
  }
  const module = loadValidatedPublicSurfaceModule({
    modulePath,
    boundaryRoot: owner.rootDir,
    surfaceLabel: "Code Mode executor",
    origin: owner.origin,
    pluginId: owner.id,
  });
  const executor: unknown = "codeModeExecutor" in module ? module.codeModeExecutor : undefined;
  if (!isRecord(executor) || executor.id !== executorId || typeof executor.execute !== "function") {
    throw new Error(
      `Code Mode executor "${executorId}" plugin "${owner.id}" has an invalid runtime artifact.`,
    );
  }
  // SAFETY: Admitted native artifacts implement the SDK contract; the selected id and callable entry are checked above.
  return executor as CodeModeExecutor;
}
