import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import * as workerStore from "../../state/openclaw-state-worker-store.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import * as allocation from "./allocation.js";
import { collectWorktreeTemplates, prepareWorktreeTemplate } from "./template-cache.js";
import * as templateRegistry from "./template-registry-async.js";
import { listTemplatesAsync } from "./template-registry-async.js";

describe("worktree template custody", () => {
  const directories = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      vi.restoreAllMocks();
      await closeStateDatabaseForTest();
      cleanup();
    }),
  );
  const options = { commitGuard: () => {} };
  let env: NodeJS.ProcessEnv;
  let params: Parameters<typeof prepareWorktreeTemplate>[0];

  const prepare = (overrides: Partial<typeof params> = {}) =>
    prepareWorktreeTemplate({ ...params, ...overrides });
  const collect = (onError?: Parameters<typeof collectWorktreeTemplates>[3]) =>
    collectWorktreeTemplates(env, 101, options, onError);
  const list = () => listTemplatesAsync(env);
  const source = (record: { path: string }) =>
    fs.readFile(path.join(record.path, "source"), "utf8");
  async function idle() {
    const record = await prepare();
    await record?.release();
    return record;
  }
  function preparationGate() {
    const entered = createDeferred();
    const finish = createDeferred();
    const block = <Args extends unknown[], Result>(run: (...args: Args) => Promise<Result>) =>
      vi.fn(async (...args: Args) => {
        entered.resolve();
        await finish.promise;
        return await run(...args);
      });
    return {
      entered: entered.promise,
      finish: finish.resolve,
      prepare: block(params.prepare),
      validate: block(params.validate),
    };
  }
  function observeReaderAttempt() {
    const attempted = createDeferred();
    const retain = templateRegistry.retainTemplateReaderAsync;
    vi.spyOn(templateRegistry, "retainTemplateReaderAsync").mockImplementation(async (...args) => {
      const result = await retain(...args);
      if ("selection" in args[1]) {
        attempted.resolve();
      }
      return result;
    });
    return attempted.promise;
  }

  beforeEach(() => {
    const root = directories.make("openclaw-template-custody-");
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    params = {
      env,
      now: () => 100,
      options,
      cacheKey: "repository-volume",
      contentKey: "commit-1",
      repoRoot: path.join(root, "repo"),
      commonDir: path.join(root, "repo", ".git"),
      worktreeRoot: path.join(root, "worktrees"),
      sourceCommit: "a".repeat(40),
      backend: "btrfs",
      requireSpace: async () => {},
      validate: async (record) => (await source(record)) === "source",
      prepare: async (record) => {
        await fs.mkdir(record.path);
        await fs.writeFile(path.join(record.path, "source"), "source");
      },
    };
  });

  it.each(["cold", "idle"])(
    "prepares a %s template once for concurrent readers through collection and replacement",
    async (state) => {
      if (state === "idle") {
        await idle();
      }
      const { entered, finish, prepare: build, validate } = preparationGate();
      const mutate = vi.spyOn(allocation, "withWorktreeMutationLease");
      const first = prepare({ prepare: build, validate });
      await entered;
      const attempted = observeReaderAttempt();
      const second = prepare({ prepare: build, validate });
      await attempted;
      finish();
      const [left, right] = await Promise.all([first, second]);
      expect(left?.id).toBe(right?.id);
      expect(build).toHaveBeenCalledTimes(state === "cold" ? 1 : 0);
      expect(validate).toHaveBeenCalledTimes(state === "idle" ? 1 : 0);
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(left?.status).toBe("ready");
      expect(right?.status).toBe("ready");
      if (!left || !right) {
        throw new Error("Both callers must acquire the prepared template");
      }
      await collect();
      expect(await source(left)).toBe("source");
      expect(await prepare({ contentKey: "commit-2" })).toBeUndefined();
      await left.release();
      await collect();
      expect(await list()).toHaveLength(1);
      await right.release();
      await collect();
      expect(await list()).toEqual([]);
      await expect(fs.access(left.path)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([false, true])(
    "publishes an idle refresh only after settlement (failure=%s)",
    async (fail) => {
      const original = await idle();
      const entered = createDeferred();
      const finish = createDeferred();
      const failure = new Error("refresh failed");
      const next: typeof params = {
        ...params,
        contentKey: "commit-2",
        sourceCommit: "b".repeat(40),
        refresh: async (record) => {
          entered.resolve();
          await finish.promise;
          await fs.writeFile(path.join(record.path, "source"), "updated");
          if (fail) {
            throw failure;
          }
          return true;
        },
      };
      const refreshing = prepareWorktreeTemplate(next);
      await entered.promise;
      expect((await list())[0]).toMatchObject({
        id: original?.id,
        status: "preparing",
        contentKey: params.contentKey,
      });
      // Another request cannot consume the old tree while the new one is being written.
      const concurrent = prepareWorktreeTemplate(next);
      const rejected = fail ? expect(refreshing).rejects.toBe(failure) : undefined;
      finish.resolve();
      const refreshed = fail ? (await rejected, undefined) : await refreshing;
      const reused = await concurrent;
      if (fail) {
        expect(reused?.id).not.toBe(original?.id);
      } else {
        expect(reused?.id).toBe(original?.id);
      }
      expect(await source(reused!)).toBe(fail ? "source" : "updated");
      await refreshed?.release();
      expect((await list())[0]).toMatchObject({
        status: "ready",
        contentKey: next.contentKey,
        sourceCommit: next.sourceCommit,
      });
      await reused?.release();
    },
  );

  it.each(["owner", "waiter"])(
    "keeps the other caller live when the preparation %s aborts",
    async (canceled) => {
      const { entered, finish, prepare: build } = preparationGate();
      const controller = new AbortController();
      const first = prepare({
        prepare: build,
        options: canceled === "owner" ? { ...options, signal: controller.signal } : options,
      });
      await entered;
      const attempted = observeReaderAttempt();
      const second = prepare({
        prepare: build,
        options: canceled === "waiter" ? { ...options, signal: controller.signal } : options,
      });
      await attempted;
      const rejected = expect(canceled === "owner" ? first : second).rejects.toMatchObject({
        code: "OPENCLAW_STATE_LEASE_ABORTED",
      });
      controller.abort();
      finish();
      await rejected;
      const prepared = await (canceled === "owner" ? second : first);
      expect(prepared?.status).toBe("ready");
      expect(await source(prepared!)).toBe("source");
      await prepared?.release();
      await collect();
      expect(await list()).toEqual([]);
    },
  );

  it("preserves recovery guidance when a shared preparation exhausts the caller wait budget", async () => {
    const { entered, finish, prepare: build } = preparationGate();
    const first = prepare({ prepare: build });
    await entered;
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
      ms === 0 ? AbortSignal.abort(new DOMException("Expired", "TimeoutError")) : timeout(ms),
    );
    const waitBudget = { remainingMs: 0 };
    try {
      await expect(prepare({ options: { ...options, waitBudget } })).rejects.toThrow(
        /timed out.*openclaw worktrees list.*openclaw worktrees gc/,
      );
      expect(waitBudget.remainingMs).toBe(0);
    } finally {
      finish();
      await (await first)?.release();
    }
  });

  it("reuses a retained ready generation and revalidates it once readers settle", async () => {
    const first = await prepare();
    expect(first).toBeDefined();
    const unavailableValidation = async () => {
      throw new Error("validation must not hold up a concurrent clone");
    };
    const second = await allocation.withWorktreeMutationLease(
      { env, ...options, id: `template:${params.cacheKey}` },
      async () =>
        prepare({
          validate: unavailableValidation,
          options: { ...options, waitBudget: { remainingMs: 0 } },
        }),
    );
    expect(second?.id).toBe(first?.id);
    expect(await source(second!)).toBe("source");
    await first?.release();
    await second?.release();
    await fs.writeFile(path.join(first!.path, "source"), "changed");
    const next = await prepare();
    expect(next?.id).not.toBe(first?.id);
    expect(await source(next!)).toBe("source");
    await next?.release();
  });

  it.each(["settled", "process"])(
    "retains a failed builder only while its native outcome is uncertain (%s)",
    async (kind) => {
      const uncertain = kind !== "settled";
      const error = uncertain
        ? new CommandProcessCleanupError()
        : new Error("native failure settled");
      await expect(
        prepare({
          prepare: async (record, guard) => {
            await params.prepare(record, guard);
            throw error;
          },
        }),
      ).rejects.toBe(error);
      const [record] = await list();
      expect(record?.status).toBe("preparing");
      await collect();
      expect(await list()).toHaveLength(uncertain ? 1 : 0);
      if (uncertain) {
        expect(await prepare()).toBeUndefined();
        expect(await source(record!)).toBe("source");
      }
    },
  );

  it("keeps an uncertain retirement unpublished and retained", async () => {
    const prepared = await idle();
    const failure = new CommandProcessCleanupError();
    vi.spyOn(fs, "rm").mockRejectedValueOnce(failure);
    const onError = vi.fn();
    await collect(onError);
    expect(onError).toHaveBeenCalledWith(failure, prepared?.id);
    expect((await list())[0]?.status).toBe("preparing");
    expect(await prepare()).toBeUndefined();
  });

  it("retains validation with an uncertain native result", async () => {
    const prepared = await idle();
    const failure = new CommandProcessCleanupError();
    await expect(
      prepare({
        validate: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    await collect();
    expect((await list())[0]).toMatchObject({
      id: prepared?.id,
      status: "preparing",
    });
    expect(await prepare()).toBeUndefined();
  });

  it.each(["reservation", "lease"])(
    "releases a settled reader when cancellation interrupts the %s handoff",
    async (boundary) => {
      const controller = new AbortController();
      const withMutation = allocation.withWorktreeMutationLease;
      const retain = templateRegistry.retainTemplateReaderAsync;
      const handoff =
        boundary === "reservation"
          ? vi
              .spyOn(templateRegistry, "retainTemplateReaderAsync")
              .mockImplementation(async (...args) => {
                await retain(...args);
                controller.abort();
                args[2]();
              })
          : vi.spyOn(allocation, "withWorktreeMutationLease").mockImplementation((input, run) =>
              withMutation(input, async (guard) => {
                const result = await run(guard);
                controller.abort();
                return result;
              }),
            );
      await expect(
        prepare({ options: { ...options, signal: controller.signal } }),
      ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED" });
      handoff.mockRestore();
      await collect();
      expect(await list()).toEqual([]);
    },
  );

  it("propagates unknown native settlement after successful registry delivery", async () => {
    const prepared = await idle();
    const execute = workerStore.runOpenClawStateWorkerOperation;
    const failure = new Error("native cleanup receipt missing");
    const worker = vi
      .spyOn(workerStore, "runOpenClawStateWorkerOperation")
      .mockImplementation((context, operation, operationOptions) => {
        const createAdmission = operationOptions?.createAdmission;
        return execute(context, operation, {
          ...operationOptions,
          createAdmission: createAdmission
            ? (retained) =>
                createAdmission({
                  ...retained,
                  settled: retained.settled.then(() => ({
                    kind: "unknown" as const,
                    error: failure,
                  })),
                })
            : undefined,
        });
      });
    await expect(
      templateRegistry.markTemplateReadyAsync(env, prepared!.id, 101, options.commitGuard),
    ).rejects.toMatchObject({ code: "outcome-unknown", cause: failure });
    worker.mockRestore();
  });
});
