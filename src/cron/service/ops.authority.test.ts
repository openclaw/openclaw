import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { readCronJobScratchState } from "../scratch-store.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import { loadCronStore } from "../store.js";
import { add, remove, update, updateWithPrecondition } from "./ops-mutations.js";
import { writeScratch } from "./ops-read.js";
import { createOkIsolatedCronStateFactory } from "./ops.test-support.js";
import type { CronAddResult } from "./state.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-ops-authority",
});
const createOkIsolatedCronState = createOkIsolatedCronStateFactory(logger);
const jobInput = {
  name: "authority",
  enabled: true,
  schedule: { kind: "every" as const, everyMs: 60_000 },
  sessionTarget: "isolated" as const,
  wakeMode: "now" as const,
  payload: { kind: "agentTurn" as const, message: "run" },
};

function requireDeclarativeAddResult(result: CronAddResult) {
  if (!("job" in result)) {
    throw new Error("expected declarative cron result");
  }
  return result;
}

describe("scheduled tool policy provenance", () => {
  it("guards scratch and removal at their locked mutation owners", async () => {
    const { storePath } = await makeStorePath();
    const state = createOkIsolatedCronState({ storePath, now: Date.now() });
    const job = await add(state, {
      ...jobInput,
      name: "guarded",
    });
    const commitGuard = vi.fn(() => {
      throw new TypeError("authority closed");
    });

    const scratchBlockerEntered = createDeferred();
    const releaseScratchBlocker = createDeferred();
    const scratchBlocker = updateWithPrecondition(state, job.id, {}, async () => {
      scratchBlockerEntered.resolve();
      await releaseScratchBlocker.promise;
    });
    await scratchBlockerEntered.promise;
    const scratchWrite = writeScratch(state, job.id, { content: "notes", commitGuard });
    expect(commitGuard).not.toHaveBeenCalled();
    releaseScratchBlocker.resolve();
    await scratchBlocker;
    await expect(scratchWrite).rejects.toThrow("authority closed");
    expect(readCronJobScratchState(storePath, job.id)).toEqual({ currentRevision: 0 });

    const removeBlockerEntered = createDeferred();
    const releaseRemoveBlocker = createDeferred();
    const removeBlocker = updateWithPrecondition(state, job.id, {}, async () => {
      removeBlockerEntered.resolve();
      await releaseRemoveBlocker.promise;
    });
    await removeBlockerEntered.promise;
    const removal = remove(state, job.id, { commitGuard });
    expect(commitGuard).toHaveBeenCalledOnce();
    releaseRemoveBlocker.resolve();
    await removeBlocker;
    await expect(removal).rejects.toThrow("authority closed");
    expect(state.store?.jobs.some((entry) => entry.id === job.id)).toBe(true);
    expect(commitGuard).toHaveBeenCalledTimes(2);
    state.timer?.cancel();
  });

  it.each(["add validation", "update precondition"] as const)(
    "validates mutation authority only after %s succeeds",
    async (boundary) => {
      const { storePath } = await makeStorePath();
      const state = createOkIsolatedCronState({ storePath, now: Date.now() });
      const existing =
        boundary === "update precondition"
          ? await add(state, { ...jobInput, name: "original" })
          : undefined;
      const expectUnchanged = () => {
        if (existing) {
          expect(state.store?.jobs[0]?.name).toBe("original");
        } else {
          expect(state.store?.jobs).toEqual([]);
        }
      };
      const commitGuard = vi.fn(expectUnchanged);
      const options = { commitGuard };
      const mutate = (valid: boolean) =>
        existing
          ? updateWithPrecondition(
              state,
              existing.id,
              { name: "updated" },
              () => {
                if (!valid) {
                  throw new Error("revision conflict");
                }
              },
              options,
            )
          : add(
              state,
              {
                ...jobInput,
                name: "invalid",
                schedule: { kind: "cron", expr: valid ? "0 0 * * *" : "0 0 30 2 *" },
              },
              options,
            );

      await expect(mutate(false)).rejects.toThrow(
        existing ? "revision conflict" : /no upcoming run time/,
      );
      expect(commitGuard).not.toHaveBeenCalled();
      expectUnchanged();

      const job = await mutate(true);
      expect(commitGuard).toHaveBeenCalled();
      if (existing) {
        expect(state.store?.jobs[0]?.name).toBe("updated");
      } else {
        expect(state.store?.jobs).toHaveLength(1);
        expect(job.state.nextRunAtMs).toBeGreaterThan(state.deps.nowMs());
        expect((await loadCronStore(storePath)).jobs.map(({ id }) => id)).toEqual([job.id]);
      }
      state.timer?.cancel();
    },
  );

  it("preserves trusted owner policy during declarative updates", async () => {
    const { storePath } = await makeStorePath();
    const state = createOkIsolatedCronState({ storePath, now: Date.now() });
    const input = {
      ...jobInput,
      declarationKey: "plugin:test:current-agent-policy",
      name: "current agent permissions",
    };
    const created = requireDeclarativeAddResult(await add(state, input));
    const commitGuard = vi.fn();
    const updated = requireDeclarativeAddResult(
      await add(
        state,
        {
          ...input,
          description: "updated",
        },
        { commitGuard },
      ),
    );
    expect(commitGuard).toHaveBeenCalled();
    expect(updated.job.id).toBe(created.job.id);
    expect(updated.job.scheduledToolPolicy).toEqual({ version: 1, mode: "trusted" });
    for (const job of [created.job, updated.job, ...(await loadCronStore(storePath)).jobs]) {
      expect(job.scheduledToolPolicy).toEqual({ version: 1, mode: "trusted" });
    }
    state.timer?.cancel();
  });

  it("keeps legacy snapshot data inert and durable during an ordinary edit", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();
    const oldJob = {
      id: "legacy-snapshot",
      name: "legacy snapshot",
      enabled: false,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "every" as const, everyMs: 60_000 },
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
      payload: { kind: "agentTurn" as const, message: "run", toolsAllow: ["read"] },
      runtimeAuthority: {
        version: 1 as const,
        runtimeId: "codex",
        namespace: "codex.apps",
        payload: { apps: [] },
      },
      state: {},
    };
    // Upgrading must not rewrite jobs just to make them runnable. The execution
    // test covers ignoring the old snapshot; this covers preserving stored data.
    await writeCronStoreSnapshot({ storePath, jobs: [oldJob] });
    const state = createOkIsolatedCronState({ storePath, now });
    const updated = await update(state, oldJob.id, { description: "edited" });
    expect(updated.runtimeAuthority).toEqual(oldJob.runtimeAuthority);
    const persisted = (await loadCronStore(storePath)).jobs.find((job) => job.id === oldJob.id);
    expect(persisted?.runtimeAuthority).toEqual(oldJob.runtimeAuthority);
    expect(persisted?.payload).toEqual(oldJob.payload);
    state.timer?.cancel();
  });

  it("stamps trusted and authenticated-account creates", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-07-23T12:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });
    const base = {
      ...jobInput,
    };

    const trusted = await add(state, { ...base, name: "trusted" });
    expect(trusted.scheduledToolPolicy).toEqual({ version: 1, mode: "trusted" });

    const account = await add(
      state,
      {
        ...base,
        name: "account",
        owner: {
          agentId: "main",
          sessionKey: "agent:main:discord:group:ops",
          accountId: "work",
        },
      },
      {
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:discord:group:ops",
          ownerAccountId: "work",
        },
      },
    );
    expect(account.scheduledToolPolicy).toEqual({
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:discord:group:ops",
      ownerAccountId: "work",
    });
    state.timer?.cancel();
  });

  it("does not synthesize an account owner for legacy jobs and accepts a verified owner on edit", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-07-23T12:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });
    const created = await add(state, {
      ...jobInput,
      name: "legacy",
      owner: {
        agentId: "main",
        sessionKey: "agent:main:discord:group:ops",
        accountId: "work",
      },
    });
    const legacy = structuredClone(created);
    delete legacy.scheduledToolPolicy;
    await writeCronStoreSnapshot({ storePath, jobs: [legacy] });
    expect((await loadCronStore(storePath)).jobs[0]?.scheduledToolPolicy).toBeUndefined();

    const routine = await update(state, created.id, { description: "routine" });
    expect(routine.scheduledToolPolicy).toBeUndefined();

    const reauthorized = await update(
      state,
      created.id,
      { payload: { kind: "agentTurn", message: "updated task" } },
      {
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:discord:group:ops",
          ownerAccountId: "work",
        },
      },
    );
    expect(reauthorized.scheduledToolPolicy?.mode).toBe("account");
    state.timer?.cancel();
  });
});
