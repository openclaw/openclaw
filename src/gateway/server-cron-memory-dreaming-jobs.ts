// Removes memory-core's managed dreaming cron job while memory-core is not loaded to own it.
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronJob } from "../cron/types.js";
import {
  DEFAULT_MEMORY_DREAMING_PLUGIN_ID,
  MANAGED_MEMORY_DREAMING_CRON_DECLARATION_KEY,
} from "../memory-host-sdk/dreaming.js";
import { createPluginActivationSource, normalizePluginsConfig } from "../plugins/config-state.js";
import { resolveAuthorizedDreamingSidecar } from "../plugins/loader-shared.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import type { GatewayCronServiceContract } from "./server-cron-contract.js";

type MemoryDreamingJobCron = Pick<GatewayCronServiceContract, "list" | "remove">;

// Only the canonical declaration, exactly what memory-core's own disabled
// branch removes (extensions/memory-core/src/dreaming-cron.ts). Historical,
// legacy and ambiguous dreaming rows stay untouched: repairing them is
// Doctor's job (openclaw doctor --fix), not runtime reconciliation's.
function isManagedMemoryCoreDreamingJob(job: CronJob): boolean {
  return (
    normalizeOptionalString(job.declarationKey) === MANAGED_MEMORY_DREAMING_CRON_DECLARATION_KEY
  );
}

function activeManifestRegistry(): PluginManifestRegistry | undefined {
  const registry = getActivePluginRegistry();
  return registry ? getPluginRuntimeLoadContext(registry)?.manifestRegistry : undefined;
}

/**
 * Whether memory-core's dreaming jobs are orphaned: another plugin owns the
 * memory slot and the loader does not admit memory-core as the dreaming
 * sidecar, so memory-core is not loaded and its own disabled-branch cleanup can
 * never run. Admission is the loader's own decision (dreaming flag, plugins
 * disabled, memory-core denied or disabled, slot owner inactive), not the
 * dreaming flag alone. Without a manifest registry the answer is unknown, and
 * nothing is removed.
 */
function isMemoryCoreDreamingOrphaned(
  cfg: OpenClawConfig,
  manifestRegistry: PluginManifestRegistry | undefined,
): boolean {
  const normalized = normalizePluginsConfig(cfg.plugins);
  const memorySlot = normalized.slots.memory;
  const normalizedSlot = normalizeLowercaseStringOrEmpty(memorySlot);
  if (!normalizedSlot || normalizedSlot === DEFAULT_MEMORY_DREAMING_PLUGIN_ID) {
    // memory-core owns the slot and reconciles its own jobs.
    return false;
  }
  if (!manifestRegistry) {
    return false;
  }
  return (
    resolveAuthorizedDreamingSidecar({
      cfg,
      normalized,
      activationSource: createPluginActivationSource({ config: cfg, plugins: normalized }),
      manifestRegistry,
      memorySlot,
    }) === null
  );
}

/**
 * Removes memory-core's managed dreaming cron job once memory-core stops being
 * loaded as the dreaming sidecar. Turning `dreaming.enabled` off on a
 * third-party slot owner, or disabling or denying memory-core, unloads it, and
 * dispose only clears timers, so without this pass its promotion job keeps
 * running beside the slot owner.
 */
export async function reconcileOrphanedMemoryDreamingJobs(params: {
  cron: MemoryDreamingJobCron;
  cfg: OpenClawConfig;
  logger: {
    warn: (obj: unknown, msg?: string) => void;
    info?: (obj: unknown, msg?: string) => void;
  };
  commitGuard?: () => void;
  /** Defaults to the active plugin registry's manifests, the ones the loader admitted against. */
  manifestRegistry?: PluginManifestRegistry;
}): Promise<{ ok: boolean }> {
  if (
    !isMemoryCoreDreamingOrphaned(params.cfg, params.manifestRegistry ?? activeManifestRegistry())
  ) {
    return { ok: true };
  }
  let jobs: CronJob[];
  try {
    jobs = await params.cron.list({ includeDisabled: true });
  } catch (error) {
    params.logger.warn({ err: String(error) }, "cron-memory-dreaming: job inventory failed");
    return { ok: false };
  }
  params.commitGuard?.();
  let ok = true;
  let removed = 0;
  for (const job of jobs.filter(isManagedMemoryCoreDreamingJob)) {
    await yieldToEventLoop();
    params.commitGuard?.();
    try {
      const result = await params.cron.remove(
        job.id,
        params.commitGuard ? { commitGuard: params.commitGuard } : undefined,
      );
      if (result.removed) {
        removed += 1;
      }
    } catch (error) {
      params.commitGuard?.();
      ok = false;
      params.logger.warn(
        { jobId: job.id, err: String(error) },
        "cron-memory-dreaming: orphaned memory-core dreaming job cleanup failed",
      );
    }
  }
  if (removed > 0) {
    params.logger.info?.(
      { removed },
      "cron-memory-dreaming: removed memory-core dreaming job(s) left behind by its unloaded sidecar",
    );
  }
  return { ok };
}
