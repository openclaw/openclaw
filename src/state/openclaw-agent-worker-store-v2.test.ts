import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { openSqliteWorkerStore } from "../infra/sqlite-worker-store.js";
import type { FixtureOperations } from "../infra/sqlite-worker-store.test-support.js";
import { closeOpenClawAgentDatabasesAsync } from "./openclaw-agent-db-lifecycle.js";
import { revokeAgentDatabaseResources } from "./openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase as openDatabase,
} from "./openclaw-agent-db.js";
import type { OpenClawAgentDatabaseExecution } from "./openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution as captureExecution } from "./openclaw-agent-execution.js";
import {
  openOpenClawAgentSqliteWorkerStoreV2 as openWorkerStore,
  type OpenClawAgentSqliteWorkerStoreV2,
} from "./openclaw-agent-worker-store.js";
import { agentWorkerStoreFixtureEntrypoint } from "./openclaw-agent-worker-store.runtime.test-support.js";
import type { AgentWorkerFixtureOperations } from "./openclaw-agent-worker-store.test-support.js";
import { runOpenClawAgentWorkerWrite as runWorkerWrite } from "./openclaw-agent-write-admission.js";

const allow = () => {};
const append = (value: string) => ({ type: "append" as const, input: { value } });

const workers = new Set<OpenClawAgentSqliteWorkerStoreV2<AgentWorkerFixtureOperations>>();
const executions = new Set<OpenClawAgentDatabaseExecution>();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await Promise.all([...workers].map((worker) => worker.close()));
    workers.clear();
    await Promise.all([...executions].map((execution) => execution.release()));
    executions.clear();
    await closeOpenClawAgentDatabasesAsync(root);
    closeOpenClawAgentDatabasesForTest();
    cleanup();
  }),
);
let root: string;
let options: { agentId: string; path: string };

async function openWorker(
  workerOptions: Partial<Parameters<typeof openWorkerStore>[2]> = {},
  source: Parameters<typeof openWorkerStore>[1] = { version: 2, assertCurrent: allow },
) {
  const worker = await openWorkerStore<AgentWorkerFixtureOperations>(options, source, {
    moduleUrl: resolveRuntimeWorkerUrl(agentWorkerStoreFixtureEntrypoint),
    input: undefined,
    ...workerOptions,
  });
  workers.add(worker);
  return worker;
}

function observeTerminal(worker: OpenClawAgentSqliteWorkerStoreV2<AgentWorkerFixtureOperations>) {
  const notify = vi.fn();
  const terminal = new Promise<void>((resolve) => {
    worker.terminalSignal.addEventListener(
      "abort",
      () => {
        notify(worker.terminalSignal.reason);
        resolve();
      },
      { once: true },
    );
  });
  return { notify, terminal };
}

beforeEach(() => {
  root = fs.realpathSync(tempDirs.make("agent-worker-v2-"));
  options = { agentId: "main", path: path.join(root, "agent.sqlite") };
});

it.each([false, true])(
  "V2 preserves absence and prepares alongside a captured creator: %s",
  async (concurrentCreator) => {
    if (concurrentCreator) {
      executions.add(
        captureExecution(options, {
          expectedCreationIdentity: readDatabasePathIdentitySync(options.path),
        }),
      );
    }
    const worker = await openWorker();
    if (!concurrentCreator) {
      expect(
        await worker.executeExisting({ type: "inspect", input: undefined }, allow),
      ).toBeUndefined();
    }
    expect(fs.existsSync(options.path)).toBe(false);
    await worker.prepare();
    expect(fs.existsSync(options.path)).toBe(true);
    const { db } = openDatabase(options);
    db.exec("CREATE TABLE worker_proof (value TEXT NOT NULL)");
    expect(await worker.execute(append("worker-owned"), allow)).toBeGreaterThan(0);
    expect(db.prepare("SELECT value FROM worker_proof").all()).toEqual([{ value: "worker-owned" }]);
    await worker.close();
    expect(worker.terminalSignal.aborted).toBe(false);
    await expect(worker.prepare()).rejects.toThrow("closed");
    await expect(worker.execute({ type: "inspect", input: undefined }, allow)).rejects.toThrow(
      "closed",
    );
  },
);

it("V2 reports owner revocation and admits the next request through a fresh worker", async ({
  signal,
}) => {
  const { db } = openDatabase(options);
  db.exec("CREATE TABLE worker_proof (value TEXT NOT NULL)");
  let current = true;
  const worker = await openWorker(
    {
      onAdmitted(request) {
        if (request.stage === "transaction") {
          current = false;
        }
      },
    },
    {
      version: 2,
      assertCurrent() {
        if (!current) {
          throw new Error("V2 owner revoked");
        }
      },
    },
  );
  const observed = observeTerminal(worker);
  await expect(worker.execute(append("refused"), allow)).rejects.toThrow("V2 owner revoked");
  await withinTest(observed.terminal, signal);
  expect(observed.notify).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
  expect(worker.terminalSignal.reason).toMatchObject({ message: "V2 owner revoked" });
  expect(db.prepare("SELECT value FROM worker_proof").all()).toEqual([]);
  await expect(worker.execute(append("still refused"), allow)).rejects.toThrow();
  const recovered = await openWorker();
  expect(await recovered.execute(append("readmitted"), allow)).toBeGreaterThan(0);
  expect(db.prepare("SELECT value FROM worker_proof").all()).toEqual([{ value: "readmitted" }]);
});

