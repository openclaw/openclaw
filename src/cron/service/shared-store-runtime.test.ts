import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createBoundedChildOutput } from "../../../test/helpers/bounded-child-output.js";
import { stopChildProcess } from "../../../test/helpers/stop-child-process.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import type { SqliteWorkerRequest } from "../../infra/sqlite-worker-contract.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { cronOwnerHardeningEntrypoints } from "../owner-hardening-runtime.test-support.js";
import { CronService } from "../service.js";
import { createCronStoreHarness } from "../service.test-harness.js";
import { loadCronStore, saveCronJobsStoreChanges, saveCronStore } from "../store.js";
import type { CronJobCreate } from "../types.js";
import type { CronServiceDeps } from "./state.js";
import * as serviceStore from "./store.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "cron-shared-runtime-" });
const serviceUrl = resolveRuntimeWorkerUrl(cronOwnerHardeningEntrypoints.service);
const schedulerClockUrl = resolveRuntimeWorkerUrl(cronOwnerHardeningEntrypoints.schedulerClock);
const children = new Set<ChildProcess>();

// Join children before the earlier store-cleanup hook releases their state.
afterEach(async () => {
  await Promise.all([...children].map((child) => stopChildProcess(child, 1_000)));
  children.clear();
  vi.restoreAllMocks();
});

const log = { debug() {}, info() {}, warn() {}, error() {} };

function createDisabledService(storePath: string, extra: Partial<CronServiceDeps> = {}) {
  return new CronService({
    scheduler: createTestGatewayScheduler(),
    cronEnabled: false,
    storePath,
    log,
    enqueueSystemEvent() {},
    requestHeartbeat() {},
    runIsolatedAgentJob: async () => ({ status: "ok", summary: "unused" }),
    ...extra,
  });
}

