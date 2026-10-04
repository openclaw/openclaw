import { Worker, type WorkerOptions } from "node:worker_threads";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createDeferredCore } from "../shared/deferred.js";

export function createCronMutationProbe(sessionKey: string) {
  const checkpoint = createDeferredCore();
  const releaseBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  return {
    sessionKey,
    moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionTranscriptArchive).href,
    releaseBuffer,
    checkpoint,
    commitGate: undefined as SharedArrayBuffer | undefined,
    beforeGrant: undefined as (() => void) | undefined,
    grantAttempts: 0,
    held: false,
    readerReleases: new Set<() => void>(),
    release() {
      for (const release of this.readerReleases) {
        release();
      }
      Atomics.store(new Int32Array(releaseBuffer), 0, 1);
      Atomics.notify(new Int32Array(releaseBuffer), 0);
    },
  };
}
export type CronMutationProbe = ReturnType<typeof createCronMutationProbe>;

const postGrantPreload = `
  import { parentPort, workerData } from "node:worker_threads";
  const fixture = workerData.cronMutationProbe;
  let gate;
  let held = false;
  const observeRequest = (request) => {
    if (request.type === "reclaim" &&
        ["entry", "lifecycle-projection-commit"].includes(request.plan.kind) &&
        request.plan.descendantRunBasis?.sessionKeys.includes(fixture.sessionKey)) {
      gate = request.commitGate;
    }
  };
  const on = parentPort.on;
  parentPort.on = function(event, listener) {
    if (event === "message") {
      // An eager preload listener consumes queued requests before the real worker imports finish.
      parentPort.on = on;
      on.call(this, event, observeRequest);
    }
    return on.call(this, event, listener);
  };
  const load = Atomics.load;
  Atomics.load = function(view, index) {
    const observed = load(view, index);
    // Observe the real gate's COMMITTING decision, including immediate grants.
    if (!held && view.buffer === gate && index === 0 && observed === 3) {
      held = true;
      parentPort.postMessage({ type: "cron-test:post-grant", sessionKey: fixture.sessionKey });
      Atomics.wait(new Int32Array(fixture.releaseBuffer), 0, 0);
    }
    return observed;
  };
`;

export function withCronMutationProbe(
  options: WorkerOptions | undefined,
  probe: CronMutationProbe,
) {
  return {
    ...options,
    execArgv: [
      ...(options?.execArgv ?? []),
      "--import",
      `data:text/javascript,${encodeURIComponent(postGrantPreload)}`,
    ],
    workerData: {
      ...options?.workerData,
      cronMutationProbe: { sessionKey: probe.sessionKey, releaseBuffer: probe.releaseBuffer },
    },
  };
}

/** Independent native writer: no parent SQLite calls or registry publication. */
export async function updateForeignSubagentPayload(
  databasePath: string,
  runId: string,
  payload: string,
) {
  const worker = new Worker(
    `const { workerData } = require("node:worker_threads");
     const { DatabaseSync } = require("node:sqlite");
     const db = new DatabaseSync(workerData.databasePath);
     try {
       db.exec("BEGIN IMMEDIATE");
       const result = db.prepare("UPDATE subagent_runs SET payload_json = ? WHERE run_id = ?")
         .run(workerData.payload, workerData.runId);
       if (result.changes !== 1) throw new Error("Foreign fixture did not update its exact row");
       db.exec("COMMIT");
     } finally { db.close(); }`,
    { eval: true, workerData: { databasePath, runId, payload } },
  );
  let failure: Error | undefined;
  worker.once("error", (error) => {
    failure = error instanceof Error ? error : new Error(String(error));
  });
  const code = await new Promise<number>((resolve) => {
    worker.once("exit", resolve);
  });
  if (failure) {
    throw failure;
  }
  if (code !== 0) {
    throw new Error(`Foreign fixture worker exited ${code}`);
  }
}
