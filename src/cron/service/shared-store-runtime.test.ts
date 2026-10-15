import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBoundedChildOutput } from "../../../test/helpers/bounded-child-output.js";
import { stopChildProcess } from "../../../test/helpers/stop-child-process.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { cronOwnerHardeningEntrypoints } from "../owner-hardening-runtime.test-support.js";
import { CronService } from "../service.js";
import { createCronStoreHarness } from "../service.test-harness.js";
import { loadCronStore, saveCronJobsStoreChanges, saveCronStore } from "../store.js";
import type { CronJob } from "../types.js";
import * as serviceStore from "./store.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "cron-shared-runtime-" });
const serviceUrl = resolveRuntimeWorkerUrl(cronOwnerHardeningEntrypoints.service);
const schedulerClockUrl = resolveRuntimeWorkerUrl(cronOwnerHardeningEntrypoints.schedulerClock);
const children = new Set<ChildProcess>();

// Join children before the earlier store-cleanup hook releases their state.
afterEach(async () => {
  await Promise.all([...children].map((child) => stopChildProcess(child, 1_000)));
  children.clear();
});

const log = { debug() {}, info() {}, warn() {}, error() {} };

function createDisabledService(storePath: string): CronService {
  return new CronService({
    scheduler: createTestGatewayScheduler(),
    cronEnabled: false,
    storePath,
    log,
    enqueueSystemEvent() {},
    enqueueSessionEvent() {},
    async runIsolatedAgentJob() {
      return { status: "ok" as const, summary: "unused" };
    },
  });
}

async function addCanary(cron: CronService, suffix: string): Promise<CronJob> {
  return await cron.add({
    name: `canary-${suffix}`,
    enabled: true,
    schedule: {
      kind: "every",
      everyMs: 86_400_000,
      anchorMs: Date.now() + 86_400_000,
    },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "run canary" },
  });
}

async function addTarget(cron: CronService, suffix: string): Promise<CronJob> {
  return await cron.add({
    name: `target-${suffix}`,
    enabled: true,
    schedule: { kind: "cron", expr: "0 6 * * *", tz: "UTC" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "target" },
  });
}

const schedulerChildScript = String.raw`
import { CronService } from ${JSON.stringify(serviceUrl.href)};
import { createTestGatewayScheduler } from ${JSON.stringify(schedulerClockUrl.href)};
const runs = JSON.parse(process.env.OPENCLAW_CRON_SHARED_STORE_RUNS);
const log = { debug() {}, info() {}, warn() {}, error() {} };
for (const run of runs) {
  const cron = new CronService({
    scheduler: createTestGatewayScheduler(),
    cronEnabled: true,
    storePath: run.storePath,
    log,
    enqueueSystemEvent() {},
    enqueueSessionEvent() {},
    async runIsolatedAgentJob() {
      return { status: "ok", summary: "scheduler child completed" };
    },
  });
  try {
    await cron.start();
    const result = await cron.run(run.jobId, "force");
    if (!result.ok || !("ran" in result) || result.ran !== true) {
      throw new Error("scheduler child did not complete the expected run " + run.jobId + ": " + JSON.stringify(result));
    }
  } finally {
    cron.stop();
  }
}
`;

