import fs from "node:fs/promises";
import path from "node:path";
import { assert, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import * as allocation from "./allocation.js";
import { useWorktreeStateRoots } from "./state-fixture.test-support.js";
import { collectWorktreeTemplates, prepareWorktreeTemplate } from "./template-cache.js";
import * as templateRegistry from "./template-registry-async.js";
import { interceptWorktreeWorkerOperation } from "./worker-operation.test-support.js";

const directories = useWorktreeStateRoots();
const options = { commitGuard: () => {} };
let env: NodeJS.ProcessEnv;
let params: Parameters<typeof prepareWorktreeTemplate>[0];
const prepare = (overrides: Partial<typeof params> = {}) =>
  prepareWorktreeTemplate({ ...params, ...overrides });
const collect = (onError?: Parameters<typeof collectWorktreeTemplates>[3]) =>
  collectWorktreeTemplates(env, 101, options, onError);
const list = () => templateRegistry.listTemplatesAsync(env);
const source = (record: { path: string }) => fs.readFile(path.join(record.path, "source"), "utf8");
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
    block,
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
    prepare: (record) =>
      fs.mkdir(record.path).then(() => fs.writeFile(path.join(record.path, "source"), "source")),
  };
});

it.each(["cold", "idle"])("shares %s preparation and reader custody", async (state) => {
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
  expect(left).toMatchObject({ id: right?.id, status: "ready" });
  expect(right).toMatchObject({ status: "ready" });
  expect(build).toHaveBeenCalledTimes(state === "cold" ? 1 : 0);
  expect(mutate).toHaveBeenCalledTimes(1);
  assert(left && right, "Both callers must acquire the prepared template");
  const warm = await allocation.withWorktreeMutationLease(
    { env, ...options, id: `template:${params.cacheKey}` },
    () => prepare({ validate, options: { ...options, waitBudget: { remainingMs: 0 } } }),
  );
  expect(warm).toMatchObject({ id: left.id, path: left.path, status: "ready" });
  expect(validate).toHaveBeenCalledTimes(state === "idle" ? 1 : 0);
  await warm?.release();
  await collect();
  expect(await source(left)).toBe("source");
  expect(await prepare({ contentKey: "commit-2" })).toBeUndefined();
  await left.release();
  await collect();
  expect(await list()).toHaveLength(1);
  await right.release();
  await fs.writeFile(path.join(left.path, "source"), "changed");
  const rebuilt = await prepare();
  assert(rebuilt, "Invalid idle templates must be rebuilt");
  expect(rebuilt.id).not.toBe(left.id);
  expect(await source(rebuilt)).toBe("source");
  await rebuilt.release();
  await collect();
  expect(await list()).toEqual([]);
  await expect(fs.access(left.path)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([false, true])("settles refresh before publication (fail=%s)", async (fail) => {
  const original = await idle();
  const { entered, finish, block } = preparationGate();
  const failure = new Error("refresh failed");
  const next: Partial<typeof params> = {
    contentKey: "commit-2",
    sourceCommit: "b".repeat(40),
    refresh: block(async (record: { path: string }) => {
      await fs.writeFile(path.join(record.path, "source"), "updated");
      if (fail) {
        throw failure;
      }
      return true;
    }),
  };
  const refreshing = prepare(next);
  await entered;
  expect((await list())[0]).toMatchObject({
    id: original?.id,
    status: "preparing",
    contentKey: params.contentKey,
  });
  const concurrent = prepare(next);
  const rejected = fail ? expect(refreshing).rejects.toBe(failure) : undefined;
  finish();
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
});

it.each(["owner", "waiter"])("isolates preparation %s cancellation", async (canceled) => {
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
});

it("keeps recovery guidance when the preparation wait budget expires", async () => {
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

it.each([
  { phase: "build", uncertain: false },
  { phase: "build", uncertain: true },
  { phase: "validate", uncertain: true },
  { phase: "retire", uncertain: true },
])("retains $phase custody ($uncertain)", async ({ phase, uncertain }) => {
  const prepared = phase === "build" ? undefined : await idle();
  const failure = uncertain ? new CommandProcessCleanupError() : new Error("settled");
  if (phase === "retire") {
    vi.spyOn(fs, "rm").mockRejectedValueOnce(failure);
    const onError = vi.fn();
    await collect(onError);
    expect(onError).toHaveBeenCalledWith(failure, prepared?.id);
  } else {
    const fail = () => Promise.reject(failure);
    const build: typeof params.prepare = (...args) => params.prepare(...args).then(fail);
    await expect(prepare(phase === "build" ? { prepare: build } : { validate: fail })).rejects.toBe(
      failure,
    );
  }
  const [record] = await list();
  expect(record?.status).toBe("preparing");
  if (phase !== "retire") {
    await collect();
  }
  expect(await list()).toHaveLength(uncertain ? 1 : 0);
  if (phase === "validate") {
    expect((await list())[0]).toMatchObject({ id: prepared?.id, status: "preparing" });
  }
  if (uncertain) {
    expect(await prepare()).toBeUndefined();
    if (phase === "build") {
      expect(await source(record!)).toBe("source");
    }
  }
});

it.each(["reservation", "lease"])("releases canceled %s handoffs", async (boundary) => {
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
  const pending = prepare({ options: { ...options, signal: controller.signal } });
  await expect(pending).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED" });
  handoff.mockRestore();
  await collect();
  expect(await list()).toEqual([]);
});

it("propagates unknown settlement after registry delivery", async () => {
  const prepared = await idle();
  const failure = new Error("native cleanup receipt missing");
  const unknown = { kind: "unknown" as const, error: failure };
  interceptWorktreeWorkerOperation(
    (execute) => execute,
    (input) => {
      const admit = input?.createAdmission;
      assert(admit);
      return {
        ...input,
        createAdmission: (retained) =>
          admit({ ...retained, settled: retained.settled.then(() => unknown) }),
      };
    },
  );
  await expect(
    templateRegistry.markTemplateReadyAsync(env, prepared!.id, 101, options.commitGuard),
  ).rejects.toMatchObject({ code: "outcome-unknown", cause: failure });
});
