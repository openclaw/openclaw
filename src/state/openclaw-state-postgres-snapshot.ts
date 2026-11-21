import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createStateReadPool } from "./openclaw-state-read-pool.js";
import { requestBytes } from "./openclaw-state-read-request.js";
import type { OpenClawStateReadRequest } from "./openclaw-state-read.types.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

/** The existing read worker retains PostgreSQL's exporter until discovery readers drain. */
export async function openPostgresStateReadSnapshot(
  context: OpenClawStateWorkerContext,
  signal: AbortSignal,
) {
  const pool = createStateReadPool(resolveRuntimeProcessEntrypointUrl("stateRead"));
  const ready = createDeferredCore<string>();
  const release = createDeferredCore();
  const setup = new AbortController();
  const abortSetup = () => setup.abort(signal.reason);
  signal.addEventListener("abort", abortSetup, { once: true });
  if (signal.aborted) {
    abortSetup();
  }
  const pathname = context.admission.databasePath;
  const request: OpenClawStateReadRequest = {
    context: {
      databaseEngineSelection: context.databaseEngineSelection,
      environment: context.environment,
      existingSchemaPath: context.existingSchemaPath,
      stateIntegrity: context.stateIntegrity,
    },
    databasePath: pathname,
    location: pathname,
    checkFreshAdmission: true,
    expectedIdentity: context.admission.identity.key,
    command: { type: "admit" },
    exportPostgresSnapshot: true,
  };
  const task = pool.runTask(request, {
    inputBytes: requestBytes(request),
    diagnosticOperation: "state.snapshot",
    signal: setup.signal,
    async onRequest(value) {
      // This ID comes directly from PostgreSQL through the private read-worker channel.
      if (typeof value !== "string" || !/^[0-9A-Fa-f-]+$/.test(value)) {
        throw new Error("Invalid PostgreSQL discovery snapshot");
      }
      setup.signal.throwIfAborted();
      // Once exported, the read scope keeps it alive through cancellation and drainage.
      signal.removeEventListener("abort", abortSetup);
      ready.resolve(value);
      await release.promise;
      return { input: null, timeoutMs: 300_000 };
    },
  });
  const result = task.result.then((reply) => {
    if (!reply.ok) {
      throw new Error(reply.message);
    }
  });
  void result.then(
    () => ready.reject(new Error("PostgreSQL discovery snapshot closed before admission")),
    ready.reject,
  );
  const close = async () => {
    release.resolve();
    const outcomes = await Promise.allSettled([result]);
    outcomes.push(...(await Promise.allSettled([task.close({ retire: true })])));
    outcomes.push(...(await Promise.allSettled([pool.close()])));
    throwSqliteLifecycleErrors(
      outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason] : [])),
      "PostgreSQL discovery snapshot cleanup failed",
    );
  };
  try {
    return { snapshot: await ready.promise, close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", abortSetup);
  }
}
