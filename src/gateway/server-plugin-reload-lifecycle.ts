import { randomUUID } from "node:crypto";
import { PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import type { PluginReplacementOutcome } from "../plugins/plugin-instance.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { createPluginReloadChannels } from "./server-plugin-reload-channels.js";
import type { createPluginReloadRecovery } from "./server-plugin-reload-recovery.js";
import type { createGatewayPluginRuntimeGeneration } from "./server-plugin-runtime-generation.js";

type Generation = ReturnType<typeof createGatewayPluginRuntimeGeneration>;
type Finish = Parameters<Generation["finishReload"]>;
type Facts = {
  phase: "prepare" | "drain" | "activate" | "dispose";
  committed: boolean;
  restored: boolean;
  channelRecoveryErrors: unknown[];
  releaseResourceHandoff: (() => void) | undefined;
};

/** One reload owns its health outcome through the last joined recovery cleanup. */
export function createPluginReloadLifecycle(requestedOperationId?: string) {
  const operationId = requestedOperationId ?? randomUUID();
  const outcome = createDeferredCore<PluginReplacementOutcome>();
  let started = false;
  return {
    operationId,
    replacementOperation: { operationId, settled: outcome.promise },
    async run<T>(
      this: void,
      ports: {
        previousReloadStatus: Finish[0];
        channels: Pick<ReturnType<typeof createPluginReloadChannels>, "release">;
        recovery: Pick<
          ReturnType<typeof createPluginReloadRecovery>,
          "dispose" | "unavailablePluginIds"
        >;
        finishReloadInputs: {
          changedPluginIds: Finish[2];
          runtime: {
            kernel: { pluginRuntimeGeneration: Pick<Generation, "finishReload"> };
            pluginRuntime: { registry: Finish[3] };
          };
          restartDrainSignal: AbortSignal;
          log: { error: NonNullable<Finish[5]> };
        };
      },
      body: (facts: Facts) => Promise<T>,
    ): Promise<T> {
      if (started) {
        throw new Error("Plugin reload lifecycle already ran");
      }
      started = true;
      const facts: Facts = {
        phase: "prepare",
        committed: false,
        restored: false,
        channelRecoveryErrors: [],
        releaseResourceHandoff: undefined,
      };
      let result: { ok: true; value: T } | { ok: false; error: unknown };
      try {
        result = { ok: true, value: await body(facts) };
      } catch (error) {
        result = { ok: false, error };
      }
      let kind: PluginReplacementOutcome["kind"] =
        facts.phase === "dispose"
          ? "applied"
          : facts.restored
            ? "restored"
            : facts.phase === "prepare"
              ? "unchanged"
              : "failed";
      const failures: unknown[] = [];
      try {
        facts.releaseResourceHandoff?.();
        // A completed operation never retains an in-progress channel pause. Failed
        // instances keep their own resource/admission fence until a later safe reload.
        ports.channels.release("failed");
        const inputs = ports.finishReloadInputs;
        inputs.runtime.kernel.pluginRuntimeGeneration.finishReload(
          ports.previousReloadStatus,
          kind,
          inputs.changedPluginIds,
          inputs.runtime.pluginRuntime.registry,
          ports.recovery.unavailablePluginIds,
          inputs.restartDrainSignal.aborted ? undefined : inputs.log.error,
        );
      } catch (error) {
        failures.push(error);
        kind = "failed";
      }
      try {
        await ports.recovery.dispose();
      } catch (error) {
        failures.push(error);
        kind = "failed";
      }
      // Preserve public projection; failed retirement or incomplete channel recovery
      // cannot authorize private replay even when the finalizer ports succeed.
      if ((!result.ok && kind === "applied") || facts.channelRecoveryErrors.length) {
        kind = "failed";
      }
      // Reservation release and publication precede activation/recovery health.
      outcome.resolve({
        kind,
        committed: facts.committed,
        unavailablePluginIds: [...ports.recovery.unavailablePluginIds],
      });
      if (!result.ok) {
        if (!failures.length) {
          throw result.error;
        }
        const cause = new AggregateError(
          [result.error, ...failures],
          "Plugin operation and cleanup failed",
        );
        if (result.error instanceof PluginRuntimeApplicationError) {
          throw new PluginRuntimeApplicationError(
            "Plugin operation and cleanup failed",
            result.error.details,
            { cause },
          );
        }
        throw cause;
      }
      if (failures.length) {
        throw failures.length === 1
          ? failures[0]
          : new AggregateError(failures, "Plugin cleanup failed");
      }
      return result.value;
    },
  };
}
