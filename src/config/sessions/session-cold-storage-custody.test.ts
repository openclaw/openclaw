import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import * as workerCpu from "../../infra/worker-cpu.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
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
