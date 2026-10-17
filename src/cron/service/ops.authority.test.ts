import { beforeEach, describe, expect, it, vi } from "vitest";
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
  let storePath: string;
  let state: ReturnType<typeof createOkIsolatedCronState>;
  beforeEach(async () => {
    ({ storePath } = await makeStorePath());
    state = createOkIsolatedCronState({ storePath, now: Date.now() });
  });
  const accountPolicy = {
    version: 1 as const,
    mode: "account" as const,
    ownerSessionKey: "agent:main:discord:group:ops",
    ownerAccountId: "work",
  };
  const owner = { agentId: "main", sessionKey: accountPolicy.ownerSessionKey, accountId: "work" };
  const readJob = async (id: string) =>
    (await loadCronStore(storePath)).jobs.find((entry) => entry.id === id);
  function expectAuthority(
    job: CronAddResult | undefined,
    authority: CronAddResult["runtimeAuthority"],
    recovery: true | undefined = undefined,
  ) {
    expect(job?.runtimeAuthority).toEqual(authority);
    expect(job?.runtimeAuthorityRecoveryRequired).toBe(recovery);
  }
  async function blockMutation(id: string) {
    const entered = createDeferred();
    const release = createDeferred();
    const done = updateWithPrecondition(state, id, {}, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    return async () => {
      release.resolve();
      await done;
    };
  }
  it.each(["scratch", "remove"] as const)(
    "guards %s at its locked mutation owner",
    async (operation) => {
      const job = await add(state, { ...jobInput, name: "guarded" });
      const commitGuard = vi.fn(() => {
        throw new TypeError("authority closed");
      });
      const release = await blockMutation(job.id);
      const pending =
        operation === "scratch"
          ? writeScratch(state, job.id, { content: "notes", commitGuard })
          : remove(state, job.id, { commitGuard });
      expect(commitGuard).not.toHaveBeenCalled();
      await release();
      await expect(pending).rejects.toThrow("authority closed");
      expect(commitGuard).toHaveBeenCalledOnce();
      if (operation === "scratch") {
        expect(readCronJobScratchState(storePath, job.id)).toEqual({ currentRevision: 0 });
      } else {
        expect(state.store?.jobs.some((entry) => entry.id === job.id)).toBe(true);
      }
    },
  );

  it.each(["add validation", "update precondition"] as const)(
    "captures authority once only after %s succeeds",
    async (boundary) => {
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
        expect((await loadCronStore(storePath)).jobs[0]).toEqual(state.store?.jobs[0]);
      } else {
        expect(state.store?.jobs).toHaveLength(1);
        expect(job.state.nextRunAtMs).toBeGreaterThan(state.deps.nowMs());
        expect((await loadCronStore(storePath)).jobs.map(({ id }) => id)).toEqual([job.id]);
      }
    },
  );

  it("stores final-surface provenance privately and never synthesizes it from the default marker", async () => {
    const input = {
      ...jobInput,
      payload: { ...jobInput.payload, toolsAllow: ["notes__read"], toolsAllowIsDefault: true },
    };
    const provenance = {
      version: 1 as const,
      source: "final-executable-surface" as const,
      callerOrigin: { kind: "unknown" as const },
    };
    const proven = await add(
      state,
      { ...input, name: "proven" },
      { toolsAllowProvenance: provenance },
    );
    expect(proven.toolsAllowProvenance).toEqual(provenance);
    const legacy = await add(state, { ...input, name: "legacy-default" });
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
  });

  it.each(["update", "declarative"] as const)(
    "stamps, preserves, replaces, and clears runtime authority through %s",
    async (mode) => {
      if (mode === "update") {
        state = createOkIsolatedCronState({ storePath, now: Date.now(), triggersEnabled: true });
      }
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
        const patch = {
          description,
          ...(toolsAllow === undefined
            ? {}
            : { payload: { kind: "agentTurn" as const, toolsAllow } }),
        };
        return mode === "update"
          ? await update(state, job.id, patch, options)
          : requireDeclarativeAddResult(
              await add(
                state,
                {
                  ...input,
                  ...patch,
                  payload: { ...jobInput.payload, ...patch.payload },
                },
                options,
              ),
            ).job;
      };
      const checkAuthority = async (
        changed: CronAddResult,
        authority: CronAddResult["runtimeAuthority"],
        recovery?: true,
      ) => {
        expectAuthority(changed, authority, recovery);
        if (mode === "update") {
          expectAuthority(await readJob(job.id), authority, recovery);
        }
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

      await checkAuthority(await mutate("new tool cap", ["read"]), undefined, true);
      const replacement = { ...baseAuthority, payload: { apps: [{ id: "mail" }] } };
      const replaced = await mutate("recaptured", mode === "declarative" ? ["read"] : undefined, {
        captureRuntimeAuthority: () => replacement,
      });
      await checkAuthority(replaced, replacement);
      if (mode === "update") {
        const freshEmptyCapture = await mutate("recaptured without runtime authority", undefined, {
          captureRuntimeAuthority: () => undefined,
        });
        expectAuthority(freshEmptyCapture, undefined);

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
        expectAuthority(nonToolRuntime, undefined);
        expectAuthority(await readJob(triggeredTransport.id), undefined);
        const persistedAuthorityRow = runOpenClawStateWriteTransaction(({ db }) =>
          db
            .prepare("SELECT job_id FROM cron_job_runtime_authorities WHERE job_id = ?")
            .get(triggeredTransport.id),
        );
        expect(persistedAuthorityRow).toBeUndefined();
      }
    },
  );

  it("stamps trusted and authenticated-account creates", async () => {
    const base = {
      ...jobInput,
      payload: { kind: "agentTurn" as const, message: "run", toolsAllow: ["write"] },
    };

    const trusted = await add(state, { ...base, name: "trusted" });
    expect(trusted.scheduledToolPolicy).toEqual({ version: 1, mode: "trusted" });

    const account = await add(
      state,
      { ...base, name: "account", owner },
      {
        scheduledToolPolicy: accountPolicy,
      },
    );
    expect(account.scheduledToolPolicy).toEqual(accountPolicy);
  });

  it("keeps routine legacy edits restrictive and adopts authority on an explicit tool edit", async () => {
    const created = await add(state, {
      ...jobInput,
      name: "legacy",
      owner,
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
        scheduledToolPolicy: accountPolicy,
      },
    );
    expect(reauthorized.scheduledToolPolicy?.mode).toBe("account");
  });
});
