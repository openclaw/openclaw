import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { encodeDebugProxyPayload, type DebugProxyCliStore } from "../proxy-capture/cli-contract.js";
import { withDeferredDebugProxyCapture } from "../proxy-capture/runtime-deferral.js";
import { acquireDebugProxyCaptureStoreAsync } from "../proxy-capture/store.async.js";
import type { CaptureWorkerOperations } from "../proxy-capture/store.worker-contract.js";
import { createDeferredCore } from "../shared/deferred.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { runWithLocalStateOwner } from "./local-state-owner.js";
import { registerSignalExitGate } from "./signal-exit-barrier.js";

/** The proxy stays local; only persistence crosses the selected state-owner boundary. */
export function withProxyCaptureOwner<T>(
  action: (store: DebugProxyCliStore, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return withDeferredDebugProxyCapture(async () => {
    const finished = createDeferredCore();
    const controller = new AbortController();
    const releaseExitGate = registerSignalExitGate(finished.promise, () => controller.abort());
    try {
      const run = await runWithLocalStateOwner({
        method: "debugProxy.capture",
        params: {},
        target: "debug proxy capture",
        onForeignOwner:
          async ({ env, assertCurrent }) =>
          async () => {
            let queue: Promise<unknown> = Promise.resolve();
            const execute = <K extends keyof CaptureWorkerOperations>(
              type: K,
              input: CaptureWorkerOperations[K]["input"],
              wireInput: unknown = input,
            ): Promise<CaptureWorkerOperations[K]["output"]> => {
              const command = structuredClone({ type, input });
              const result = queue.then(() =>
                runWithLocalStateOwner<CaptureWorkerOperations[K]["output"]>({
                  method: "debugProxy.capture",
                  params: { command: { type, input: wireInput } },
                  target: "debug proxy capture",
                  recoveryCommand: "openclaw proxy sessions",
                  assertTargetCurrent: assertCurrent,
                  runLocal: ({ assertCurrent: assertOwnerCurrent }) =>
                    runOpenClawStateWorkerOperation(
                      captureOpenClawStateWorkerContext({ env }),
                      (scope) => scope.execute(command),
                      { assertCurrent: assertOwnerCurrent },
                    ),
                }),
              );
              queue = result.catch(() => undefined);
              return result;
            };
            try {
              controller.signal.throwIfAborted();
              return await action(
                {
                  dbPath: path.join(resolveStateDir(env), "state", "openclaw.sqlite"),
                  upsertSession: (input) => execute("capture.upsertSession", input),
                  endSession: (sessionId, endedAt = Date.now()) =>
                    execute("capture.endSession", { sessionId, endedAt }),
                  recordEvent: (input) => execute("capture.recordEvent", input),
                  recordEventWithPayload: (event, payload) =>
                    execute(
                      "capture.recordEventWithPayload",
                      { event, payload },
                      { event, payload: encodeDebugProxyPayload(payload) },
                    ),
                  listSessions: (limit) => execute("capture.listSessions", { limit }),
                  readBlob: (blobId) => execute("capture.readBlob", { blobId }),
                  queryPreset: (preset, sessionId) =>
                    execute("capture.queryPreset", { preset, sessionId }),
                  purgeAll: () => execute("capture.purgeAll", undefined),
                },
                controller.signal,
              );
            } finally {
              await queue;
            }
          },
        runLocal: async ({ env, assertCurrent }) => {
          assertCurrent();
          const lease = await acquireDebugProxyCaptureStoreAsync({ env });
          const outcome = await Promise.resolve()
            .then(() => {
              assertCurrent();
              controller.signal.throwIfAborted();
              return action(lease.store, controller.signal);
            })
            .then(
              (value) => ({ ok: true, value }) as const,
              (error: unknown) => ({ ok: false, error }) as const,
            );
          try {
            await lease.release();
          } catch (error) {
            if (outcome.ok) {
              throw error;
            }
            const errors: unknown[] =
              outcome.error instanceof AggregateError ? outcome.error.errors : [outcome.error];
            throw new AggregateError(
              [...errors, error],
              "Debug proxy command and capture cleanup failed.",
              { cause: error },
            );
          }
          if (!outcome.ok) {
            throw outcome.error;
          }
          return async () => outcome.value;
        },
      });
      return await run();
    } finally {
      finished.resolve();
      releaseExitGate();
    }
  });
}
