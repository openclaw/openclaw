import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { findCapabilityProviderEntry } from "../plugins/provider-registry-shared.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { resolveTranscriptsConfig } from "../transcripts/config.js";
import {
  schedulePostReadySidecarTask,
  type GatewayPostReadySidecarHandle,
} from "./server-startup-sidecar-scheduler.js";
import type { GatewayStartupTrace } from "./server-startup-trace.js";

type TranscriptCapturePolicy = ReturnType<
  typeof import("../transcripts/capture-operations.js").prepareTranscriptCaptureDisable
>;

export function scheduleTranscriptsSidecar(params: {
  cfg: OpenClawConfig;
  getConfig: () => OpenClawConfig;
  getPluginRegistry: () => PluginRegistry;
  lifetimeSignal: AbortSignal;
  startupTrace?: GatewayStartupTrace;
  log: { warn: (msg: string) => void };
  waitForPostReadyWork?: () => Promise<void>;
  shouldRun?: () => boolean;
}): GatewayPostReadySidecarHandle {
  const stateDir = resolveStateDir();
  let config = params.cfg;
  let paused = false;
  let service:
    | ReturnType<typeof import("../transcripts/auto-start.js").createTranscriptsAutoStartService>
    | undefined;
  let sidecar: GatewayPostReadySidecarHandle | undefined;
  let shutdownCapturePolicy: TranscriptCapturePolicy | undefined;
  let stopped = false;
  const start = () => {
    if (stopped || paused) {
      return;
    }
    if (service) {
      withPluginRuntimeRegistryScope(params.getPluginRegistry(), () => service!.start(config));
    } else if (!sidecar && config.transcripts?.autoStart?.length) {
      // Keep the reload handle from startup, but load capture runtime only on first use.
      sidecar = schedulePostReadySidecarTask({
        startupTrace: params.startupTrace,
        name: "sidecars.transcripts-auto-start",
        log: params.log,
        waitForPostReadyWork: params.waitForPostReadyWork,
        shouldRun: params.shouldRun,
        run: async (isStopped) => {
          const { createTranscriptsAutoStartService } =
            await import("../transcripts/auto-start.js");
          if (isStopped()) {
            return;
          }
          service = createTranscriptsAutoStartService(
            { config, stateDir, logger: params.log },
            params.getConfig,
          );
          start();
        },
        stop: () =>
          withPluginRuntimeRegistryScope(params.getPluginRegistry(), () => service?.stop()),
      });
    }
  };
  start();
  return {
    stop: async () => {
      stopped = true;
      const results = await Promise.allSettled([
        sidecar?.stop(),
        (async () => {
          if (!shutdownCapturePolicy) {
            const { prepareTranscriptCaptureDisable } =
              await import("../transcripts/capture-operations.js");
            shutdownCapturePolicy = prepareTranscriptCaptureDisable(stateDir);
            // Keep admission fenced while metadata still owns the closing Gateway.
            if (params.lifetimeSignal.aborted) {
              shutdownCapturePolicy.resume();
            } else {
              params.lifetimeSignal.addEventListener("abort", shutdownCapturePolicy.resume, {
                once: true,
              });
            }
          }
          await shutdownCapturePolicy.drain();
        })(),
      ]);
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length) {
        throw new AggregateError(failures, "Transcript capture shutdown failed");
      }
    },
    preparePluginReload({ previousRegistry, nextRegistry, changedPluginIds, nextConfig }) {
      const affected = new Set<string>();
      let capturePolicy: TranscriptCapturePolicy | undefined;
      for (const entry of resolveTranscriptsConfig(config.transcripts).autoStart) {
        const { providerId } = entry;
        const replaced = [previousRegistry, nextRegistry].some((registry) => {
          const provider = findCapabilityProviderEntry(
            registry.transcriptSourceProviders,
            providerId,
          );
          return provider && changedPluginIds.has(provider.pluginId);
        });
        if (replaced) {
          affected.add(providerId.trim().toLowerCase());
        }
      }
      // Pause before draining: the lazy startup import may finish during replacement.
      paused = true;
      return {
        drain: () =>
          withPluginRuntimeRegistryScope(previousRegistry, async () => {
            if (nextConfig.transcripts?.enabled === false) {
              const { prepareTranscriptCaptureDisable } =
                await import("../transcripts/capture-operations.js");
              capturePolicy = prepareTranscriptCaptureDisable(stateDir);
              await capturePolicy.drain();
            }
            await service?.stop(affected, nextConfig);
          }),
        async resume(resumedConfig) {
          capturePolicy?.resume();
          const registry = params.getPluginRegistry();
          const newlyAvailable = new Set<string>();
          // Metadata preflight has no runtime provider aliases for newly enabled
          // plugins. Retire their unavailable-provider retries once the real
          // registration is published so capture resumes immediately.
          for (const { providerId } of resolveTranscriptsConfig(config.transcripts).autoStart) {
            const normalized = providerId.trim().toLowerCase();
            const provider = findCapabilityProviderEntry(
              registry.transcriptSourceProviders,
              providerId,
            );
            if (provider && changedPluginIds.has(provider.pluginId) && !affected.has(normalized)) {
              affected.add(normalized);
              newlyAvailable.add(normalized);
            }
          }
          if (newlyAvailable.size) {
            await withPluginRuntimeRegistryScope(registry, () => service?.stop(newlyAvailable));
          }
          config = resumedConfig;
          paused = false;
          start();
        },
      };
    },
  };
}
