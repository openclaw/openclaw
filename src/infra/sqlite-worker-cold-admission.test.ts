import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import { StateDatabaseAdmissionPendingError } from "./gateway-state-owner-record.js";
import {
  createSqliteDatabaseAdmissionRelay,
  createSqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";

type ColdResult = {
  error?: { message: string; pending: boolean };
  refused: boolean;
  refusalUndefined: boolean;
};
type ColdMessage =
  | { kind: "retry" | "lease-held" }
  | { kind: "mutate" }
  | { kind: "result"; result: ColdResult };

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([
  ["creation", "retry"],
  ["creation", "exhausted"],
  ["creation", "non-open"],
  ["creation", "companion"],
  ["creation", "revoked"],
  ["schema", "retry"],
  ["schema", "exhausted"],
  ["schema", "non-open"],
  ["schema", "companion"],
  ["schema", "revoked"],
  ["schema", "lease-held"],
  ["schema", "acquire-pending"],
  ["schema", "transaction"],
] as const)(
  "keeps cold %s admission bounded and authoritative: %s",
  async (transport, scenario) => {
    const root = tempDirs.make("sqlite-cold-admission-");
    const databasePath = path.join(root, "state.sqlite");
    const requestedPath =
      scenario === "companion" ? path.join(root, "companion.sqlite") : databasePath;
    const pending = new StateDatabaseAdmissionPendingError(databasePath, "Synthetic schema owner");
    const revoked = new Error("Synthetic request revoked");
    let schemaBusy = scenario !== "lease-held";
    let requestCurrent = true;
    const mutate = vi.fn();
    const create = vi.fn();
    const release = vi.fn();
    const admission = createSqliteWorkerOperationAdmission(() => {
      throw new Error("Cold file creation must not enter a transaction");
    });
    admission.bindDatabaseAuthority({
      databasePath: resolveIdentityPathViaExistingAncestorSync(databasePath),
      coldOpenPath: scenario === "non-open" ? undefined : databasePath,
      assertRequest() {
        if (!requestCurrent) {
          throw revoked;
        }
      },
      assertAccess() {
        if (schemaBusy && scenario !== "acquire-pending") {
          throw pending;
        }
      },
      assertCreate: create,
      acquireSchema() {
        if (transport === "creation") {
          throw new Error("File creation must not borrow schema authority");
        }
        if (schemaBusy) {
          throw pending;
        }
        return { assertCurrent() {}, release };
      },
    });
    const checkpoint = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const worker = new Worker(
      `const { parentPort, workerData } = require("node:worker_threads");
     (async () => {
       const { register } = await import(workerData.loader);
       const unregister = register();
       try {
         const { withStateDatabaseColdAdmission } = await import(workerData.stateOwner);
         const { StateDatabaseAdmissionPendingError } = await import(workerData.errors);
         const { exchangeSqliteDatabaseAdmissions } = await import(workerData.relay);
         const {
           requestSqliteWorkerOperationAdmission,
           requestSqliteWorkerSchemaMaintenance,
           withSqliteWorkerOperationAdmission,
         } = await import(workerData.admission);
         const { databasePath, requestedPath, transport, scenario, port } = workerData;
         const checkpoint = new Int32Array(workerData.checkpoint);
         const yieldToHost = (kind) => {
           const previous = Atomics.load(checkpoint, 0);
           parentPort.postMessage({ kind });
           while (Atomics.load(checkpoint, 0) === previous) {
             if (Atomics.wait(checkpoint, 0, previous, 10_000) === "timed-out") {
               throw new Error("Cold-admission fixture host did not release checkpoint");
             }
           }
         };
         const owner = { port };
         let error;
         try {
           withSqliteWorkerOperationAdmission(owner, () => {
             if (scenario === "lease-held") {
               requestSqliteWorkerSchemaMaintenance(databasePath);
               yieldToHost("lease-held");
             }
             withStateDatabaseColdAdmission(
               {
                 databasePath: requestedPath,
                 busyTimeoutMs: scenario === "exhausted" ? 0 : 100,
                 canRetry() {
                   if (scenario !== "exhausted") yieldToHost("retry");
                   return true;
                 },
               },
               () => {
                 if (transport === "creation") {
                   exchangeSqliteDatabaseAdmissions(port, [], requestedPath, true);
                 } else if (scenario === "transaction") {
                   requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
                 } else {
                   requestSqliteWorkerSchemaMaintenance(requestedPath);
                 }
                 parentPort.postMessage({ kind: "mutate" });
               },
             );
           });
         } catch (caught) {
           error = { message: caught.message, pending: caught instanceof StateDatabaseAdmissionPendingError };
         }
         parentPort.postMessage({ kind: "result", result: { error, refused: owner.refusal instanceof Error, refusalUndefined: owner.refusal === undefined } });
       } finally {
         unregister();
         workerData.port.close();
         parentPort.close();
       }
     })().catch((error) => { throw error; });`,
      {
        eval: true,
        execArgv: [],
        workerData: {
          loader: import.meta.resolve("tsx/esm/api"),
          stateOwner: new URL("./gateway-state-owner.ts", import.meta.url).href,
          errors: new URL("./gateway-state-owner-record.ts", import.meta.url).href,
          relay: new URL("./sqlite-worker-database-admission-relay.ts", import.meta.url).href,
          admission: new URL("./sqlite-worker-operation-admission.ts", import.meta.url).href,
          databasePath,
          requestedPath,
          transport,
          scenario,
          port: admission.port,
          checkpoint: checkpoint.buffer,
        },
        transferList: [admission.port],
      },
    );
    onTestFinished(async () => {
      await worker.terminate();
      await admission.finish();
    });
    const exited = once(worker, "exit");
    let result: ColdResult | undefined;
    const checkpoints: Array<{ kind: "retry" | "lease-held"; exists: boolean; mutations: number }> =
      [];
    worker.on("message", (message: ColdMessage) => {
      if (message.kind === "result") {
        result = message.result;
      } else if (message.kind === "mutate") {
        mutate();
      } else {
        // Only an actual pending refusal or acquired lease can reach this checkpoint.
        checkpoints.push({
          kind: message.kind,
          exists: existsSync(requestedPath),
          mutations: mutate.mock.calls.length,
        });
        schemaBusy = message.kind === "lease-held";
        requestCurrent = scenario !== "revoked";
        Atomics.add(checkpoint, 0, 1);
        Atomics.notify(checkpoint, 0);
      }
    });
    const succeeds = scenario === "retry" || scenario === "acquire-pending";
    const retryable = succeeds || scenario === "exhausted";
    try {
      expect(await exited).toEqual([0]);
      expect(result).toBeDefined();
      if (succeeds) {
        expect(result?.error).toBeUndefined();
      } else if (scenario === "exhausted") {
        expect(result?.error).toMatchObject({ pending: true });
      } else {
        expect(result?.error?.message).toBe(
          transport === "creation"
            ? "SQLite admission facts exchange failed"
            : "SQLite transaction admission was refused",
        );
      }
      expect(checkpoints).toEqual(
        succeeds || scenario === "revoked" || scenario === "lease-held"
          ? [
              {
                kind: scenario === "lease-held" ? "lease-held" : "retry",
                exists: false,
                mutations: 0,
              },
            ]
          : [],
      );
      const created = succeeds && transport === "creation";
      expect(mutate.mock.calls).toEqual(succeeds ? [[]] : []);
      expect(create.mock.calls).toEqual(created ? [[databasePath]] : []);
      expect(existsSync(requestedPath)).toBe(created);
      if (retryable) {
        expect(admission.failure).toBeUndefined();
        expect(result?.refusalUndefined).toBe(true);
      } else if (transport === "schema") {
        expect(result?.refused).toBe(true);
      }
      expect(release).not.toHaveBeenCalled();
    } finally {
      await admission.finish();
    }
    expect(release).toHaveBeenCalledTimes(
      transport === "schema" && (succeeds || scenario === "lease-held") ? 1 : 0,
    );
  },
);

it.each(["event", "service"] as const)(
  "uses the captured live relay owner for %s delivery",
  async (delivery) => {
    const context = new AsyncLocalStorage<object>();
    const owner = {};
    let live = true;
    let checks = 0;
    const root = tempDirs.make("sqlite-relay-context-");
    const admission = context.run(owner, () =>
      createSqliteDatabaseAdmissionRelay(() => {
        expect(context.getStore()).toBe(owner);
        checks++;
        if (!live) {
          throw new Error("Relay owner retired");
        }
      }),
    );
    const posted = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const worker = new Worker(
      `
      const { MessageChannel, parentPort, workerData } = require("node:worker_threads");
      const posted = new Int32Array(workerData.posted);
      parentPort.on("message", (location) => {
        const { port1, port2 } = new MessageChannel();
        const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
        try {
          workerData.port.postMessage({
            kind: "sqlite-database-admissions", admissions: [], location,
            create: "admitted", port: port2, decision: decision.buffer,
          }, [port2]);
          Atomics.store(posted, 0, 1);
          Atomics.notify(posted, 0);
          if (Atomics.load(decision, 0) === 0) {
            Atomics.wait(decision, 0, 0, 10_000);
          }
          parentPort.postMessage(Atomics.load(decision, 0));
        } finally {
          port1.close();
          port2.close();
        }
      });
      `,
      {
        eval: true,
        execArgv: [],
        workerData: { port: admission.port, posted: posted.buffer },
        transferList: [admission.port],
      },
    );
    async function request(location: string) {
      expect(context.getStore()).toBeUndefined();
      Atomics.store(posted, 0, 0);
      const response = once(worker, "message");
      worker.postMessage(location, []);
      if (delivery === "service") {
        if (Atomics.load(posted, 0) === 0) {
          Atomics.wait(posted, 0, 0, 10_000);
        }
        expect(Atomics.load(posted, 0)).toBe(1);
        admission.service();
      }
      const [decision] = await response;
      return decision;
    }
    try {
      const accepted = path.join(root, "accepted.sqlite");
      expect(await request(accepted)).toBe(1);
      expect(existsSync(accepted)).toBe(true);
      expect(admission.failure).toBeUndefined();
      const acceptedChecks = checks;
      expect(acceptedChecks).toBeGreaterThan(0);
      live = false;
      const refused = path.join(root, "refused.sqlite");
      expect(await request(refused)).toBe(2);
      expect(existsSync(refused)).toBe(false);
      expect(admission.failure).toMatchObject({ message: "Relay owner retired" });
      expect(checks).toBe(acceptedChecks + 1);
    } finally {
      await admission.finish();
      await worker.terminate();
      context.disable();
    }
  },
);
