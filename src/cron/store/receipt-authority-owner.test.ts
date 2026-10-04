import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { deserialize } from "node:v8";
import { MessageChannel, Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { loseFirstCronMutationReply } from "../../../test/helpers/cron/runtime-mutation.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { revokeCronStandingGrant } from "../../gateway/operator-approval-store.js";
import { acquireFileLock } from "../../infra/file-lock.js";
import { resolveRuntimeProcessEntrypointUrl } from "../../infra/runtime-process-url.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import * as workerCpu from "../../infra/worker-cpu.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { runCronRuntimeMutation } from "../service/runtime-mutation.js";
import { loadCronStore, saveCronStore } from "../store.js";
import type { CronStoredJob } from "../types.js";
import { cronStoreKey } from "./key.js";
import { observeCronReceiptAuthority } from "./receipt-authority-owner.js";
import { finishCronRunReceiptAsync } from "./run-receipt-store.js";
import {
  claimCronRunReceiptForTest,
  makeCronReceiptJob,
} from "./run-receipt-store.test-support.js";
import { prepareCronStoreChanges } from "./save.kernel.js";

afterEach(() => vi.restoreAllMocks());

it("refuses first authority admission for a hardlinked database without SQL or a poisoned owner", async () => {
  await withOpenClawTestState({ label: "cron-authority-hardlink" }, async (fixture) => {
    const database = openOpenClawStateDatabase();
    const alias = fixture.statePath("unsupported-alias.sqlite");
    const storePath = fixture.statePath("cron", "jobs.json");
    const store = { version: 1 as const, jobs: [makeCronReceiptJob("hardlink-refusal")] };
    await fs.link(database.path, alias);
    const sql = observeMainThreadSql();
    sql.calibrate();
    try {
      await expect(saveCronStore(storePath, store)).rejects.toThrow(/offline maintenance/iu);
      sql.expectIdle();
    } finally {
      sql.restore();
      await fs.unlink(alias);
    }
    await saveCronStore(storePath, store);
    expect((await loadCronStore(storePath)).jobs.map((job) => job.id)).toEqual([
      "hardlink-refusal",
    ]);
  });
});

it("closes after failed custody admission while preserving the foreign lock until its owner releases", async () => {
  await withOpenClawTestState({ label: "cron-authority-failed-custody" }, async (fixture) => {
    const database = openOpenClawStateDatabase();
    const context = captureOpenClawStateWorkerContext();
    const foreign = await acquireFileLock(
      `${context.admission.identity.canonicalPath}.cron-authority`,
      {
        retries: { retries: 0, factor: 1, minTimeout: 1, maxTimeout: 1 },
        stale: 0,
        staleRecovery: "remove-if-definitely-stale",
      },
    );
    const lockBytes = await fs.readFile(foreign.lockPath);
    const storePath = fixture.statePath("cron", "jobs.json");
    const store = { version: 1 as const, jobs: [makeCronReceiptJob("custody-retry")] };
    try {
      await expect(saveCronStore(storePath, store)).rejects.toMatchObject({
        code: "file_lock_timeout",
      });
      await expect(closeOpenClawStateDatabaseAsync()).resolves.toBeUndefined();
      expect(database.db.isOpen).toBe(false);
      expect(await fs.readFile(foreign.lockPath)).toEqual(lockBytes);
    } finally {
      await foreign.release();
    }
    await saveCronStore(storePath, store);
    expect((await loadCronStore(storePath)).jobs.map((job) => job.id)).toEqual(["custody-retry"]);
  });
});

async function seed(fixture: OpenClawTestState, partition = "first", enabled = true) {
  const storePath = fixture.statePath("cron", `${partition}.json`);
  const original = makeCronReceiptJob("same-job-id");
  original.enabled = enabled;
  original.payload = { kind: "agentTurn", message: "synthetic", toolsAllow: ["message"] };
  original.scheduledToolPolicy = { version: 1, mode: "trusted" };
  await saveCronStore(storePath, { version: 1, jobs: [original] });
  const job = (await loadCronStore(storePath)).jobs[0]!;
  const handle = claimCronRunReceiptForTest(storePath, job, 1);
  const context = captureOpenClawStateWorkerContext();
  const command = {
    type: "cron.currentReceipt" as const,
    handle,
    includeJob: true,
    includeAvailability: true,
  };
  const read = async () => {
    const snapshot = await executeExistingOpenClawStateRead(
      { path: context.admission.databasePath, env: context.environment },
      command,
      { context, current: true },
    );
    if (!snapshot?.ok || snapshot.type !== command.type) {
      throw new Error("Expected the admitted receipt snapshot");
    }
    return snapshot.facts;
  };
  const observation = observeCronReceiptAuthority(context, command, await read());
  await observation.prepared;
  return {
    job,
    storePath,
    context,
    observation,
    read,
    mutate(next: CronStoredJob, options?: { beforeCommit?: () => void; publish?: () => void }) {
      return runCronRuntimeMutation({
        context,
        type: "cron.mutateJobs",
        input: {
          storeKey: cronStoreKey(storePath),
          changes: prepareCronStoreChanges(
            { version: 1, jobs: [job] },
            { version: 1, jobs: [next] },
          ),
        },
        assertCurrent() {},
        prepare: () => ({
          value: { nowMs: 2 },
          assertCurrent: options?.beforeCommit ?? (() => {}),
        }),
        publish: options?.publish ?? (() => {}),
      });
    },
    async close() {
      observation.release();
      await finishCronRunReceiptAsync({ handle, status: "skipped", finishedAtMs: 3 });
    },
  };
}

/** Pauses the real worker after its commit grant, then after native settlement before its reply. */
async function gateWriter(fixture: OpenClawTestState) {
  await closeOpenClawStateDatabaseAsync();
  const gate = new Int32Array(new SharedArrayBuffer(20));
  Atomics.store(gate, 3, 1);
  Atomics.store(gate, 4, 1);
  const granted = createDeferred();
  const committed = createDeferred();
  const stale = createDeferred();
  const replied = createDeferred();
  const { port1, port2 } = new MessageChannel();
  port1.on("message", (phase) => {
    if (phase === "granted") {
      granted.resolve();
    }
    if (phase === "committed") {
      committed.resolve();
    }
    if (phase === "stale") {
      stale.resolve();
    }
    if (phase === "reply") {
      replied.resolve();
    }
  });
  const preload = fixture.path("authority-worker-gate.mjs");
  await fs.writeFile(
    preload,
    `
    import { deserialize } from "node:v8";
    import { parentPort, workerData, MessagePort } from "node:worker_threads";
    const gate = new Int32Array(workerData.authorityGate);
    const phase = workerData.authorityPhase;
    const post = MessagePort.prototype.postMessage;
    const load = Atomics.load;
    let selected, decision, previousCommit;
    parentPort.on("message", (request) => {
      if (request.type === "execute" && load(gate, 0)) {
        const command = deserialize(request.input);
        if (command.type === "cron.save") selected = request.id;
      }
    });
    MessagePort.prototype.postMessage = function(message, ...args) {
      if (selected && message?.stage === "commit") decision = message.decision;
      if (message?.kind === "native-commit") {
        if (selected) {
          phase.postMessage("committed");
          Atomics.wait(gate, 3, 0);
        }
        if (selected && previousCommit) {
          post.call(this, previousCommit);
          phase.postMessage("stale");
          Atomics.wait(gate, 4, 0);
        }
        post.call(this, message, ...args);
        if (selected) post.call(this, message);
        previousCommit = message;
        return;
      }
      if (this === parentPort && message?.id === selected && message.ok) {
        selected = undefined;
        phase.postMessage("reply");
        Atomics.wait(gate, 2, 0);
      }
      return post.call(this, message, ...args);
    };
    Atomics.load = function(array, index) {
      const result = load(array, index);
      if (decision && array.buffer === decision && result === 1) {
        decision = undefined;
        phase.postMessage("granted");
        Atomics.wait(gate, 1, 0);
      }
      return result;
    };
  `,
  );
  const url = resolveRuntimeProcessEntrypointUrl("sqliteStore").href;
  const create = workerCpu.createCpuTrackedWorker;
  let selected = false;
  let worker: Worker | undefined;
  const factory = vi
    .spyOn(workerCpu, "createCpuTrackedWorker")
    .mockImplementation((filename, options) => {
      if (selected || String(filename) !== url) {
        return create(filename, options);
      }
      selected = true;
      worker = create(filename, {
        ...options,
        execArgv: [...(options?.execArgv ?? []), "--import", pathToFileURL(preload).href],
        workerData: { authorityGate: gate.buffer, authorityPhase: port2 },
        transferList: [port2],
      });
      return worker;
    });
  const release = (index: number) => {
    Atomics.store(gate, index, 1);
    Atomics.notify(gate, index);
  };
  return {
    granted: granted.promise,
    committed: committed.promise,
    stale: stale.promise,
    replied: replied.promise,
    arm: () => Atomics.store(gate, 0, 1),
    commit: () => release(1),
    holdNativeReceipt: () => Atomics.store(gate, 3, 0),
    publish: () => release(3),
    holdStaleReceipt: () => Atomics.store(gate, 4, 0),
    currentReceipt: () => release(4),
    reply: () => release(2),
    async terminate() {
      if (!worker) {
        throw new Error("Expected the fixture's SQLite worker");
      }
      await worker.terminate();
    },
    close() {
      release(1);
      release(2);
      release(3);
      release(4);
      factory.mockRestore();
      port1.close();
      port2.close();
    },
  };
}

it("suspends through commit and reply gaps, ignores stale/duplicate facts, and keeps partitions exact", async ({
  signal,
}) => {
  await withOpenClawTestState({ label: "cron-authority-publication" }, async (fixture) => {
    const gate = await gateWriter(fixture);
    const first = await seed(fixture);
    const second = await seed(fixture, "second");
    let pending: Promise<void> | undefined;
    try {
      expect(first.observation.readForPreparation().messageRevoked).toBe(false);
      const sql = observeMainThreadSql();
      sql.calibrate();
      let checked = false;
      let admission: workerAdmission.SqliteWorkerOperationAdmission | undefined;
      const create = workerAdmission.createSqliteWorkerOperationAdmission;
      const admissions = vi
        .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((admit, attachment) => {
          admission = create((request, grant) => {
            if (request.stage === "commit") {
              sql.clear();
              expect(() => first.observation.readForPreparation()).toThrow("unavailable");
              admit(request, grant);
              sql.expectIdle();
              checked = true;
            } else {
              admit(request, grant);
            }
          }, attachment);
          return admission;
        });
      gate.arm();
      gate.holdStaleReceipt();
      pending = saveCronStore(first.storePath, {
        version: 1,
        jobs: [{ ...first.job, enabled: false }],
      });
      await withinTest(
        awaitGateBeforeSettlement(gate.granted, pending, "Save missed the native commit grant"),
        signal,
      );
      expect(checked).toBe(true);
      expect(() => first.observation.readForPreparation()).toThrow("unavailable");
      gate.commit();
      await withinTest(
        awaitGateBeforeSettlement(gate.stale, pending, "Save missed the stale receipt gate"),
        signal,
      );
      admission!.service();
      expect(() => first.observation.readForPreparation()).toThrow("unavailable");
      gate.currentReceipt();
      await withinTest(
        awaitGateBeforeSettlement(gate.replied, pending, "Save missed the ordinary reply gate"),
        signal,
      );
      expect(() => first.observation.readForPreparation()).toThrow("unavailable");
      expect((await first.read()).job?.enabled).toBe(false);
      admissions.mockRestore();
      sql.restore();
      gate.reply();
      await pending;
      expect(first.observation.readForPreparation()).toMatchObject({
        facts: { job: { enabled: false } },
        messageRevoked: true,
      });
      expect(second.observation.readForPreparation()).toMatchObject({
        facts: { job: { enabled: true } },
        messageRevoked: false,
      });
      await saveCronStore(first.storePath, { version: 1, jobs: [first.job] });
      expect(first.observation.readForPreparation().messageRevoked).toBe(true);
    } finally {
      gate.close();
      await pending?.catch(() => {});
      await first.close();
      await second.close();
    }
  });
});

it("joins a committed writer when database close seals publication admission", async ({
  signal,
}) => {
  await withOpenClawTestState({ label: "cron-authority-database-close" }, async (fixture) => {
    const gate = await gateWriter(fixture);
    const owner = await seed(fixture);
    let pending: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    try {
      gate.arm();
      gate.holdNativeReceipt();
      pending = saveCronStore(owner.storePath, {
        version: 1,
        jobs: [{ ...owner.job, enabled: false }],
      });
      void pending.catch(() => {});
      await withinTest(
        awaitGateBeforeSettlement(gate.granted, pending, "Save missed the commit grant"),
        signal,
      );
      gate.commit();
      await withinTest(
        awaitGateBeforeSettlement(gate.committed, pending, "Save missed native COMMIT"),
        signal,
      );
      closing = closeOpenClawStateDatabaseAsync();
      void closing.catch(() => {});
      expect(() => owner.context.admission.assertCurrent()).toThrow("read admission is closed");
      gate.publish();
      gate.reply();
      await expect(pending).rejects.toThrow("reconciliation failed");
      await withinTest(closing, signal);
      expect(() => owner.observation.readForPreparation()).toThrow();
      expect((await loadCronStore(owner.storePath)).jobs[0]?.enabled).toBe(false);
      await owner.close();
    } finally {
      gate.close();
      await pending?.catch(() => {});
      await closing?.catch(() => {});
      owner.observation.release();
      await gate.terminate();
    }
  });
});

it("rolls a refused commit back without permanently revoking unchanged permission", async () => {
  await withOpenClawTestState({ label: "cron-authority-rollback" }, async (fixture) => {
    const owner = await seed(fixture);
    const publish = vi.fn();
    const refusal = new Error("Synthetic live authority revoked at commit");
    try {
      await expect(
        owner.mutate(
          { ...owner.job, enabled: false },
          {
            beforeCommit() {
              expect(() => owner.observation.readForPreparation()).toThrow("unavailable");
              throw refusal;
            },
            publish,
          },
        ),
      ).rejects.toBe(refusal);
      expect(publish).not.toHaveBeenCalled();
      expect((await loadCronStore(owner.storePath)).jobs[0]?.enabled).toBe(true);
      expect(owner.observation.readForPreparation()).toMatchObject({
        messageRevoked: false,
        sourceRevoked: false,
      });
      await owner.mutate({ ...owner.job, enabled: false });
      expect(owner.observation.readForPreparation().messageRevoked).toBe(true);
    } finally {
      await owner.close();
    }
  });
});

it.each([false, true])(
  "retains the original enabled admission across an enable/disable cycle (%s)",
  async (admittedEnabled) => {
    await withOpenClawTestState({ label: "cron-authority-force-disabled" }, async (fixture) => {
      const owner = await seed(fixture, "first", admittedEnabled);
      try {
        await saveCronStore(owner.storePath, {
          version: 1,
          jobs: [{ ...owner.job, enabled: true }],
        });
        await saveCronStore(owner.storePath, {
          version: 1,
          jobs: [{ ...owner.job, enabled: false }],
        });
        expect(owner.observation.readForPreparation()).toMatchObject({
          facts: { job: { enabled: false } },
          messageRevoked: admittedEnabled,
          sourceRevoked: admittedEnabled,
        });
      } finally {
        await owner.close();
      }
    });
  },
);

it.for(["before commit", "after commit"] as const)(
  "reconciles worker loss %s only after native exit without replay",
  async (phase, { signal }) => {
    await withOpenClawTestState({ label: "cron-authority-worker-loss" }, async (fixture) => {
      const gate = await gateWriter(fixture);
      const owner = await seed(fixture);
      const posts = vi.spyOn(Worker.prototype, "postMessage");
      let pending: Promise<void> | undefined;
      try {
        gate.arm();
        gate.holdNativeReceipt();
        pending = saveCronStore(owner.storePath, {
          version: 1,
          jobs: [{ ...owner.job, enabled: false }],
        });
        void pending.catch(() => {});
        await withinTest(
          awaitGateBeforeSettlement(gate.granted, pending, "Save missed the commit grant"),
          signal,
        );
        if (phase === "after commit") {
          gate.commit();
          await withinTest(
            awaitGateBeforeSettlement(gate.committed, pending, "Save missed native COMMIT"),
            signal,
          );
        }
        expect(() => owner.observation.readForPreparation()).toThrow("unavailable");
        await gate.terminate();
        await expect(pending).rejects.toThrow();
        expect(owner.observation.readForPreparation()).toMatchObject({
          facts: { job: { enabled: phase === "before commit" } },
          messageRevoked: phase === "after commit",
        });
        expect((await loadCronStore(owner.storePath)).jobs[0]?.enabled).toBe(
          phase === "before commit",
        );
        expect(
          posts.mock.calls.filter(([request]) => {
            if (
              !isRecord(request) ||
              request.type !== "execute" ||
              !(request.input instanceof Uint8Array)
            ) {
              return false;
            }
            const command: unknown = deserialize(request.input);
            return isRecord(command) && command.type === "cron.save";
          }),
        ).toHaveLength(1);
      } finally {
        gate.close();
        posts.mockRestore();
        await pending?.catch(() => {});
        await owner.close();
      }
    });
  },
);

it.each(["publication", "business notification"] as const)(
  "retains committed invalidation and never replays after a %s failure",
  async (failureSite) => {
    await withOpenClawTestState(
      { label: "cron-authority-publication-failure" },
      async (fixture) => {
        const owner = await seed(fixture);
        const failure = new Error("Synthetic post-commit publication failure");
        const publish = vi.fn(() => {
          if (failureSite === "business notification") {
            throw failure;
          }
        });
        let installed = 0;
        const observe = workerAdmission.observeSqliteWorkerCommittedFacts;
        const factory = vi
          .spyOn(workerAdmission, "observeSqliteWorkerCommittedFacts")
          .mockImplementation((admission, observer) => {
            observe(
              admission,
              failureSite === "publication"
                ? (receipt) => {
                    observer(receipt);
                    installed++;
                    throw failure;
                  }
                : observer,
            );
          });
        try {
          await expect(owner.mutate({ ...owner.job, enabled: false }, { publish })).rejects.toThrow(
            failureSite === "publication" ? "publication failed" : failure.message,
          );
          expect(publish).toHaveBeenCalledOnce();
          expect(installed).toBe(failureSite === "publication" ? 1 : 0);
          expect(owner.observation.readForPreparation()).toMatchObject({
            facts: { job: { enabled: false } },
            messageRevoked: true,
          });
          expect((await loadCronStore(owner.storePath)).jobs[0]?.enabled).toBe(false);
        } finally {
          factory.mockRestore();
          await owner.close();
        }
      },
    );
  },
);

it("joins lost-reply worker settlement without replay, then retires old observations on reopen", async () => {
  await withOpenClawTestState({ label: "cron-authority-restart" }, async (fixture) => {
    const owner = await seed(fixture);
    const lost = loseFirstCronMutationReply("cron.mutateJobs");
    const publish = vi.fn();
    try {
      await expect(owner.mutate({ ...owner.job, enabled: false }, { publish })).rejects.toThrow();
      await lost.waitForExit();
      expect(lost.wasDropped()).toBe(true);
      expect(lost.attempts).toEqual(["cron.mutateJobs"]);
      expect(publish).toHaveBeenCalledOnce();
      expect(owner.observation.readForPreparation().messageRevoked).toBe(true);
      await lost.close();
      await closeOpenClawStateDatabaseAsync();
      expect(() => owner.observation.readForPreparation()).toThrow();
      expect((await loadCronStore(owner.storePath)).jobs[0]?.enabled).toBe(false);
      expect(() => owner.observation.readForPreparation()).toThrow();
    } finally {
      await lost.close();
      await owner.close();
    }
  });
});

it("enrolls approval mutations in the same physical receipt authority boundary", async () => {
  await withOpenClawTestState({ label: "cron-authority-approval-enrollment" }, async (fixture) => {
    const owner = await seed(fixture);
    const create = workerAdmission.createSqliteWorkerOperationAdmission;
    const stages: string[] = [];
    const factory = vi
      .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((admit, attachment) =>
        create((request, grant) => {
          if (request.stage === "transaction" || request.stage === "commit") {
            expect(() => owner.observation.readForPreparation()).toThrow("unavailable");
            stages.push(request.stage);
          }
          admit(request, grant);
        }, attachment),
      );
    try {
      await expect(
        revokeCronStandingGrant({
          grantId: "absent-synthetic-grant",
          revokedBy: "operator",
          nowMs: 2,
        }),
      ).resolves.toEqual({ outcome: "not-found" });
      expect(stages).toEqual(["transaction", "commit"]);
      expect(owner.observation.readForPreparation().messageRevoked).toBe(false);
    } finally {
      factory.mockRestore();
      await owner.close();
    }
  });
});