function spawnSchedulerChild(script: string, runs: unknown) {
  const startedAt = performance.now();
  const child = spawn(
    process.execPath,
    [...resolveRuntimeWorkerArgv(serviceUrl).slice(0, -1), "--input-type=module", "--eval", script],
    {
      cwd: process.cwd(),
      env: { ...process.env, OPENCLAW_CRON_SHARED_STORE_RUNS: JSON.stringify(runs) },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  children.add(child);
  const stderr = createBoundedChildOutput();
  child.stderr?.on("data", stderr.append);
  const closed = once(child, "close");
  const assertCompleted = () => {
    expect(
      { code: child.exitCode, signal: child.signalCode, stderr: stderr.text() },
      `Scheduler child closed after ${Math.round(performance.now() - startedAt)}ms`,
    ).toEqual({ code: 0, signal: null, stderr: "" });
  };
  return { child, closed, stderr, assertCompleted };
}

async function runSchedulerChild(runs: Array<{ storePath: string; jobId: string }>) {
  const { closed, assertCompleted } = spawnSchedulerChild(schedulerChildScript, runs);
  await closed;
  assertCompleted();
}

describe("scheduler-disabled shared-store mutations", () => {
  it("cannot overwrite runtime committed by a scheduler process", async () => {
    const cases = await Promise.all(
      ["add", "update", "remove", "same-job-update", "state-update"].map(async (operation) => {
        const { storePath } = await makeStorePath();
        const cron = createDisabledService(storePath);
        await cron.start();
        const canary = await addCanary(cron, operation);
        const target = ["update", "remove"].includes(operation)
          ? await addTarget(cron, operation)
          : undefined;
        return { canary, cron, operation, storePath, target };
      }),
    );

    await closeOpenClawStateDatabaseAsync();
    await runSchedulerChild(
      cases.map(({ canary, storePath }) => ({ jobId: canary.id, storePath })),
    );

    for (const testCase of cases) {
      const before = (await loadCronStore(testCase.storePath)).jobs.find(
        (job) => job.id === testCase.canary.id,
      );
      expect(before?.state.lastStatus).toBe("ok");
      expect(before?.state.lastRunAtMs).toEqual(expect.any(Number));

      if (testCase.operation === "add") {
        const added = await addTarget(testCase.cron, "added");
        expect(
          (await loadCronStore(testCase.storePath)).jobs.some((job) => job.id === added.id),
        ).toBe(true);
      } else if (testCase.operation === "update" && testCase.target) {
        await testCase.cron.updateWithPrecondition(
          testCase.target.id,
          { name: "target-updated" },
          () => {},
        );
        expect(
          (await loadCronStore(testCase.storePath)).jobs.find(
            (job) => job.id === testCase.target?.id,
          )?.name,
        ).toBe("target-updated");
      } else if (testCase.operation === "same-job-update") {
        await testCase.cron.update(testCase.canary.id, { name: "canary-updated" });
      } else if (testCase.operation === "state-update") {
        await testCase.cron.update(testCase.canary.id, { state: { consecutiveErrors: 7 } });
      } else if (testCase.target) {
        await testCase.cron.remove(testCase.target.id);
        expect(
          (await loadCronStore(testCase.storePath)).jobs.some(
            (job) => job.id === testCase.target?.id,
          ),
        ).toBe(false);
      }

      const after = (await loadCronStore(testCase.storePath)).jobs.find(
        (job) => job.id === testCase.canary.id,
      );
      expect(after?.state).toEqual(
        testCase.operation === "state-update"
          ? { ...before?.state, consecutiveErrors: 7 }
          : before?.state,
      );
      testCase.cron.stop();
    }
  }, 90_000);

  it("rejects a stale config mutation instead of overwriting its peer", async () => {
    const { storePath } = await makeStorePath();
    const seed = createDisabledService(storePath);
    const target = await addTarget(seed, "config-conflict");
    seed.stop();

    const cron = new CronService({
      scheduler: createTestGatewayScheduler(),
      cronEnabled: false,
      storePath,
      log,
      enqueueSystemEvent() {},
      enqueueSessionEvent() {},
      async runIsolatedAgentJob() {
        return { status: "ok" as const, summary: "unused" };
      },
      async listConfiguredChannels() {
        return [];
      },
    });
    const persist = serviceStore.persistCronJobMutation;
    const admission = vi
      .spyOn(serviceStore, "persistCronJobMutation")
      .mockImplementationOnce(async (params) => {
        const peerStore = await loadCronStore(storePath);
        const peerTarget = peerStore.jobs.find((job) => job.id === target.id);
        if (!peerTarget) {
          throw new Error("missing peer target");
        }
        peerTarget.name = "peer-update";
        await saveCronStore(storePath, peerStore);
        return persist(params);
      });
    try {
      await expect(
        cron.update(target.id, {
          delivery: { mode: "webhook", to: "https://example.com/cron" },
        }),
      ).rejects.toThrow("changed after it was read");
    } finally {
      admission.mockRestore();
    }
    const persisted = (await loadCronStore(storePath)).jobs.find((job) => job.id === target.id);
    expect(persisted?.name).toBe("peer-update");
    expect(persisted?.delivery).toBeUndefined();
    cron.stop();
  });

  it("rejects deleting a row whose config a peer rewrote", async () => {
    const { storePath } = await makeStorePath();
    const cron = createDisabledService(storePath);
    const target = await addTarget(cron, "delete-conflict");
    cron.stop();
    const baseline = await loadCronStore(storePath);
    const peerStore = structuredClone(baseline);
    const peerTarget = peerStore.jobs.find((job) => job.id === target.id);
    if (!peerTarget) {
      throw new Error("missing peer delete target");
    }
    peerTarget.description = "peer rewrite";
    await saveCronStore(storePath, peerStore);

    await expect(
      saveCronJobsStoreChanges(storePath, baseline, { version: 1, jobs: [] }),
    ).rejects.toThrow("changed after it was read");
    const persisted = (await loadCronStore(storePath)).jobs.find((job) => job.id === target.id);
    expect(persisted?.description).toBe("peer rewrite");
  });
});
