import { afterAll, beforeAll, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { executeOpenClawStateWorker } from "../../state/openclaw-state-worker-store.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { MAX_ACTIVE_PLUGIN_COMMAND_SCHEDULES_PER_PARENT } from "../plugin-command-schedule.js";
import { pluginCommandSchedule } from "../plugin-command-schedule.test-support.js";
import { PLUGIN_COMMAND_SCHEDULE_MESSAGE } from "../plugin-command-schedule.types.js";
import type { CronJobCreate, CronStoredJob } from "../types.js";
import type { CronJobMutation } from "./job-mutations.types.js";
import { queueJob, queueStore, requestFor, scheduled } from "./run-queue.test-support.js";

const now = 1_800_000_000_000;
let fixture: OpenClawTestState;
let context: OpenClawStateWorkerContext;

beforeAll(async () => {
  fixture = await createOpenClawTestState({ label: "plugin-command-budgets" });
  context = captureOpenClawStateWorkerContext();
  await executeOpenClawStateWorker(context, { type: "cron.initializeRunReceipts", input: {} });
});
afterAll(async () => {
  await fixture?.cleanup();
});

const reservedPayload = {
  kind: "agentTurn",
  message: PLUGIN_COMMAND_SCHEDULE_MESSAGE,
  toolsAllow: ["sessions_spawn", "agents_wait"],
} as const;
const commandJob = (id: string, overrides: Partial<CronStoredJob> = {}): CronStoredJob => ({
  ...queueJob(id, now),
  payload: { ...reservedPayload, toolsAllow: [...reservedPayload.toolsAllow] },
  pluginCommand: pluginCommandSchedule(now),
  state: { nextRunAtMs: now, pluginCommandRuns: 0 },
  ...overrides,
});
const store = (label: string, jobs: CronStoredJob[]) =>
  queueStore(fixture.statePath("cron", label + ".json"), jobs, now, () => context);
const mutate = (storeKey: string, jobMutation: CronJobMutation) =>
  executeOpenClawStateWorker(context, {
    type: "cron.mutateJobs",
    input: { storeKey, jobMutation, snapshot: { nowMs: now + 1 } },
  });
const commandCreate = (id: string, declarationKey: string): CronJobCreate => ({
  id,
  declarationKey,
  name: "Watcher",
  agentId: "main",
  enabled: true,
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "isolated",
  wakeMode: "next-heartbeat",
  payload: { ...reservedPayload, toolsAllow: [...reservedPayload.toolsAllow] },
  delivery: { mode: "none" },
});
async function withStateDatabase<T>(
  read: (db: ReturnType<typeof openOpenClawStateDatabase>["db"]) => T,
) {
  await closeOpenClawStateDatabaseAsync();
  try {
    return read(openOpenClawStateDatabase().db);
  } finally {
    await closeOpenClawStateDatabaseAsync();
    // Reopening replaces the database admission that the captured worker context names.
    context = captureOpenClawStateWorkerContext();
  }
}

it("charges only an activated launch, retires on the final charge, and never refunds recovery", async () => {
  const blocker = queueJob("capacity-owner", now);
  const command = commandJob("bounded-command", {
    pluginCommand: pluginCommandSchedule(now, { maxRuns: 1 }),
  });
  const queue = await store("capacity-and-recovery", [blocker, command]);
  const requests = [blocker, command].map((job) => scheduled(queue.storeKey, job, now));
  await queue.request(requests);
  expect((await queue.read()).jobs[1]?.state.pluginCommandRuns).toBe(0);
  expect((await queue.drain()).launches.map(({ job }) => job.id)).toEqual([blocker.id]);
  expect((await queue.read()).jobs[1]?.state.pluginCommandRuns).toBe(0);
  await queue.cancel([requests[0]!.receiptId], "superseded");
  const preparing = await executeOpenClawStateWorker(context, {
    type: "cron.drainQueue",
    input: {
      storeKey: queue.storeKey,
      nowMs: now + 1,
      requests: [],
      maxConcurrentRuns: 1,
      preparingAgentIds: ["main"],
    },
  });
  expect(preparing.launches).toEqual([]);
  expect(preparing.preparing.map(({ job }) => job.id)).toEqual([command.id]);
  expect((await queue.read()).jobs[1]).toMatchObject({
    enabled: true,
    state: { pluginCommandRuns: 0 },
  });
  const launched = await queue.drain();
  expect(launched.launches).toHaveLength(1);
  // The last allowed attempt still launches, but the same transaction disarms the schedule.
  expect(launched.launches[0]?.job).toMatchObject({
    enabled: false,
    state: { pluginCommandRuns: 1, runningAtMs: now + 1 },
  });
  expect(launched.launches[0]?.job.state.nextRunAtMs).toBeUndefined();
  const stored = (await queue.read()).jobs[1]!;
  expect(stored).toMatchObject({ enabled: false, state: { pluginCommandRuns: 1 } });
  expect(stored.state.nextRunAtMs).toBeUndefined();
  expect((await queue.drain()).launches).toEqual([]);
  await queue.recover();
  const recovered = (await queue.read()).jobs[1]!;
  expect(recovered.state.pluginCommandRuns).toBe(1);
  expect(recovered.state.runningAtMs).toBeUndefined();
  expect(recovered.enabled).toBe(false);
  // A retired command schedule cannot be force-run back into another attempt.
  const retry = requestFor(recovered, { receiptId: "cron:request:after-crash", mode: "force" });
  expect(await queue.request([retry])).toMatchObject({
    accepted: [],
    rejected: [{ receiptId: retry.receiptId, reason: "job-ineligible" }],
  });
  expect((await queue.read()).jobs[1]?.state.pluginCommandRuns).toBe(1);
});

it.each([
  [
    "deadline",
    { pluginCommand: pluginCommandSchedule(now, { deadlineAtMs: now + 1 }) },
    "cron: plugin command schedule deadline expired",
  ],
  [
    "exhausted",
    { state: { nextRunAtMs: now, pluginCommandRuns: 2 } },
    "cron: plugin command schedule maxRuns exhausted",
  ],
  [
    "previous-gateway-process",
    { pluginCommand: pluginCommandSchedule(now, { hostProcessId: "1:previous-boot" }) },
    "cron: plugin command schedule ended with its Gateway process",
  ],
  [
    "missing-count",
    { state: { nextRunAtMs: now } },
    "cron: plugin command run counter is missing or invalid",
  ],
  [
    "negative-count",
    { state: { nextRunAtMs: now, pluginCommandRuns: -1 } },
    "cron: plugin command run counter is missing or invalid",
  ],
  [
    "missing-envelope",
    { pluginCommand: undefined, state: { nextRunAtMs: now } },
    "cron: plugin command schedule budget is missing or invalid",
  ],
] as const)(
  "retires %s before spending a run and never wakes it again",
  async (label, overrides, error) => {
    const job = commandJob(label, overrides);
    const queue = await store(label, [job]);
    const request = scheduled(queue.storeKey, job, now);
    expect((await queue.request([request])).accepted).toHaveLength(1);
    const drained = await queue.drain();
    expect(drained.launches).toEqual([]);
    expect(drained.skipped).toMatchObject([{ error, job: { enabled: false } }]);
    const retired = (await queue.read()).jobs[0]!;
    expect(retired.enabled).toBe(false);
    expect(retired.state.nextRunAtMs).toBeUndefined();
    expect(retired.state.pluginCommandRuns).toBe(job.state.pluginCommandRuns);
    expect((await queue.history()).entries).toMatchObject([{ status: "skipped", error }]);
    const later = requestFor(retired, { receiptId: "cron:request:" + label, mode: "force" });
    expect((await queue.request([later])).rejected).toMatchObject([{ reason: "job-ineligible" }]);
    expect((await queue.history()).entries).toHaveLength(1);
  },
);

it("persists command schedules under a kind hosts without command schedules quarantine", async () => {
  const key = fixture.statePath("cron", "persisted-kind.json");
  const options = { captured: false, pluginCommand: pluginCommandSchedule(now) };
  const added = await mutate(key, {
    kind: "add",
    input: commandCreate("persisted", "plugin:watcher:persisted"),
    options,
  });
  if (!("outcome" in added)) {
    throw new Error("Expected command creation");
  }
  const selectRow = (db: ReturnType<typeof openOpenClawStateDatabase>["db"]) =>
    db
      .prepare("SELECT payload_kind, job_json FROM cron_jobs WHERE store_key = ? AND job_id = ?")
      .get(key, "persisted");
  const row = await withStateDatabase(selectRow);
  const definition = JSON.parse(String(row?.job_json));
  // No ordinary prompt text or agentTurn kind exists in the durable definition.
  expect(row?.payload_kind).toBe("pluginCommand");
  expect(definition.payload).toEqual({
    kind: "pluginCommand",
    toolsAllow: ["sessions_spawn", "agents_wait"],
  });
  expect(definition.pluginCommand).toEqual(options.pluginCommand);
  const loaded = await executeOpenClawStateWorker(context, {
    type: "cron.loadMutable",
    input: { storeKey: key },
  });
  if (!loaded.ok) {
    throw new Error(loaded.error.message);
  }
  // The current host decodes the stored kind back to its reserved runner payload.
  expect(loaded.loaded.store.jobs[0]).toMatchObject({
    id: "persisted",
    payload: reservedPayload,
    pluginCommand: options.pluginCommand,
  });
  // A stored agentTurn copy of the envelope is never trusted as a runnable command schedule.
  await withStateDatabase((db) =>
    db
      .prepare(
        "UPDATE cron_jobs SET job_json = json_set(job_json, '$.payload', json(?)) WHERE store_key = ? AND job_id = ?",
      )
      .run(JSON.stringify(reservedPayload), key, "persisted"),
  );
  const tampered = await executeOpenClawStateWorker(context, {
    type: "cron.loadMutable",
    input: { storeKey: key },
  });
  if (!tampered.ok) {
    throw new Error(tampered.error.message);
  }
  expect(tampered.loaded.store.jobs).toEqual([]);
  expect(tampered.loaded.invalidConfigRows).toMatchObject([{ reason: "invalid-payload" }]);
});

it("bounds active command schedules per plugin and parent; retired schedules do not count", async () => {
  const key = fixture.statePath("cron", "active-cap.json");
  const options = { captured: false, pluginCommand: pluginCommandSchedule(now) };
  const add = (index: number) =>
    mutate(key, {
      kind: "add",
      input: commandCreate("cap-" + index, "plugin:watcher:cap:" + index),
      options,
    });
  for (let index = 0; index < MAX_ACTIVE_PLUGIN_COMMAND_SCHEDULES_PER_PARENT; index += 1) {
    await add(index);
  }
  await expect(add(100)).rejects.toThrow(/limited to 8 active jobs per plugin and parent/);
  // Another parent has its own budget.
  await mutate(key, {
    kind: "add",
    input: commandCreate("other-parent", "plugin:watcher:other-parent"),
    options: {
      captured: false,
      pluginCommand: pluginCommandSchedule(now, {
        parent: { agentId: "main", sessionKey: "agent:main:other", sessionId: "other" },
      }),
    },
  });
  await mutate(key, {
    kind: "update",
    id: "cap-0",
    patch: { enabled: false },
    options: { captured: false },
  });
  await expect(add(101)).resolves.toMatchObject({ outcome: { changed: true } });
});

it("re-enrolls after a restart or reload; schedules that can never run do not hold the cap", async () => {
  const key = fixture.statePath("cron", "stale-cap.json");
  const add = (id: string, overrides: Parameters<typeof pluginCommandSchedule>[1] = {}) =>
    mutate(key, {
      kind: "add",
      input: commandCreate(id, "plugin:watcher:" + id),
      options: { captured: false, pluginCommand: pluginCommandSchedule(now, overrides) },
    });
  // A full cap from the previous Gateway process and another full cap from a replaced plugin
  // instance stay enabled until their next occurrence retires them.
  for (let index = 0; index < MAX_ACTIVE_PLUGIN_COMMAND_SCHEDULES_PER_PARENT; index += 1) {
    await add("previous-process-" + index, { hostProcessId: "1:previous-boot" });
    await add("replaced-instance-" + index, { pluginIncarnation: "replaced-incarnation" });
  }
  for (let index = 0; index < MAX_ACTIVE_PLUGIN_COMMAND_SCHEDULES_PER_PARENT; index += 1) {
    await expect(add("current-" + index)).resolves.toMatchObject({ outcome: { changed: true } });
  }
  // The live instance still has exactly its own cap.
  await expect(add("current-overflow")).rejects.toThrow(
    /limited to 8 active jobs per plugin and parent/,
  );
  const loaded = await executeOpenClawStateWorker(context, {
    type: "cron.loadMutable",
    input: { storeKey: key },
  });
  if (!loaded.ok) {
    throw new Error(loaded.error.message);
  }
  const enabled = loaded.loaded.store.jobs.filter((job) => job.enabled).map((job) => job.id);
  expect(enabled).toHaveLength(3 * MAX_ACTIVE_PLUGIN_COMMAND_SCHEDULES_PER_PARENT);
  expect(enabled).not.toContain("current-overflow");
});

it("keeps an identical declaration and consumed counter unchanged; refuses rewrites and rearming", async () => {
  const input = commandCreate("immutable-declaration", "plugin:watcher:workflow");
  const key = fixture.statePath("cron", "immutable.json");
  const options = { captured: false, pluginCommand: pluginCommandSchedule(now, { maxRuns: 2 }) };
  const added = await mutate(key, { kind: "add", input, options });
  if (!("outcome" in added)) {
    throw new Error("Expected command creation");
  }
  expect(added.outcome.store.jobs[0]?.state.pluginCommandRuns).toBe(0);
  const queue = await store("immutable", added.outcome.store.jobs);
  const current = (await queue.read()).jobs[0]!;
  const request = requestFor(current, { receiptId: "cron:request:declaration", mode: "force" });
  await queue.request([request]);
  await queue.drain([request]);
  await queue.cancel([request.receiptId], "superseded");
  const before = await queue.read();
  expect(before.jobs[0]?.state.pluginCommandRuns).toBe(1);
  const duplicate = await mutate(key, {
    kind: "add",
    input: { ...input, id: "ignored-retry-id" },
    options,
  });
  expect(duplicate).toMatchObject({ outcome: { changed: false, store: before } });
  const rewrites: CronJobMutation[] = [
    { kind: "add", input: { ...input, name: "Different" }, options },
    { kind: "add", input: { ...input, schedule: { kind: "every", everyMs: 1_000 } }, options },
    {
      kind: "add",
      input,
      options: { ...options, pluginCommand: pluginCommandSchedule(now, { maxRuns: 100 }) },
    },
    { kind: "add", input, options: { captured: false } },
    { kind: "update", id: current.id, patch: { enabled: true }, options: { captured: false } },
    {
      kind: "update",
      id: current.id,
      patch: { payload: { kind: "command", argv: ["echo", "changed"] } },
      options: { captured: false },
    },
  ];
  for (const mutation of rewrites) {
    await expect(mutate(key, mutation)).rejects.toThrow(/plugin command/);
    expect(await queue.read()).toEqual(before);
  }
  await queue.update(current.id, { enabled: false });
  const disabled = (await queue.read()).jobs[0]!;
  expect(disabled.enabled).toBe(false);
  expect(disabled.state.pluginCommandRuns).toBe(1);
  expect(disabled.pluginCommand).toEqual(before.jobs[0]?.pluginCommand);
  // Disable withdraws unattended authority: a manual force run cannot spend the last attempt.
  const forced = requestFor(disabled, { receiptId: "cron:request:disabled", mode: "force" });
  expect((await queue.request([forced])).rejected).toMatchObject([{ reason: "job-ineligible" }]);
  expect((await queue.read()).jobs[0]?.state.pluginCommandRuns).toBe(1);
  await expect(mutate(key, { kind: "add", input, options })).rejects.toThrow(
    /cannot be changed or rearmed/,
  );
});

it("rejects caller-authored run accounting on ordinary add and update paths", async () => {
  const key = fixture.statePath("cron", "authored-state.json");
  const input = { ...queueJob("ordinary", now), state: { lastRunAtMs: now, pluginCommandRuns: 0 } };
  await expect(mutate(key, { kind: "add", input, options: { captured: false } })).rejects.toThrow(
    /private launch accounting/,
  );
  const queue = await store("authored-state", [queueJob("ordinary", now)]);
  const patch = { state: { lastRunAtMs: now, pluginCommandRuns: 0 } };
  await expect(queue.update("ordinary", patch)).rejects.toThrow(/private launch accounting/);
  expect((await queue.read()).jobs[0]?.state).not.toHaveProperty("pluginCommandRuns");
});
