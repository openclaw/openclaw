import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
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
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { revokeCronStandingGrant } from "../../gateway/operator-approval-store.js";
import { acquireFileLock } from "../../infra/file-lock.js";
import { resolveRuntimeProcessEntrypointUrl } from "../../infra/runtime-process-url.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import * as workerCpu from "../../infra/worker-cpu.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { captureEffectAuthority, withEffectPreparation } from "../../shared/effect-authority.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { cronOwnerHardeningEntrypoints } from "../owner-hardening-runtime.test-support.js";
import { runCronRuntimeMutation } from "../service/runtime-mutation.js";
import { loadCronStore, saveCronStore } from "../store.js";
import type { CronStoredJob } from "../types.js";
import { cronStoreKey } from "./key.js";
import { CronReceiptAuthorityRefusal } from "./receipt-authority-error.js";
import {
  beginCronReceiptAuthorityClose,
  drainCronReceiptAuthority,
  observeCronReceiptAuthority,
  startCronReceiptAuthorityHost,
} from "./receipt-authority-owner.js";
import { finishCronRunReceiptAsync } from "./run-receipt-store.js";
import {
  claimCronRunReceiptForTest,
  makeCronReceiptJob,
} from "./run-receipt-store.test-support.js";
import { prepareCronStoreChanges } from "./save.kernel.js";

afterEach(() => vi.restoreAllMocks());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("reports rejected native settlement without releasing database or authority custody", async ({
  signal,
}) => {
  const stateDir = tempDirs.make("cron-native-custody-");
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      ...resolveRuntimeWorkerArgv(
        resolveRuntimeWorkerUrl(cronOwnerHardeningEntrypoints.receiptAuthorityFailure),
      ),
      stateDir,
    ],
    { timeout: 30_000, killSignal: "SIGKILL", signal },
  );
  expect(stdout).toContain("retained-native-custody");
});

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
    mutate(next: CronStoredJob, options?: { beforeDispatch?: () => void; publish?: () => void }) {
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
        assertCurrent: options?.beforeDispatch ?? (() => {}),
        snapshot: { nowMs: 2 },
        publish: options?.publish ?? (() => {}),
      });
    },
    async close() {
      observation.release();
      await finishCronRunReceiptAsync({ handle, status: "skipped", finishedAtMs: 3 });
    },
  };
}

