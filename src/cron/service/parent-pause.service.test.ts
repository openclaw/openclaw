import { expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { unadmittedScheduledOccurrence } from "../scheduled-occurrence.js";
import { loadCronStore, saveCronStore } from "../store.js";
import type { CronEvent, CronStoredJob } from "../types.js";
import { stop } from "./ops-lifecycle.js";
import { update } from "./ops-mutations.js";
import { list } from "./ops-read.js";
import { run } from "./ops-run.js";

const PARENT_KEY = "agent:main:dashboard:parent";

it.each([false, true])("handles a missing parent (command=%s)", async (command) => {
  await withOpenClawTestState({ label: "cron-parent-pause" }, async (fixture) => {
    const now = Date.now();
    const storePath = fixture.statePath("cron", "jobs.json");
    const job: CronStoredJob = {
      ...createDueIsolatedJob({ id: "parent-paused", nowMs: now - 2000, nextRunAtMs: now - 1000 }),
      // Recurring, so only the pause can disable it.
      schedule: { kind: "every" as const, everyMs: 60_000 },
      sessionKey: command ? undefined : PARENT_KEY,
      sourceConversation: { sessionKey: PARENT_KEY, sessionId: "parent-session" },
    };
    if (command) {
      job.payload = { kind: "command", argv: ["echo", "synthetic"] };
    }
    const runner = vi.fn(async () => ({ status: "ok" as const }));
    const enqueueSessionEvent = vi.fn(async () => ({ ok: true as const }));
    const events: CronEvent[] = [];
    const state = createCronRegressionState({
      storePath,
      nowMs: () => now,
      defaultAgentId: "main",
      isAgentAvailable: () => true,
      runIsolatedAgentJob: runner,
      ...(command
        ? { runCommandJob: runner }
        : { onEvent: (event: CronEvent) => events.push(event), enqueueSessionEvent }),
      admitScheduledOccurrence: async () => ({
        ...unadmittedScheduledOccurrence("parent gone"),
        pause: { reason: command ? "removed" : "archived", parentSessionKey: PARENT_KEY },
      }),
    });
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    await list(state);
    try {
      await run(state, job.id, "force");
      if (command) {
        expect(runner).toHaveBeenCalledOnce();
        expect((await loadCronStore(storePath)).jobs[0]?.enabled).toBe(true);
        return;
      }
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
