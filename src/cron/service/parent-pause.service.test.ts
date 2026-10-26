import { expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { unadmittedScheduledOccurrence } from "../scheduled-occurrence.js";
import { loadCronStore, saveCronStore } from "../store.js";
import type { CronEvent } from "../types.js";
import { stop } from "./ops-lifecycle.js";
import { update } from "./ops-mutations.js";
import { list } from "./ops-read.js";
import { run } from "./ops-run.js";

const PARENT_KEY = "agent:main:dashboard:parent";

it("pauses once when the parent is gone, and again after a re-enable while it is still gone", async () => {
  await withOpenClawTestState({ label: "cron-parent-pause" }, async (fixture) => {
    const now = Date.now();
    const storePath = fixture.statePath("cron", "jobs.json");
    const job = {
      ...createDueIsolatedJob({ id: "parent-paused", nowMs: now - 2000, nextRunAtMs: now - 1000 }),
      // Recurring, so only the pause can disable it.
      schedule: { kind: "every" as const, everyMs: 60_000 },
      sessionKey: PARENT_KEY,
      sourceConversation: { sessionKey: PARENT_KEY, sessionId: "parent-session" },
    };
    const runner = vi.fn(async () => ({ status: "ok" as const }));
    const enqueueSessionEvent = vi.fn(async () => ({ ok: true as const }));
    const events: CronEvent[] = [];
    const state = createCronRegressionState({
      storePath,
      nowMs: () => now,
      defaultAgentId: "main",
      isAgentAvailable: () => true,
      runIsolatedAgentJob: runner,
      onEvent: (event) => events.push(event),
      enqueueSessionEvent,
      admitScheduledOccurrence: async () => ({
        ...unadmittedScheduledOccurrence("parent gone"),
        pause: { reason: "archived", parentSessionKey: PARENT_KEY },
      }),
    });
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    await list(state);
    try {
      await run(state, job.id, "force");
      let persisted = (await loadCronStore(storePath)).jobs[0];
      expect(runner).not.toHaveBeenCalled();
      expect(persisted?.enabled).toBe(false);
      expect(persisted?.state.lastError).toContain(`\`${PARENT_KEY}\``);
      // The archived conversation cannot accept the notice; the owning agent gets it.
      await vi.waitFor(() => expect(enqueueSessionEvent).toHaveBeenCalledOnce());
      expect(enqueueSessionEvent).toHaveBeenCalledWith(
        expect.stringContaining(PARENT_KEY),
        expect.objectContaining({ agentId: "main", sessionKey: undefined, createIfMissing: true }),
      );

      // Re-enabling does not detach the job; the next occurrence checks the parent again.
      await update(state, job.id, { enabled: true });
      await run(state, job.id, "force");
      persisted = (await loadCronStore(storePath)).jobs[0];
      expect(runner).not.toHaveBeenCalled();
      expect(persisted?.enabled).toBe(false);
      expect(events.filter((event) => event.action === "finished")).toHaveLength(2);
    } finally {
      stop(state);
      await state.op;
    }
  });
});

it("keeps a command job running when its parent is gone", async () => {
  await withOpenClawTestState({ label: "cron-parent-pause-command" }, async (fixture) => {
    const now = Date.now();
    const storePath = fixture.statePath("cron", "jobs.json");
    const job = {
      ...createDueIsolatedJob({ id: "command-job", nowMs: now - 2000, nextRunAtMs: now - 1000 }),
      payload: { kind: "command" as const, argv: ["echo", "synthetic"] },
      // Recurring, so only the pause can disable it.
      schedule: { kind: "every" as const, everyMs: 60_000 },
      sourceConversation: { sessionKey: PARENT_KEY, sessionId: "parent-session" },
    };
    const runner = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronRegressionState({
      storePath,
      nowMs: () => now,
      defaultAgentId: "main",
      isAgentAvailable: () => true,
      runCommandJob: runner,
      runIsolatedAgentJob: runner,
      admitScheduledOccurrence: async () => ({
        ...unadmittedScheduledOccurrence("parent gone"),
        pause: { reason: "removed", parentSessionKey: PARENT_KEY },
      }),
    });
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    await list(state);
    try {
      await run(state, job.id, "force");
      expect(runner).toHaveBeenCalledOnce();
      expect((await loadCronStore(storePath)).jobs[0]?.enabled).toBe(true);
    } finally {
      stop(state);
      await state.op;
    }
  });
});