/** Pauses the real worker before execution and after commit, before its successful reply. */
async function gateWriter(fixture: OpenClawTestState) {
  await closeOpenClawStateDatabaseAsync();
  const gate = new Int32Array(new SharedArrayBuffer(12));
  const submitted = createDeferred();
  const committed = createDeferred();
  const { port1, port2 } = new MessageChannel();
  port1.on("message", (phase) => {
    if (phase === "submitted") {
      submitted.resolve();
    }
    if (phase === "committed") {
      committed.resolve();
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
    let selected;
    parentPort.on("message", (request) => {
      if (request.type === "execute" && Atomics.load(gate, 0)) {
        const command = deserialize(request.input);
        if (command.type === "cron.save") {
          Atomics.store(gate, 0, 0);
          selected = request.id;
          phase.postMessage("submitted");
          Atomics.wait(gate, 1, 0);
        }
      }
    });
    MessagePort.prototype.postMessage = function(message, ...args) {
      if (this === parentPort && message?.id === selected && message.ok === true) {
        selected = undefined;
        phase.postMessage("committed");
        Atomics.wait(gate, 2, 0);
      }
      return post.call(this, message, ...args);
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
    submitted: submitted.promise,
    committed: committed.promise,
    arm: () => Atomics.store(gate, 0, 1),
    execute: () => release(1),
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
      factory.mockRestore();
      port1.close();
      port2.close();
    },
  };
}

it("suspends authority until a committed reply and keeps partitions exact", async ({ signal }) => {
  await withOpenClawTestState({ label: "cron-authority-publication" }, async (fixture) => {
    const gate = await gateWriter(fixture);
    const first = await seed(fixture);
    const second = await seed(fixture, "second");
    let pending: Promise<void> | undefined;
    try {
      expect(first.observation.readForPreparation().messageRevoked).toBe(false);
      const sql = observeMainThreadSql();
      sql.calibrate();
      gate.arm();
      pending = saveCronStore(first.storePath, {
        version: 1,
        jobs: [{ ...first.job, enabled: false }],
      });
      await withinTest(
        awaitGateBeforeSettlement(gate.submitted, pending, "Save missed the execution gate"),
        signal,
      );
      sql.clear();
      expect(() => first.observation.readForPreparation()).toThrow("unavailable");
      sql.expectIdle();
      gate.execute();
      await withinTest(
        awaitGateBeforeSettlement(gate.committed, pending, "Save missed the committed reply gate"),
        signal,
      );
      expect(() => first.observation.readForPreparation()).toThrow("unavailable");
      sql.expectIdle();
      expect((await first.read()).job?.enabled).toBe(false);
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
      pending = saveCronStore(owner.storePath, {
        version: 1,
        jobs: [{ ...owner.job, enabled: false }],
      });
      void pending.catch(() => {});
      await withinTest(
        awaitGateBeforeSettlement(gate.submitted, pending, "Save missed the execution gate"),
        signal,
      );
      gate.execute();
      await withinTest(
        awaitGateBeforeSettlement(gate.committed, pending, "Save missed the committed reply gate"),
        signal,
      );
      closing = closeOpenClawStateDatabaseAsync();
      void closing.catch(() => {});
      expect(() => owner.context.admission.assertCurrent()).toThrow("read admission is closed");
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

it("refuses a stale caller before dispatch without revoking unchanged permission", async () => {
  await withOpenClawTestState({ label: "cron-authority-rollback" }, async (fixture) => {
    const owner = await seed(fixture);
    const publish = vi.fn();
    const refusal = new Error("Synthetic live authority revoked before dispatch");
    try {
      await expect(
        owner.mutate(
          { ...owner.job, enabled: false },
          {
            beforeDispatch() {
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
        const use = owner.observation.acquireUse({ permission: "message", assertCurrent() {} });
        if (admittedEnabled) {
          await expect(use).rejects.toMatchObject({ reason: "permission" });
        } else {
          (await use).initiate(() => undefined);
        }
      } finally {
        await owner.close();
      }
    });
  },
);

it.for(["before execution", "after commit"] as const)(
  "reconciles worker loss %s only after native exit without replay",
  async (phase, { signal }) => {
    await withOpenClawTestState({ label: "cron-authority-worker-loss" }, async (fixture) => {
      const gate = await gateWriter(fixture);
      const owner = await seed(fixture);
      const posts = vi.spyOn(Worker.prototype, "postMessage");
      let pending: Promise<void> | undefined;
      try {
        gate.arm();
        pending = saveCronStore(owner.storePath, {
          version: 1,
          jobs: [{ ...owner.job, enabled: false }],
        });
        void pending.catch(() => {});
        await withinTest(
          awaitGateBeforeSettlement(gate.submitted, pending, "Save missed the execution gate"),
          signal,
        );
        if (phase === "after commit") {
          gate.execute();
          await withinTest(
            awaitGateBeforeSettlement(
              gate.committed,
              pending,
              "Save missed the committed reply gate",
            ),
            signal,
          );
        }
        expect(() => owner.observation.readForPreparation()).toThrow("unavailable");
        await gate.terminate();
        await expect(pending).rejects.toThrow();
        expect(owner.observation.readForPreparation()).toMatchObject({
          facts: { job: { enabled: phase === "before execution" } },
          messageRevoked: phase === "after commit",
        });
        expect((await loadCronStore(owner.storePath)).jobs[0]?.enabled).toBe(
          phase === "before execution",
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

it("retains committed invalidation and never replays after a business notification failure", async () => {
  await withOpenClawTestState({ label: "cron-authority-publication-failure" }, async (fixture) => {
    const owner = await seed(fixture);
    const failure = new Error("Synthetic post-commit publication failure");
    const publish = vi.fn(() => {
      throw failure;
    });
    try {
      await expect(owner.mutate({ ...owner.job, enabled: false }, { publish })).rejects.toThrow(
        failure.message,
      );
      expect(publish).toHaveBeenCalledOnce();
      expect(owner.observation.readForPreparation()).toMatchObject({
        facts: { job: { enabled: false } },
        messageRevoked: true,
      });
      expect((await loadCronStore(owner.storePath)).jobs[0]?.enabled).toBe(false);
    } finally {
      await owner.close();
    }
  });
});

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
      expect(publish).not.toHaveBeenCalled();
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

it("holds message authority through preparation and releases at initiation before the response", async () => {
  await withOpenClawTestState({ label: "cron-held-message-use" }, async (fixture) => {
    const owner = await seed(fixture);
    const providerResponse = createDeferred<string>();
    const options = { permission: "message" as const, assertCurrent() {} };
    const retained = await withEffectPreparation(
      () => owner.observation.acquireUse(options),
      async () => {
        const effect = captureEffectAuthority();
        await effect.initiate(() => undefined);
        return effect;
      },
    );
    const lateEffect = vi.fn();
    await expect(retained.initiate(lateEffect)).rejects.toThrow(
      "Effect authority is no longer active",
    );
    expect(lateEffect).not.toHaveBeenCalled();
    // The operation ended; the same receipt still admits a fresh use below.
    const use = await owner.observation.acquireUse(options);
    let acknowledged = false;
    const saving = saveCronStore(owner.storePath, {
      version: 1,
      jobs: [{ ...owner.job, enabled: false }],
    }).then(() => {
      acknowledged = true;
    });
    const next = owner.observation.acquireUse(options);
    void next.catch(() => {});
    try {
      // A separate worker read remains possible while an authority mutation waits behind use.
      expect((await owner.read()).job?.enabled).toBe(true);
      expect(acknowledged).toBe(false);
      const sql = observeMainThreadSql();
      sql.calibrate();
      let response: Promise<string>;
      try {
        use.assertCurrent();
        response = use.initiate(() => {
          expect(() => use.initiate(() => undefined)).toThrow(CronReceiptAuthorityRefusal);
          return providerResponse.promise;
        });
        sql.expectIdle();
      } finally {
        sql.restore();
      }
      await saving;
      expect(acknowledged).toBe(true);
      expect(() => use.assertCurrent()).toThrow(CronReceiptAuthorityRefusal);
      await expect(next).rejects.toMatchObject({ reason: "permission" });
      await saveCronStore(owner.storePath, { version: 1, jobs: [owner.job] });
      await expect(owner.observation.acquireUse(options)).rejects.toMatchObject({
        reason: "permission",
      });
      providerResponse.resolve("accepted");
      await expect(response).resolves.toBe("accepted");
    } finally {
      use.release();
      providerResponse.resolve("cleanup");
      await Promise.allSettled([saving, next]);
      await owner.close();
    }
  });
});

it.each(["mutation", "other database"] as const)(
  "retires uses on close while joining accepted %s work",
  async (kind) => {
    await withOpenClawTestState({ label: "cron-held-use-close" }, async (fixture) => {
      const owner = await seed(fixture);
      const options = { permission: "execution" as const, assertCurrent() {} };
      const use = await owner.observation.acquireUse(options);
      const entered = createDeferred();
      const settle = createDeferred();
      const scheduler = new AsyncWorkScope();
      const work = async (assertCurrent: () => void) => {
        assertCurrent();
        if (kind === "other database") {
          expect(owner.observation.readForPreparation().messageRevoked).toBe(false);
        }
        expect(getAsyncWorkSignal()).not.toBe(scheduler.signal);
        entered.resolve();
        await settle.promise;
        expect(getAsyncWorkSignal()?.aborted).toBe(false);
        expect(() => assertCurrent()).toThrow(CronReceiptAuthorityRefusal);
        return "settled";
      };
      const borrowing = scheduler.track(() =>
        kind === "mutation"
          ? use.mutate((mutation) => work(mutation.assertCurrent))
          : use.persist(work),
      );
      await entered.promise;
      const queued = owner.observation.acquireUse(options);
      void queued.catch(() => {});
      let drained = false;
      try {
        expect(() => use.initiate(() => undefined)).toThrow(/busy/);
        beginCronReceiptAuthorityClose();
        scheduler.beginClose();
        const draining = drainCronReceiptAuthority().then(() => {
          drained = true;
        });
        expect(() => use.assertCurrent()).toThrow(CronReceiptAuthorityRefusal);
        await expect(owner.observation.acquireUse(options)).rejects.toMatchObject({
          reason: "retired",
        });
        expect(drained).toBe(false);
        settle.resolve();
        await expect(borrowing).resolves.toBe("settled");
        await expect(queued).rejects.toMatchObject({ reason: "retired" });
        await draining;
        expect(drained).toBe(true);
      } finally {
        settle.resolve();
        use.release();
        await Promise.allSettled([borrowing, queued]);
        await owner.close();
        await closeOpenClawStateDatabaseAsync();
        startCronReceiptAuthorityHost();
      }
    });
  },
);

it.each([false, true])(
  "joins native initiation acknowledgement after a throwing launch: %s",
  async (throws) => {
    await withOpenClawTestState({ label: "cron-native-initiation-close" }, async (fixture) => {
      const owner = await seed(fixture);
      const nativeReady = createDeferred();
      const use = await owner.observation.acquireUse({
        permission: "execution",
        assertCurrent() {},
      });
      let drained = false;
      let draining: Promise<void> | undefined;
      try {
        const initiate = () =>
          use.initiate(() => {
            if (throws) {
              throw new Error("launch rejected");
            }
          }, nativeReady.promise);
        if (throws) {
          expect(initiate).toThrow("launch rejected");
        } else {
          initiate();
        }
        expect(() => use.initiate(() => undefined)).toThrow(CronReceiptAuthorityRefusal);
        use.release();
        expect(() => use.assertCurrent()).toThrow(CronReceiptAuthorityRefusal);
        beginCronReceiptAuthorityClose();
        draining = drainCronReceiptAuthority().then(() => {
          drained = true;
        });
        await owner.read();
        expect(drained).toBe(false);
        nativeReady.resolve();
        await draining;
        expect(drained).toBe(true);
      } finally {
        nativeReady.resolve();
        await draining;
        use.release();
        await owner.close();
        await closeOpenClawStateDatabaseAsync();
        startCronReceiptAuthorityHost();
      }
    });
  },
);

it("enrolls approval mutations in the same physical receipt authority boundary", async () => {
  await withOpenClawTestState({ label: "cron-authority-approval-enrollment" }, async (fixture) => {
    const owner = await seed(fixture);
    const stages: string[] = [];
    const factory = probe.admission(workerAdmission, (request, grant, admit) => {
      if (request.stage === "transaction" || request.stage === "commit") {
        expect(() => owner.observation.readForPreparation()).toThrow("unavailable");
        stages.push(request.stage);
      }
      admit(request, grant);
    });
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

it("keeps independently borrowed cron custody after the creating maintenance scope closes", async () => {
  await withOpenClawTestState({ label: "cron-authority-maintenance-borrow" }, async (fixture) => {
    const maintenance = createOpenClawDatabaseMaintenanceScope();
    const owner = await maintenance.run(() => seed(fixture));
    try {
      await loadCronStore(owner.storePath);
      await maintenance.close();
      expect(owner.observation.readForPreparation().messageRevoked).toBe(false);
      await saveCronStore(owner.storePath, {
        version: 1,
        jobs: [{ ...owner.job, enabled: false }],
      });
      expect(owner.observation.readForPreparation().messageRevoked).toBe(true);
    } finally {
      await maintenance.close();
      await owner.close();
    }
  });
});