it.for(["crash", "exit"] as const)(
  "V2 settles requests and reports terminal loss after worker %s",
  async (failure, { signal }) => {
    const { db } = openDatabase(options);
    db.exec("CREATE TABLE worker_proof (value TEXT NOT NULL)");
    const worker = await openWorker();
    const observed = observeTerminal(worker);
    const failed = worker.execute({ type: "failWorker", input: failure }, allow);
    const queued = worker.execute(append("must not write"), allow);
    const results = await withinTest(Promise.allSettled([failed, queued]), signal);
    expect(results).toEqual([
      { status: "rejected", reason: expect.any(Error) },
      { status: "rejected", reason: expect.any(Error) },
    ]);
    await withinTest(observed.terminal, signal);
    expect(observed.notify).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
    expect(worker.terminalSignal.aborted).toBe(true);
    const reason: unknown = worker.terminalSignal.reason;
    expect(reason).toMatchObject({ message: expect.stringMatching(/worker|exit|crash/i) });
    await expect(worker.prepare()).rejects.toThrow();
    await expect(worker.execute(append("still refused"), allow)).rejects.toThrow();

    const recovered = await openWorker();
    expect(await recovered.execute(append("readmitted"), allow)).toBeGreaterThan(0);
    expect(db.prepare("SELECT value FROM worker_proof").all()).toEqual([{ value: "readmitted" }]);
    await worker.close();
    expect(worker.terminalSignal.reason).toBe(reason);
    expect(observed.notify).toHaveBeenCalledTimes(1);
  },
);

it("V2 reports resource revocation only after its accepted write settles", async ({ signal }) => {
  const { db } = openDatabase(options);
  db.exec("CREATE TABLE worker_proof (value TEXT NOT NULL)");
  let revoked: Promise<void> | undefined;
  let terminalBeforePublication: boolean | undefined;
  const worker = await openWorker();
  const observed = observeTerminal(worker);
  const committedAtNotification: unknown[] = [];
  worker.terminalSignal.addEventListener("abort", () => {
    committedAtNotification.push(db.prepare("SELECT value FROM worker_proof").all());
  });
  const accepted = worker.run(async (scope) => {
    const result = await scope.execute(append("accepted"));
    // The native COMMIT is acknowledged while the enclosing publication is still pending.
    revoked = Promise.all(revokeAgentDatabaseResources(options)).then(allow);
    void revoked.catch(allow);
    terminalBeforePublication = worker.terminalSignal.aborted;
    return result;
  }, allow);
  expect(await withinTest(accepted, signal)).toBeGreaterThan(0);
  await withinTest(observed.terminal, signal);
  await revoked;
  expect(terminalBeforePublication).toBe(false);
  expect(committedAtNotification).toEqual([[{ value: "accepted" }]]);
  expect(observed.notify).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
  await expect(worker.execute(append("refused"), allow)).rejects.toThrow();
  const recovered = await openWorker();
  expect(await recovered.execute(append("readmitted"), allow)).toBeGreaterThan(0);
  expect(db.prepare("SELECT value FROM worker_proof ORDER BY rowid").all()).toEqual([
    { value: "accepted" },
    { value: "readmitted" },
  ]);
});

it("attributes cold worker reservations to bounded commands and actual outer transactions", async () => {
  const reservationRoot = tempDirs.make("openclaw-reservation-attribution-");
  const reservationOptions = {
    agentId: "fixture",
    path: path.join(reservationRoot, "agent.sqlite"),
  };
  const diagnostics = channel("openclaw.agent-database.reservation");
  const observations: unknown[] = [];
  const observe = (message: unknown) => observations.push(message);
  diagnostics.subscribe(observe);
  try {
    await runWorkerWrite(reservationOptions, async () => {
      const store = await openSqliteWorkerStore<FixtureOperations>({
        moduleUrl: new URL("../infra/sqlite-worker-store.test-support.ts", import.meta.url),
        databasePath: reservationOptions.path,
        input: undefined,
      });
      try {
        await store.execute({
          type: "database.domain.execute",
          input: {
            command: {
              type: "session.actor.appendTranscriptEvent",
              input: { value: "synthetic-private-committed" },
            },
          },
        });
        await expect(
          store.execute({
            type: "database.domain.execute",
            input: {
              command: {
                type: "session.private-customer-command",
                input: { value: "synthetic-private-rolled-back" },
              },
            },
          }),
        ).rejects.toThrow("Fixture transaction rolled back");
        expect(await store.execute({ type: "read", input: undefined })).toEqual([
          "synthetic-private-committed",
        ]);
      } finally {
        await store.close();
      }
    });
    expect(observations).toEqual([
      expect.objectContaining({
        operation: "worker",
        workerOperations: [
          "open",
          "session.actor.appendTranscriptEvent",
          "sessions",
          "execute",
          "close",
        ],
        transactionCount: 2,
      }),
    ]);
    const serialized = JSON.stringify(observations);
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain(reservationOptions.path);
  } finally {
    diagnostics.unsubscribe(observe);
  }
});
