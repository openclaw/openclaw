import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
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
      validate: async (record) =>
        (await fs.readFile(path.join(record.path, "source"), "utf8")) === "source",
      prepare: async (record) => {
        await fs.mkdir(record.path);
        await fs.writeFile(path.join(record.path, "source"), "source");
      },
    };
  });

  it("builds once for concurrent callers and retains all readers through collection and replacement", async () => {
    const entered = createDeferred();
    const finish = createDeferred();
    const prepare = vi.fn(async (...args: Parameters<typeof params.prepare>) => {
      entered.resolve();
      await finish.promise;
      await params.prepare(...args);
    });
    const first = prepareWorktreeTemplate({ ...params, prepare });
    await entered.promise;
    const second = prepareWorktreeTemplate({ ...params, prepare });
    finish.resolve();
    const [left, right] = await Promise.all([first, second]);
    expect(left?.id).toBe(right?.id);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(left?.status).toBe("ready");
    expect(right?.status).toBe("ready");
    if (!left || !right) {
      throw new Error("Both callers must acquire the prepared template");
    }
    await collectWorktreeTemplates(env, 101, options);
    expect(await fs.readFile(path.join(left.path, "source"), "utf8")).toBe("source");
    expect(await prepareWorktreeTemplate({ ...params, contentKey: "commit-2" })).toBeUndefined();
    await left.release();
    await collectWorktreeTemplates(env, 101, options);
    expect(await listTemplatesAsync(env)).toHaveLength(1);
    await right.release();
    await collectWorktreeTemplates(env, 101, options);
    expect(await listTemplatesAsync(env)).toEqual([]);
    await expect(fs.access(left.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["settled", "worker", "process"])(
    "retains a failed builder only while its native outcome is uncertain (%s)",
    async (kind) => {
      const uncertain = kind !== "settled";
      const error =
        kind === "worker"
          ? new SqliteWorkerError("native result missing", "outcome-unknown")
          : kind === "process"
            ? new CommandProcessCleanupError()
            : new Error("native failure settled");
      await expect(
        prepareWorktreeTemplate({
          ...params,
          prepare: async (record, guard) => {
            await params.prepare(record, guard);
            throw error;
          },
        }),
      ).rejects.toBe(error);
      const [record] = await listTemplatesAsync(env);
      expect(record?.status).toBe("preparing");
      await collectWorktreeTemplates(env, 101, options);
      expect(await listTemplatesAsync(env)).toHaveLength(uncertain ? 1 : 0);
      if (uncertain) {
        expect(await prepareWorktreeTemplate(params)).toBeUndefined();
        expect(await fs.readFile(path.join(record!.path, "source"), "utf8")).toBe("source");
      }
    },
  );

  it("keeps an uncertain retirement unpublished and retained", async () => {
    const prepared = await prepareWorktreeTemplate(params);
    await prepared?.release();
    const failure = new CommandProcessCleanupError();
    vi.spyOn(fs, "rm").mockRejectedValueOnce(failure);
    const onError = vi.fn();
    await collectWorktreeTemplates(env, 101, options, onError);
    expect(onError).toHaveBeenCalledWith(failure, prepared?.id);
    expect((await listTemplatesAsync(env))[0]?.status).toBe("preparing");
    expect(await prepareWorktreeTemplate(params)).toBeUndefined();
  });

  it("retains validation with an uncertain native result", async () => {
    const prepared = await prepareWorktreeTemplate(params);
    await prepared?.release();
    const failure = new CommandProcessCleanupError();
    await expect(
      prepareWorktreeTemplate({
        ...params,
        validate: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    await collectWorktreeTemplates(env, 101, options);
    expect((await listTemplatesAsync(env))[0]).toMatchObject({
      id: prepared?.id,
      status: "preparing",
    });
    expect(await prepareWorktreeTemplate(params)).toBeUndefined();
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
        prepareWorktreeTemplate({ ...params, options: { ...options, signal: controller.signal } }),
      ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED" });
      handoff.mockRestore();
      await collectWorktreeTemplates(env, 101, options);
      expect(await listTemplatesAsync(env)).toEqual([]);
    },
  );

  it("propagates unknown native settlement after successful registry delivery", async () => {
    const prepared = await prepareWorktreeTemplate(params);
    await prepared?.release();
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
    await expect(templateRegistry.readTemplateAsync(env, params.cacheKey)).rejects.toMatchObject({
      code: "outcome-unknown",
      cause: failure,
    });
    worker.mockRestore();
  });
});
