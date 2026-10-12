import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { readCronJobScratchState } from "../scratch-store.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import { loadCronStore } from "../store.js";
import { add, remove, update, updateWithPrecondition } from "./ops-mutations.js";
import { writeScratch } from "./ops-read.js";
import { createOkIsolatedCronStateFactory } from "./ops.test-support.js";
import type { CronAddOptions, CronAddResult } from "./state.js";

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
    "captures authority once only after %s succeeds",
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
      const captureRuntimeAuthority = vi.fn(() => undefined);
      const options = { commitGuard, captureRuntimeAuthority };
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
      expect(captureRuntimeAuthority).not.toHaveBeenCalled();
      expectUnchanged();

      const job = await mutate(true);
      expect(commitGuard).toHaveBeenCalled();
      expect(captureRuntimeAuthority).toHaveBeenCalledOnce();
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

  it("stores final-surface provenance privately and never synthesizes it from the default marker", async () => {
    const { storePath } = await makeStorePath();
    const state = createOkIsolatedCronState({ storePath, now: Date.now() });
    const proven = await add(
      state,
      {
        ...jobInput,
        name: "proven",
        payload: {
          kind: "agentTurn" as const,
          message: "run",
          toolsAllow: ["notes__read"],
          toolsAllowIsDefault: true,
        },
      },
      {
        toolsAllowProvenance: {
          version: 1,
          source: "final-executable-surface",
          callerOrigin: { kind: "unknown" },
        },
      },
    );
    expect(proven.toolsAllowProvenance).toEqual({
      version: 1,
      source: "final-executable-surface",
      callerOrigin: { kind: "unknown" },
    });

    const legacy = await add(state, {
      ...jobInput,
      name: "legacy-default",
      payload: {
        kind: "agentTurn",
        message: "run",
        toolsAllow: ["notes__read"],
        toolsAllowIsDefault: true,
      },
    });
    expect(legacy.toolsAllowProvenance).toBeUndefined();
    const stored = await loadCronStore(storePath);
    expect(stored.jobs.find((job) => job.id === proven.id)?.toolsAllowProvenance).toEqual(
      proven.toolsAllowProvenance,
    );
    expect(stored.jobs.find((job) => job.id === legacy.id)?.toolsAllowProvenance).toBeUndefined();

    const routine = await update(state, proven.id, { description: "keep" });
    expect(routine.toolsAllowProvenance).toEqual(proven.toolsAllowProvenance);
    const explicit = await update(state, proven.id, {
      payload: { kind: "agentTurn", toolsAllow: ["read"] },
    });
    expect(explicit.toolsAllowProvenance).toBeUndefined();
    state.timer?.cancel();
  });

  it.each(["update", "declarative"] as const)(
    "stamps, preserves, replaces, and clears runtime authority through %s",
    async (mode) => {
      const { storePath } = await makeStorePath();
      const state = createOkIsolatedCronState({
        storePath,
        now: Date.now(),
        triggersEnabled: mode === "update",
      });
      const baseAuthority = {
        version: 1 as const,
        runtimeId: "codex",
        namespace: "codex.apps",
        payload: { apps: [{ id: "calendar" }] },
      };
      const input = {
        ...jobInput,
        ...(mode === "declarative" ? { declarationKey: "plugin:test:runtime-authority" } : {}),
        payload: { ...jobInput.payload, toolsAllow: ["*"] },
      };
      const result = await add(state, input, { captureRuntimeAuthority: () => baseAuthority });
      const job = mode === "declarative" ? requireDeclarativeAddResult(result).job : result;
      const mutate = async (
        description: string,
        toolsAllow?: string[],
        options?: Pick<CronAddOptions, "commitGuard" | "captureRuntimeAuthority">,
      ) => {
        if (mode === "update") {
          return await update(
            state,
            job.id,
            {
              description,
              ...(toolsAllow === undefined ? {} : { payload: { kind: "agentTurn", toolsAllow } }),
            },
            options,
          );
        }
        return requireDeclarativeAddResult(
          await add(
            state,
            {
              ...input,
              description,
              payload: { ...jobInput.payload, ...(toolsAllow === undefined ? {} : { toolsAllow }) },
            },
            options,
          ),
        ).job;
      };
      expect(job.runtimeAuthority).toEqual(baseAuthority);
      if (mode === "update") {
        const routine = await mutate("preserve");
        expect(routine.runtimeAuthority).toEqual(baseAuthority);
      }
      const commitGuard = vi.fn(() => {
        expect(state.store?.jobs.find((entry) => entry.id === job.id)?.runtimeAuthority).toEqual(
          baseAuthority,
        );
      });
      const validated = await mutate("validated", undefined, { commitGuard });
      expect(commitGuard).toHaveBeenCalled();
      expect(validated.runtimeAuthority).toEqual(baseAuthority);

      const explicit = await mutate("new tool cap", ["read"]);
      expect(explicit.runtimeAuthority).toBeUndefined();
      expect(explicit.runtimeAuthorityRecoveryRequired).toBe(true);
      if (mode === "update") {
        const persisted = (await loadCronStore(storePath)).jobs.find(
          (entry) => entry.id === job.id,
        );
        expect(persisted?.runtimeAuthority).toBeUndefined();
        expect(persisted?.runtimeAuthorityRecoveryRequired).toBe(true);
      }
      const replacement = { ...baseAuthority, payload: { apps: [{ id: "mail" }] } };
      const replaced = await mutate("recaptured", mode === "declarative" ? ["read"] : undefined, {
        captureRuntimeAuthority: () => replacement,
      });
      expect(replaced.runtimeAuthority).toEqual(replacement);
      expect(replaced.runtimeAuthorityRecoveryRequired).toBeUndefined();
      if (mode === "update") {
        const persisted = (await loadCronStore(storePath)).jobs.find(
          (entry) => entry.id === job.id,
        );
        expect(persisted?.runtimeAuthority).toEqual(replacement);
        expect(persisted?.runtimeAuthorityRecoveryRequired).toBeUndefined();
        const freshEmptyCapture = await mutate("recaptured without runtime authority", undefined, {
          captureRuntimeAuthority: () => undefined,
        });
        expect(freshEmptyCapture.runtimeAuthority).toBeUndefined();
        expect(freshEmptyCapture.runtimeAuthorityRecoveryRequired).toBeUndefined();

        const triggeredTransport = await add(
          state,
          {
            ...jobInput,
            name: "trigger-capped",
            trigger: { script: "return true" },
            payload: { kind: "command", argv: ["true"] },
          },
          { captureRuntimeAuthority: () => baseAuthority },
        );
        expect(triggeredTransport.runtimeAuthority).toEqual(baseAuthority);
        const nonToolRuntime = await update(state, triggeredTransport.id, { trigger: null });
        expect(nonToolRuntime.runtimeAuthority).toBeUndefined();
        expect(nonToolRuntime.runtimeAuthorityRecoveryRequired).toBeUndefined();
        const persistedNonToolRuntime = (await loadCronStore(storePath)).jobs.find(
          (entry) => entry.id === triggeredTransport.id,
        );
        expect(persistedNonToolRuntime?.runtimeAuthority).toBeUndefined();
        expect(persistedNonToolRuntime?.runtimeAuthorityRecoveryRequired).toBeUndefined();
        const persistedAuthorityRow = runOpenClawStateWriteTransaction(({ db }) =>
          db
            .prepare("SELECT job_id FROM cron_job_runtime_authorities WHERE job_id = ?")
            .get(triggeredTransport.id),
        );
        expect(persistedAuthorityRow).toBeUndefined();
      }
      state.timer?.cancel();
    },
  );

  it("stamps trusted and authenticated-account creates", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-07-23T12:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });
    const base = {
      ...jobInput,
      payload: { kind: "agentTurn" as const, message: "run", toolsAllow: ["write"] },
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

  it("keeps routine legacy edits restrictive and adopts authority on an explicit tool edit", async () => {
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
      payload: { ...jobInput.payload, toolsAllow: ["write"] },
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
      { payload: { kind: "agentTurn", toolsAllow: ["write"] } },
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
