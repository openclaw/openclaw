import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewaySchedulerScope } from "../infra/gateway-scheduler.js";
import type { WorkerExecutionMode, WorkerProfile, WorkerProvider } from "../plugins/types.js";

/** Schedules only canonical immutable producers; allocation and enrollment remain turn-owned. */
export function scheduleWorkerRuntimeArtifactPreparation(options: {
  scope: GatewaySchedulerScope;
  getConfig: () => OpenClawConfig;
  resolveProvider: (providerId: string) => WorkerProvider | undefined;
  hasMetadata: () => boolean;
  prepareBundle: (signal: AbortSignal) => Promise<unknown>;
  prepareBootstrap: (
    profile: WorkerProfile,
    signal: AbortSignal,
  ) => Promise<{ assertCurrent: () => void }>;
  log: { info: (message: string) => void; warn: (message: string) => void };
}) {
  options.scope.schedule({
    id: "worker-runtime-artifacts",
    delayMs: 0,
    run: async () => {
      const modes = new Set<WorkerExecutionMode>();
      for (const profile of Object.values(options.getConfig().cloudWorkers?.profiles ?? {})) {
        const provider = options.resolveProvider(profile.provider);
        if (provider?.requiresNodeEnrollment) {
          for (const mode of provider.supportedExecutionModes ?? ["worker-turn"]) {
            modes.add(mode);
          }
        }
      }
      if (!modes.size || !options.hasMetadata()) {
        return;
      }
      const signal = options.scope.signal;
      const consumer = new AbortController();
      const preparationSignal = AbortSignal.any([signal, consumer.signal]);
      const measure = async <T>(stage: string, prepare: () => Promise<T>) => {
        const startedAt = performance.now();
        options.log.info(JSON.stringify({ stage, outcome: "started", elapsedMs: 0 }));
        try {
          const result = await prepare();
          options.log.info(
            JSON.stringify({
              stage,
              outcome: "completed",
              elapsedMs: Math.round(performance.now() - startedAt),
            }),
          );
          return result;
        } catch (error) {
          options.log.info(
            JSON.stringify({
              stage,
              outcome: signal.aborted ? "aborted" : "failed",
              elapsedMs: Math.round(performance.now() - startedAt),
            }),
          );
          throw error;
        }
      };
      const results = await Promise.allSettled([
        measure("worker-bundle-artifact-preturn", () => options.prepareBundle(preparationSignal)),
        ...[...modes].map(async (executionMode) => {
          await measure(`node-bootstrap-artifact-preturn:${executionMode}`, async () => {
            const prepared = await options.prepareBootstrap({ executionMode }, preparationSignal);
            signal.throwIfAborted();
            prepared.assertCurrent();
          });
        }),
      ]);
      // Warming retains output in the producer, not an enrollment's archive pin.
      consumer.abort();
      if (!signal.aborted && results.some((result) => result.status === "rejected")) {
        options.log.warn(
          "Worker runtime artifact preparation failed; dispatch will retry its canonical producer",
        );
      }
    },
  });
}
