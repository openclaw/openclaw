import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
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
      name: "guarded",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "run" },
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

  it("validates add authority and captures it once only after candidate validation", async () => {
    const { storePath } = await makeStorePath();
    const state = createOkIsolatedCronState({ storePath, now: Date.now() });
    const commitGuard = vi.fn();
    const captureRuntimeAuthority = vi.fn(() => undefined);
    const invalid = {
      name: "invalid",
      enabled: true,
      schedule: { kind: "cron" as const, expr: "0 0 30 2 *" },
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
      payload: { kind: "agentTurn" as const, message: "run" },
    };

    await expect(add(state, invalid, { commitGuard, captureRuntimeAuthority })).rejects.toThrow(
      /no upcoming run time/,
    );
    expect(commitGuard).not.toHaveBeenCalled();
    expect(captureRuntimeAuthority).not.toHaveBeenCalled();
    expect(state.store?.jobs).toEqual([]);

    const valid = { ...invalid, schedule: { kind: "cron" as const, expr: "0 0 * * *" } };
    commitGuard.mockImplementation(() => {
      expect(state.store?.jobs).toEqual([]);
    });
    const job = await add(state, valid, { commitGuard, captureRuntimeAuthority });
    expect(commitGuard).toHaveBeenCalled();
    expect(captureRuntimeAuthority).toHaveBeenCalledOnce();
    expect(state.store?.jobs).toHaveLength(1);
    expect(job.state.nextRunAtMs).toBeGreaterThan(state.deps.nowMs());
    expect((await loadCronStore(storePath)).jobs.map(({ id }) => id)).toEqual([job.id]);
    state.timer?.cancel();
  });

  it("preserves update authority across a failed precondition and captures once at mutation", async () => {
    const { storePath } = await makeStorePath();
    const state = createOkIsolatedCronState({ storePath, now: Date.now() });
    const job = await add(state, {
      name: "original",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "run" },
    });
    const commitGuard = vi.fn(() => {
      expect(state.store?.jobs[0]?.name).toBe("original");
      return undefined;
    });
    const captureRuntimeAuthority = vi.fn(() => undefined);

    await expect(
      updateWithPrecondition(
        state,
        job.id,
        { name: "updated" },
        () => {
          throw new Error("revision conflict");
        },
        { commitGuard, captureRuntimeAuthority },
      ),
    ).rejects.toThrow("revision conflict");
    expect(commitGuard).not.toHaveBeenCalled();
    expect(captureRuntimeAuthority).not.toHaveBeenCalled();
    expect(state.store?.jobs[0]?.name).toBe("original");

    await updateWithPrecondition(state, job.id, { name: "updated" }, () => undefined, {
      commitGuard,
      captureRuntimeAuthority,
    });
    expect(commitGuard).toHaveBeenCalled();
    expect(captureRuntimeAuthority).toHaveBeenCalledOnce();
    expect(state.store?.jobs[0]?.name).toBe("updated");
    state.timer?.cancel();
  });

  it("stores final-surface provenance privately and never synthesizes it from the default marker", async () => {
    const { storePath } = await makeStorePath();
    const state = createOkIsolatedCronState({ storePath, now: Date.now() });
    const base = {
      enabled: true,
      schedule: { kind: "every" as const, everyMs: 60_000 },
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
    };
    const proven = await add(
      state,
      {
        ...base,
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
      ...base,
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

  it("stamps, preserves, replaces, and clears private runtime authority at mutation ownership", async () => {
    const { storePath } = await makeStorePath();
    const state = createOkIsolatedCronState({
      storePath,
      now: Date.now(),
      triggersEnabled: true,
    });
    const baseAuthority = {
      version: 1 as const,
      runtimeId: "codex",
      namespace: "codex.apps",
      payload: { apps: [{ id: "calendar" }] },
    };
    const job = await add(
      state,
      {
        name: "runtime-capped",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "run", toolsAllow: ["*"] },
      },
      { captureRuntimeAuthority: () => baseAuthority },
    );
    expect(job.runtimeAuthority).toEqual(baseAuthority);

    const routine = await update(state, job.id, { description: "preserve" });
    expect(routine.runtimeAuthority).toEqual(baseAuthority);

    const commitGuard = vi.fn(() => {
      expect(state.store?.jobs.find((entry) => entry.id === job.id)?.runtimeAuthority).toEqual(
        baseAuthority,
      );
    });
    const validated = await update(
      state,
      job.id,
      { description: "preserve after validation" },
      { commitGuard },
    );
    expect(commitGuard).toHaveBeenCalled();
    expect(validated.runtimeAuthority).toEqual(baseAuthority);

    const explicit = await update(state, job.id, {
      payload: { kind: "agentTurn", toolsAllow: ["read"] },
    });
    expect(explicit.runtimeAuthority).toBeUndefined();
    expect(explicit.runtimeAuthorityRecoveryRequired).toBe(true);
    const persistedExplicit = (await loadCronStore(storePath)).jobs.find(
      (entry) => entry.id === job.id,
    );
    expect(persistedExplicit?.runtimeAuthority).toBeUndefined();
    expect(persistedExplicit?.runtimeAuthorityRecoveryRequired).toBe(true);

    const replacement = { ...baseAuthority, payload: { apps: [{ id: "mail" }] } };
    const replaced = await update(
      state,
      job.id,
      { description: "recaptured" },
      { captureRuntimeAuthority: () => replacement },
    );
    expect(replaced.runtimeAuthority).toEqual(replacement);
    expect(replaced.runtimeAuthorityRecoveryRequired).toBeUndefined();
    const persistedReplacement = (await loadCronStore(storePath)).jobs.find(
      (entry) => entry.id === job.id,
    );
    expect(persistedReplacement?.runtimeAuthority).toEqual(replacement);
    expect(persistedReplacement?.runtimeAuthorityRecoveryRequired).toBeUndefined();

    const freshEmptyCapture = await update(
      state,
      job.id,
      { description: "recaptured without runtime authority" },
      { captureRuntimeAuthority: () => undefined },
    );
    expect(freshEmptyCapture.runtimeAuthority).toBeUndefined();
    expect(freshEmptyCapture.runtimeAuthorityRecoveryRequired).toBeUndefined();

    const triggeredTransport = await add(
      state,
      {
        name: "trigger-capped",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
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
    state.timer?.cancel();
  });

  it("keeps declarative runtime authority across validation and replaces it only on capture", async () => {
    const { storePath } = await makeStorePath();
    const state = createOkIsolatedCronState({ storePath, now: Date.now() });
    const baseAuthority = {
      version: 1 as const,
      runtimeId: "codex",
      namespace: "codex.apps",
      payload: { apps: [{ id: "calendar" }] },
    };
    const input = {
      declarationKey: "plugin:test:runtime-authority",
      name: "declarative runtime authority",
      enabled: true,
      schedule: { kind: "every" as const, everyMs: 60_000 },
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
      payload: { kind: "agentTurn" as const, message: "run", toolsAllow: ["*"] },
    };
    const created = requireDeclarativeAddResult(
      await add(state, input, {
        captureRuntimeAuthority: () => baseAuthority,
      }),
    );
    expect(created.job.runtimeAuthority).toEqual(baseAuthority);

    const commitGuard = vi.fn(() => {
      expect(
        state.store?.jobs.find((entry) => entry.id === created.job.id)?.runtimeAuthority,
      ).toEqual(baseAuthority);
    });
    const validated = requireDeclarativeAddResult(
      await add(
        state,
        {
          ...input,
          description: "validated",
          payload: { kind: "agentTurn", message: "run" },
        },
        { commitGuard },
      ),
    );
    expect(commitGuard).toHaveBeenCalled();
    expect(validated.job.runtimeAuthority).toEqual(baseAuthority);

    const cleared = requireDeclarativeAddResult(
      await add(state, {
        ...input,
        description: "new tool cap",
        payload: { ...input.payload, toolsAllow: ["read"] },
      }),
    );
    expect(cleared.job.runtimeAuthority).toBeUndefined();
    expect(cleared.job.runtimeAuthorityRecoveryRequired).toBe(true);

    const replacement = { ...baseAuthority, payload: { apps: [{ id: "mail" }] } };
    const recaptured = requireDeclarativeAddResult(
      await add(
        state,
        {
          ...input,
          description: "recaptured",
          payload: { ...input.payload, toolsAllow: ["read"] },
        },
        { captureRuntimeAuthority: () => replacement },
      ),
    );
    expect(recaptured.job.runtimeAuthority).toEqual(replacement);
    expect(recaptured.job.runtimeAuthorityRecoveryRequired).toBeUndefined();
    state.timer?.cancel();
  });

  it("stamps trusted and authenticated-account creates", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-07-23T12:00:00.000Z");
    const state = createOkIsolatedCronState({ storePath, now });
    const base = {
      enabled: true,
      schedule: { kind: "every" as const, everyMs: 60_000 },
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
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
      name: "legacy",
      enabled: true,
      owner: {
        agentId: "main",
        sessionKey: "agent:main:discord:group:ops",
        accountId: "work",
      },
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "run", toolsAllow: ["write"] },
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
