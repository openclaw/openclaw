import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { getTaskRegistryStore } from "../../tasks/task-registry.store.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { setupCronServiceSuite } from "../service.test-harness.js";
import { stop } from "./ops-lifecycle.js";
import { add } from "./ops-mutations.js";
import { run } from "./ops-run.js";
import { createCronServiceState } from "./state.js";
import { drainCronTaskDeliveryProjections } from "./task-runs.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-manual-delivery-projection-",
});

afterEach(async () => {
  await drainCronTaskDeliveryProjections();
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
  resetTaskRegistryForTests({ persist: false });
});

it("keeps a manual command run open until its task delivery projection settles", async () => {
  const { storePath } = await makeStorePath();
  const now = Date.parse("2026-09-23T00:00:00.000Z");
  const runCommandJob = vi.fn(async () => ({ status: "ok" as const, summary: "command ok" }));
  const state = createCronServiceState({
    storePath,
    cronEnabled: true,
    defaultAgentId: "main",
    log: logger,
    nowMs: () => now,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runCommandJob,
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  const job = await add(state, {
    agentId: "finn",
    name: "manual command projection",
    enabled: true,
    schedule: { kind: "on-exit", command: "true" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "command", argv: ["synthetic-command"] },
  });
  const store = getTaskRegistryStore();
  const mutate = store.runInitialMutationAsync.bind(store);
  const projectionEntered = createDeferred();
  const releaseProjection = createDeferred();
  vi.spyOn(store, "runInitialMutationAsync").mockImplementation(async (...args) => {
    if (args[1].type === "tasks.setDeliveryStatus") {
      projectionEntered.resolve();
      await releaseProjection.promise;
    }
    return mutate(...args);
  });

  const forced = run(state, job.id, "force");
  try {
    await withTestTimeout(
      projectionEntered.promise,
      5_000,
      "manual command delivery projection entered",
    );
    let settled = false;
    void forced.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
  } finally {
    releaseProjection.resolve();
  }

  await expect(forced).resolves.toEqual({ ok: true, ran: true });
  expect(runCommandJob).toHaveBeenCalledOnce();
  stop(state);
});
