import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import {
  PluginsReloadResultSchema,
  type PluginsReloadResult,
} from "../../packages/gateway-protocol/src/schema/plugins.js";
import {
  capturePluginReloadRunTargets,
  type PluginReloadRunTarget,
} from "../agents/plugin-reload-runs.js";
import { formatErrorMessage } from "../infra/errors.js";
import { PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import type { PluginInstanceHandle } from "../plugins/plugin-instance-scope.js";
import { runWithGatewayDetachedWorkAdmission } from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  readPluginReloadOperation,
  savePluginReloadOperation,
} from "./plugin-reload-operation-store.js";
import type { PluginReloadOperation } from "./plugin-reload-operation-store.types.js";

export type AppliedPluginReloadResult = Exclude<PluginsReloadResult, { status: "accepted" }>;
export type PluginReloadResumeOutcome = { healthy: boolean; message: string };
type OperationPorts = {
  prepare: (
    operation: PluginReloadOperation,
    targets: PluginReloadRunTarget[],
    assertCurrent: () => void,
  ) => Promise<PluginReloadOperation>;
  resume: (operation: PluginReloadOperation, outcome: PluginReloadResumeOutcome) => Promise<void>;
  warn: (message: string) => void;
};
type StartParams = {
  operationId?: string;
  pluginIds: string[];
  requestKey: string;
  assertCurrent: () => void;
  onAccepted?: () => void;
  signal?: AbortSignal;
  run: (
    beforeForceDrain: (instances: readonly PluginInstanceHandle[]) => Promise<void>,
    operationId: string,
  ) => Promise<AppliedPluginReloadResult>;
};

/** One Gateway owns these jobs. An RPC is only an observer after durable acceptance. */
export function createPluginReloadOperationOwner(ports: OperationPorts) {
  const running = new Map<
    string,
    {
      pluginIds: string[];
      requestKey: string;
      accepted: Promise<void>;
      finished: Promise<AppliedPluginReloadResult>;
    }
  >();
  const receipt = (id: string, pluginIds: string[]) =>
    ({ ok: true, status: "accepted", operationId: id, pluginIds }) satisfies PluginsReloadResult;
  return {
    isRunning: (id: string) => running.has(id),
    async observe(id: string, requestKey: string) {
      const work = running.get(id);
      const stored = work ? undefined : await readPluginReloadOperation(id);
      const pluginIds = work?.pluginIds ?? stored?.pluginIds;
      if (!pluginIds) {
        return undefined;
      }
      if ((work?.requestKey ?? stored?.requestKey) !== requestKey) {
        throw new Error("Plugin reload operation ID already belongs to another request.");
      }
      if (work) {
        await work.accepted;
        return { receipt: receipt(id, pluginIds), finished: work.finished };
      }
      if (
        stored?.state === "succeeded" &&
        Value.Check(PluginsReloadResultSchema, stored.result) &&
        stored.result.status !== "accepted"
      ) {
        return { receipt: receipt(id, pluginIds), finished: Promise.resolve(stored.result) };
      }
      throw new Error(
        stored?.error ??
          "Plugin reload operation requires Gateway recovery; it was not resubmitted.",
      );
    },
    async start(params: StartParams) {
      const id = params.operationId ?? randomUUID();
      const pluginIds = [...new Set(params.pluginIds)].toSorted();
      let work = running.get(id);
      if (!work) {
        const accepted = createDeferredCore();
        const finished = runWithGatewayDetachedWorkAdmission(
          async () => {
            let operation: PluginReloadOperation | undefined;
            try {
              params.assertCurrent();
              const previous = await readPluginReloadOperation(id);
              params.assertCurrent();
              if (previous) {
                if (previous.requestKey !== params.requestKey) {
                  throw new Error("Plugin reload operation ID already belongs to another request.");
                }
                if (
                  previous.state === "succeeded" &&
                  Value.Check(PluginsReloadResultSchema, previous.result) &&
                  previous.result.status !== "accepted"
                ) {
                  accepted.resolve();
                  return previous.result;
                }
                throw new Error(
                  previous.error ??
                    "Plugin reload operation requires Gateway recovery; it was not resubmitted.",
                );
              }
              const now = Date.now();
              operation = {
                id,
                pluginIds,
                requestKey: params.requestKey,
                createdAtMs: now,
                updatedAtMs: now,
                state: "accepted",
                continuations: [],
              };
              await savePluginReloadOperation(operation);
              params.assertCurrent();
              params.onAccepted?.();
              accepted.resolve();
              const activeOperation = operation;
              let prepared = false;
              const result = await params.run(async (instances) => {
                if (prepared) {
                  return;
                }
                prepared = true;
                params.assertCurrent();
                // Reservations closed fresh generation admission and offered opt-in
                // cooperative handover before this exact-owner capture.
                const targets = capturePluginReloadRunTargets(new Set(instances));
                // Preparation durably records continuation and FIFO queue custody before returning.
                const preparedOperation = await ports.prepare(
                  activeOperation,
                  targets,
                  params.assertCurrent,
                );
                operation = preparedOperation;
                params.assertCurrent();
                for (const target of targets) {
                  // Cancellation never redirects to an abort listener's successor.
                  target.interrupt();
                }
                preparedOperation.state = "reloading";
                preparedOperation.updatedAtMs = Date.now();
                await savePluginReloadOperation(preparedOperation);
              }, id);
              operation.state = "succeeded";
              operation.result = result;
              operation.updatedAtMs = Date.now();
              await savePluginReloadOperation(operation);
              await ports.resume(operation, {
                healthy: true,
                message:
                  "The plugin reload committed a new runtime generation. Continue unfinished work from the transcript; do not repeat completed actions.",
              });
              return result;
            } catch (error) {
              accepted.reject(error);
              if (operation) {
                operation.state = "failed";
                operation.error = formatErrorMessage(error);
                operation.updatedAtMs = Date.now();
                await savePluginReloadOperation(operation);
                const healthy =
                  error instanceof PluginRuntimeApplicationError &&
                  (error.details.committed || error.details.runtimeRestored === true) &&
                  !error.details.runtimeRestorationFailed;
                await ports.resume(operation, {
                  healthy,
                  message: healthy
                    ? "The plugin reload failed, but a healthy runtime generation is published. Report the reload error and continue unfinished work without repeating completed actions."
                    : "The plugin reload failed without proof of a healthy runtime generation. Automatic continuation is blocked until Gateway recovery.",
                });
              }
              throw error;
            }
          },
          "plugin-reload:" + id,
          params.signal,
        );
        work = { pluginIds, requestKey: params.requestKey, accepted: accepted.promise, finished };
        running.set(id, work);
        // Non-waiting observers leave durable failures rather than unhandled rejections.
        void finished
          .catch((error: unknown) => {
            accepted.reject(error);
            ports.warn("Plugin reload " + id + " failed: " + formatErrorMessage(error));
          })
          .finally(() => running.delete(id));
      }
      if (work.requestKey !== params.requestKey) {
        throw new Error("Plugin reload operation ID already belongs to another request.");
      }
      await work.accepted;
      return { receipt: receipt(id, pluginIds), finished: work.finished };
    },
  };
}
