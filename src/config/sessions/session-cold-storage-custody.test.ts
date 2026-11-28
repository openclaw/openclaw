import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { bundledModuleRegions } from "../../../scripts/lib/bundled-module-regions.mjs";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import * as workerCpu from "../../infra/worker-cpu.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type {
  SqliteArchiveSessionRequest,
  SqliteArchiveSessionResponse,
} from "./session-accessor.sqlite-archive-types.js";
import { joinSqliteArchiveWorkerCleanup } from "./session-accessor.sqlite-archive-worker-lifetime.js";
import * as archiveWorkers from "./session-accessor.sqlite-archive.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import {
  restoreSessionColdTranscript,
  runSessionColdStorageMaintenance,
} from "./session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  historicalId,
  maintenanceConfig,
} from "./session-cold-storage.test-support.js";

const physicalStallPreload = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { workerData } from "node:worker_threads";
const fixture = workerData.coldPhysicalStall;
if (fixture) {
  const gate = new Int32Array(fixture.gate);
  const original = fs.statSync;
  fs.statSync = new Proxy(original, {
    apply(target, receiver, args) {
      const result = Reflect.apply(target, receiver, args);
      if (args[0] === fixture.path && new Error().stack?.includes("assertSessionColdSourceCurrent") &&
          Atomics.compareExchange(gate, 0, 1, 2) === 1) {
        Atomics.notify(gate, 0);
        if (Atomics.wait(gate, 0, 2, 10000) === "timed-out") throw new Error("Physical custody test was not released");
      }
      return result;
    },
  });
  syncBuiltinESMExports();
}
`;

const preparationImportsPreload = `
import fs from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { workerData } from "node:worker_threads";
const fixture = workerData.coldPreparationProbe;
const observations = new Int32Array(fixture.observations);
const moduleRegions = ${bundledModuleRegions.toString()};
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.startsWith("file:") || loaded.source == null) return loaded;
    const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
    // Bundled owners can share a chunk; labels preserve their identity after filename hashing.
    const owners = new Set([...moduleRegions(source)].map(region => region[1]));
    const contains = owner => url.endsWith("/" + owner) || owners.has(owner);
    for (const owner of [
      "src/config/sessions/session-cold-storage-worker.ts",
      "src/config/sessions/session-accessor.sqlite-mutation-worker.runtime.ts",
      "src/state/openclaw-agent-db.ts",
      "src/state/openclaw-state-db.ts",
      "src/state/openclaw-state-db-image-snapshot-migration.ts",
      "src/gateway/worker-environments/environment-recipe.ts",
    ]) {
      if (contains(owner)) throw new Error("Cold preparation loaded mutation owner: " + owner);
    }
    for (const [index, owner] of [
      "src/config/sessions/session-cold-storage-prepare.ts",
      "src/config/sessions/session-cold-storage-custody.ts",
    ].entries()) {
      if (contains(owner)) Atomics.add(observations, index, 1);
    }
    return loaded;
  },
});
const original = fs.statSync;
fs.statSync = new Proxy(original, {
  apply(target, receiver, args) {
    const result = Reflect.apply(target, receiver, args);
    if (args[0] === fixture.path && new Error().stack?.includes("assertSessionColdSourceCurrent")) {
      Atomics.add(observations, 2, 1);
    }
    return result;
  },
});
syncBuiltinESMExports();
`;

it("prepares cold transcripts with physical custody without loading mutation owners", async () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.statePath("agents", "main", "agent", "openclaw-agent.sqlite");
    const fixture = await createSessionColdStorageFixture(storePath);
    const original = fixture.snapshot();
    const identity = readDatabasePathIdentitySync(storePath);
    const observations = new Int32Array(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT));
    const createWorker = workerCpu.createCpuTrackedWorker;
    const spawn = vi
      .spyOn(workerCpu, "createCpuTrackedWorker")
      .mockImplementation((url, options, requestClass) =>
        createWorker(
          url,
          {
            ...options,
            workerData: {
              ...options?.workerData,
              coldPreparationProbe: { path: storePath, observations: observations.buffer },
            },
            execArgv: [
              ...(options?.execArgv ?? []),
              "--import",
              `data:text/javascript,${encodeURIComponent(preparationImportsPreload)}`,
            ],
          },
          requestClass,
        ),
      );
    let worker: ReturnType<typeof archiveWorkers.createSqliteTranscriptArchiveWorker> | undefined;
    let exited: Promise<number> | undefined;
    let prepared = false;
    try {
      // A fresh carrier proves preparation alone does not inherit a previous mutation's modules.
      worker = archiveWorkers.createSqliteTranscriptArchiveWorker({
        type: "sqlite-transcript-archive-v2",
        operation: "archive-session",
        env: { OPENCLAW_STATE_DIR: state.statePath() },
      });
      const carrier = worker;
      exited = new Promise((resolve) => carrier.once("exit", resolve));
      const response = await new Promise<
        Extract<SqliteArchiveSessionResponse, { type: "cold-prepared" }>
      >((resolve, reject) => {
        const cleanup = () => {
          carrier.off("message", receive);
          carrier.off("error", failed);
          carrier.off("exit", stopped);
        };
        const failed = (error: Error) => {
          cleanup();
          reject(error);
        };
        const stopped = () => failed(new Error("Cold preparation worker exited without a result"));
        const receive = (message: SqliteArchiveSessionResponse | { status: string }) => {
          if ("type" in message && message.type === "cold-prepared") {
            cleanup();
            resolve(message);
          }
        };
        carrier.on("message", receive);
        carrier.once("error", failed);
        carrier.once("exit", stopped);
        carrier.postMessage({
          type: "archive-operation",
          operation: "cold-prepare",
          input: {
            databaseOptions: fixture.options,
            source: {
              readIdentity: identity,
              readCustody: [
                {
                  sourcePath: storePath,
                  candidates: [{ path: storePath, physicalPath: identity.canonicalPath, identity }],
                },
              ],
            },
            admissionIdentities: [],
            liveSessionKeys: [],
            cooledSessionIds: [],
            beforeMs: 100,
            maxTranscripts: 1,
            maxBytes: 64 * 1024 * 1024,
          },
        } satisfies SqliteArchiveSessionRequest);
      });
      prepared = true;
      expect(spawn).toHaveBeenCalledOnce();
      for (const [index, name] of [
        "preparation module",
        "custody module",
        "physical source validation",
      ].entries()) {
        expect(observations[index], name).toBeGreaterThan(0);
      }
      expect(response.results).toHaveLength(1);
      const result = response.results[0]!;
      expect(result.needsReconcile).toBe(false);
      expect(result.prepared).toHaveLength(1);
      const transcript = result.prepared[0]!;
      expect(transcript.plan.sessionId).toBe(historicalId);
      expect(transcript.archive.generation).toBe(transcript.plan.snapshot.generation);
      expect(transcript.archive.event_count).toBeGreaterThan(0);
      expect(transcript.envelopeBytes).toBeGreaterThan(0);
      expect(fixture.snapshot()).toEqual(original);
    } finally {
      try {
        if (worker) {
          if (prepared) {
            worker.postMessage({ type: "close" });
          } else {
            await worker.terminate();
          }
          await exited;
          await joinSqliteArchiveWorkerCleanup(worker);
        }
      } finally {
        spawn.mockRestore();
      }
    }
  }));

it.each(["before acceptance", "accepted close", "accepted cancellation"] as const)(
  "retains cold mutation custody through a physical stall: %s",
  async (phase) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.statePath("agents", "main", "agent", "openclaw-agent.sqlite");
      const gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      const createWorker = workerCpu.createCpuTrackedWorker;
      const spawn = vi
        .spyOn(workerCpu, "createCpuTrackedWorker")
        .mockImplementation((url, options, requestClass) =>
          createWorker(
            url,
            {
              ...options,
              workerData: {
                ...options?.workerData,
                coldPhysicalStall: { path: storePath, gate: gate.buffer },
              },
              execArgv: [
                ...(options?.execArgv ?? []),
                "--import",
                `data:text/javascript,${encodeURIComponent(physicalStallPreload)}`,
              ],
            },
            requestClass,
          ),
        );
      const release = () => {
        Atomics.store(gate, 0, 3);
        Atomics.notify(gate, 0);
      };
      let pending: Promise<void> | undefined;
      let closing: Promise<boolean> | undefined;
      let restoreIntercept: (() => void) | undefined;
      try {
        const fixture = await createSessionColdStorageFixture(storePath);
        const original = fixture.snapshot();
        await runSessionColdStorageMaintenance({ config: maintenanceConfig(storePath) });
        const archived = fixture.snapshot();
        let commitRequested = false;
        const operation = archiveWorkers.runSqliteTranscriptArchiveWorkerOperation;
        const intercept = vi
          .spyOn(archiveWorkers, "runSqliteTranscriptArchiveWorkerOperation")
          .mockImplementation((params) =>
            operation(
              params.expectedMessageType === "reclaimed"
                ? {
                    ...params,
                    onCommitRequest() {
                      commitRequested = true;
                      params.onCommitRequest();
                      if (phase !== "before acceptance") {
                        Atomics.store(gate, 0, 1);
                      }
                    },
                  }
                : params,
            ),
          );
        restoreIntercept = () => intercept.mockRestore();
        if (phase === "before acceptance") {
          Atomics.store(gate, 0, 1);
        }
        const controller = new AbortController();
        let settled = false;
        pending = restoreSessionColdTranscript(
          fixture.scope,
          undefined,
          undefined,
          undefined,
          controller.signal,
        ).finally(() => {
          settled = true;
        });
        const outcome = pending.catch((error: unknown) => error);
        const reached = async () => {
          while (Atomics.load(gate, 0) !== 2) {
            const wait = Atomics.waitAsync(gate, 0, Atomics.load(gate, 0));
            if (wait.async) {
              await wait.value;
            }
          }
        };
        await awaitGateBeforeSettlement(
          reached(),
          pending,
          "Cold worker did not enter physical qualification",
        );
        let closed = false;
        if (phase === "accepted cancellation") {
          controller.abort(new Error("Cold request canceled"));
        } else {
          closing = closeOpenClawAgentDatabaseByPathAsync(storePath).finally(() => {
            closed = true;
          });
        }
        await setImmediate();
        expect(settled).toBe(false);
        expect(closed).toBe(false);
        expect(commitRequested).toBe(phase !== "before acceptance");
        release();
        await outcome;
        await closing;
        expect(fixture.snapshot()).toEqual(phase === "before acceptance" ? archived : original);
        expect(Boolean(readSessionColdTranscript(fixture.database(), historicalId))).toBe(
          phase === "before acceptance",
        );
      } finally {
        release();
        await Promise.allSettled([pending, closing]);
        restoreIntercept?.();
        spawn.mockRestore();
      }
    }),
);
