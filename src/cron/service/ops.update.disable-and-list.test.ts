import { describe, expect, it, vi } from "vitest";
import {
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { add, list, update } from "./ops.js";
import { createCronServiceState } from "./state.js";

const fixtures = setupCronRegressionFixtures({
  prefix: "cron-service-disable-and-list-",
});

describe("cron service ops: disable + list round-trip", () => {
  it("hides disabled jobs from default list, surfaces them with includeDisabled, and restores them after enable", async () => {
    const store = fixtures.makeStorePath();
    const scheduledAt = Date.now() + 60_000;
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
    });

    const job = await add(state, {
      name: "disable-and-list",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: scheduledAt },
      payload: { kind: "agentTurn", message: "ping" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      delivery: { mode: "announce" },
    });
    if (state.timer) {
      clearTimeout(state.timer);
    }

    await update(state, job.id, { enabled: false });
    if (state.timer) {
      clearTimeout(state.timer);
    }

    const defaultListAfterDisable = await list(state);
    expect(defaultListAfterDisable.map((j) => j.id)).not.toContain(job.id);

    const allListAfterDisable = await list(state, { includeDisabled: true });
    const disabledFromAllList = allListAfterDisable.find((j) => j.id === job.id);
    expect(disabledFromAllList).toBeDefined();
    expect(disabledFromAllList?.enabled).toBe(false);
    expect(disabledFromAllList?.name).toBe(job.name);
    expect(disabledFromAllList?.schedule).toEqual(job.schedule);
    expect(disabledFromAllList?.payload).toEqual(job.payload);

    await update(state, job.id, { enabled: true });
    if (state.timer) {
      clearTimeout(state.timer);
    }

    const defaultListAfterEnable = await list(state);
    const reenabled = defaultListAfterEnable.find((j) => j.id === job.id);
    expect(reenabled).toBeDefined();
    expect(reenabled?.enabled).toBe(true);
  });
});
