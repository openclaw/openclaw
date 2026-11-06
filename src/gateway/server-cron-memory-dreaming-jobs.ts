import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { DEFAULT_MEMORY_DREAMING_PLUGIN_ID } from "../memory-host-sdk/dreaming.js";
import { createPluginActivationSource, normalizePluginsConfig } from "../plugins/config-state.js";
import { resolveAuthorizedDreamingSidecar } from "../plugins/loader-shared.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { hasKind } from "../plugins/slots.js";
import type { GatewayCronServiceContract } from "./server-cron-contract.js";

export async function reconcileOrphanedMemoryDreamingJobs(params: {
  cron: Pick<GatewayCronServiceContract, "list" | "remove">;
  cfg: OpenClawConfig;
  logger: { warn: (message: string) => void };
  isCurrent: () => boolean;
  manifestRegistry: PluginManifestRegistry | undefined;
}): Promise<void> {
  const normalized = normalizePluginsConfig(params.cfg.plugins);
  const memorySlot = normalizeLowercaseStringOrEmpty(normalized.slots.memory);
  if (!memorySlot || memorySlot === "none" || memorySlot === DEFAULT_MEMORY_DREAMING_PLUGIN_ID) {
    return;
  }
  const { manifestRegistry } = params;
  if (!manifestRegistry) {
    return;
  }
  const owner = manifestRegistry.plugins.find((plugin) => plugin.id === memorySlot);
  if (
    (owner && !hasKind(owner.kind, "memory")) ||
    resolveAuthorizedDreamingSidecar({
      cfg: params.cfg,
      normalized,
      activationSource: createPluginActivationSource({ config: params.cfg, plugins: normalized }),
      manifestRegistry,
      memorySlot,
    }) !== null ||
    !params.isCurrent()
  ) {
    return;
  }
  let jobs: Awaited<ReturnType<typeof params.cron.list>>;
  try {
    jobs = await params.cron.list({ includeDisabled: true });
  } catch (error) {
    if (params.isCurrent()) {
      params.logger.warn(`Dreaming job inventory failed: ${formatErrorMessage(error)}`);
    }
    return;
  }
  const commitGuard = () => {
    if (!params.isCurrent()) {
      throw new DOMException("Dreaming cleanup superseded", "AbortError");
    }
  };
  for (const job of jobs) {
    // Match memory-core's disabled branch; historical and authored look-alikes are not ours.
    if (job.declarationKey !== "memory-core:memory-dreaming-promotion") {
      continue;
    }
    if (!params.isCurrent()) {
      return;
    }
    try {
      await params.cron.remove(job.id, { commitGuard });
    } catch (error) {
      if (!params.isCurrent()) {
        return;
      }
      params.logger.warn(`Dreaming job ${job.id} cleanup failed: ${formatErrorMessage(error)}`);
    }
  }
}