function addJob(cron: CronService, name: string, target = false) {
  return cron.add({
    name,
    enabled: true,
    schedule: target
      ? { kind: "cron", expr: "0 6 * * *", tz: "UTC" }
      : { kind: "every", everyMs: 86_400_000, anchorMs: Date.now() + 86_400_000 },
    sessionTarget: target ? "main" : "isolated",
    wakeMode: "next-heartbeat",
    payload: target
      ? { kind: "systemEvent", text: "target" }
      : { kind: "agentTurn", message: "run canary" },
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
    requestHeartbeat() {},
    runIsolatedAgentJob: async () => ({ status: "ok", summary: "scheduler child completed" }),
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

async function runSchedulerChild(runs: Array<{ storePath: string; jobId: string }>) {
  const child = spawn(
    process.execPath,
    [
      ...resolveRuntimeWorkerArgv(serviceUrl).slice(0, -1),
      "--input-type=module",
      "--eval",
      schedulerChildScript,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, OPENCLAW_CRON_SHARED_STORE_RUNS: JSON.stringify(runs) },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  children.add(child);
  const stderr = createBoundedChildOutput();
  child.stderr?.on("data", stderr.append);
  await once(child, "close");
  expect([child.exitCode, child.signalCode, stderr.text()]).toEqual([0, null, ""]);
}

const readJob = async (storePath: string, id: string) =>
  (await loadCronStore(storePath)).jobs.find((job) => job.id === id);

async function seedTarget(suffix: string) {
  const { storePath } = await makeStorePath();
  const cron = createDisabledService(storePath);
  const target = await addJob(cron, suffix, true);
  cron.stop();
  return { storePath, target };
}

async function rewritePeer(storePath: string, id: string, patch: Partial<CronJobCreate>) {
  const store = await loadCronStore(storePath);
  const job = store.jobs.find((candidate) => candidate.id === id);
  assert(job, "missing peer target");
  Object.assign(job, patch);
  await saveCronStore(storePath, store);
}

it("cannot overwrite runtime committed by a scheduler process", async () => {
  const cases = await Promise.all(
    ["add", "update", "remove", "same-job-update", "state-update"].map(async (operation) => {
      const { storePath } = await makeStorePath();
      const cron = createDisabledService(storePath);
      await cron.start();
      const canary = await addJob(cron, `canary-${operation}`);
      const target = ["update", "remove"].includes(operation)
        ? await addJob(cron, operation, true)
        : undefined;
      return { canary, cron, operation, storePath, target };
    }),
  );

  await closeOpenClawStateDatabaseAsync();
  await runSchedulerChild(cases.map(({ canary, storePath }) => ({ jobId: canary.id, storePath })));

  for (const { storePath, canary, cron, operation, target } of cases) {
    const before = await readJob(storePath, canary.id);
    expect(before?.state).toMatchObject({ lastStatus: "ok", lastRunAtMs: expect.any(Number) });
    if (operation === "add") {
      const added = await addJob(cron, "added", true);
      expect(await readJob(storePath, added.id)).toBeDefined();
    } else if (operation === "update" && target) {
      await cron.updateWithPrecondition(target.id, { name: "target-updated" }, () => {});
      expect((await readJob(storePath, target.id))?.name).toBe("target-updated");
    } else if (operation === "same-job-update") {
      await cron.update(canary.id, { name: "canary-updated" });
    } else if (operation === "state-update") {
      await cron.update(canary.id, { state: { consecutiveErrors: 7 } });
    } else if (target) {
      await cron.remove(target.id);
      expect(await readJob(storePath, target.id)).toBeUndefined();
    }
    const after = await readJob(storePath, canary.id);
    expect(after?.state).toEqual(
      operation === "state-update" ? { ...before?.state, consecutiveErrors: 7 } : before?.state,
    );
    cron.stop();
  }
}, 90_000);

it("rejects a stale config mutation instead of overwriting its peer", async () => {
  const { storePath, target } = await seedTarget("config-conflict");
  const cron = createDisabledService(storePath, { listConfiguredChannels: async () => [] });
  const persist = serviceStore.persistCronJobMutation;
  vi.spyOn(serviceStore, "persistCronJobMutation").mockImplementationOnce(async (params) => {
    await rewritePeer(storePath, target.id, { name: "peer-update" });
    return persist(params);
  });
  await expect(
    cron.update(target.id, {
      delivery: { mode: "webhook", to: "https://example.com/cron" },
    }),
  ).rejects.toThrow("changed after it was read");
  const persisted = await readJob(storePath, target.id);
  expect(persisted?.name).toBe("peer-update");
  expect(persisted?.delivery).toBeUndefined();
  cron.stop();
});

it("updates a resident job with one worker mutation", async () => {
  const { storePath } = await makeStorePath();
  const cron = createDisabledService(storePath, { cronEnabled: true });
  const target = await addJob(cron, "resident", true);
  const commands: string[] = [];
  // oxlint-disable-next-line typescript/unbound-method -- Preserve the real Worker receiver.
  const nativePost = Worker.prototype.postMessage;
  const post = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    request: SqliteWorkerRequest,
    transferList,
  ) {
    const command: unknown = request.type === "execute" ? deserialize(request.input) : undefined;
    if (isRecord(command) && typeof command.type === "string") {
      commands.push(command.type);
    }
    nativePost.call(this, request, transferList);
  });
  try {
    const updated = await cron.update(target.id, { name: "resident-updated" });
    expect(updated.name).toBe("resident-updated");
    expect(commands).toEqual(["cron.mutateJobs"]);
    post.mockRestore();
    expect((await readJob(storePath, target.id))?.name).toBe("resident-updated");
  } finally {
    post.mockRestore();
    cron.stop();
  }
});

it("prepares from a peer publication received during channel validation", async () => {
  const { storePath, target } = await seedTarget("validation-publication");
  const cron = createDisabledService(storePath, {
    listConfiguredChannels: async () => {
      await rewritePeer(storePath, target.id, { name: "peer-update" });
      return [];
    },
  });
  try {
    await cron.update(target.id, {
      delivery: { mode: "webhook", to: "https://example.com/cron" },
    });
    expect(await readJob(storePath, target.id)).toMatchObject({
      name: "peer-update",
      delivery: { mode: "webhook", to: "https://example.com/cron" },
    });
  } finally {
    cron.stop();
  }
});

it("rejects deleting a row whose config a peer rewrote", async () => {
  const { storePath, target } = await seedTarget("delete-conflict");
  const baseline = await loadCronStore(storePath);
  await rewritePeer(storePath, target.id, { description: "peer rewrite" });
  await expect(
    saveCronJobsStoreChanges(storePath, baseline, { version: 1, jobs: [] }),
  ).rejects.toThrow("changed after it was read");
  expect((await readJob(storePath, target.id))?.description).toBe("peer rewrite");
});
