import fs from "node:fs/promises";
import path from "node:path";
import { assert, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import * as allocation from "./allocation.js";
import { nativeWorktreeFilesystem } from "./filesystem-native.js";
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

it("loads, selects, and refreshes a v2026.11.2 template without staging fields", async () => {
  const id = "76860e96-3126-4e22-b32e-75a23b568937";
  const legacyPath = path.join(params.worktreeRoot, ".templates", id);
  await fs.mkdir(legacyPath, { recursive: true });
  await fs.writeFile(path.join(legacyPath, "source"), "source");
  const { path: databasePath } = openOpenClawStateDatabase({ env });
  await closeStateDatabaseForTest();
  await fs.rename(databasePath, `${databasePath}.template`);
  await fs.copyFile(`${databasePath}.template`, databasePath, fs.constants.COPYFILE_EXCL);
  const { DatabaseSync } = requireNodeSqlite();
  const released = new DatabaseSync(databasePath);
  try {
    // Released schema at v2026.11.2 (b556fdf457b0), independent of today's writer.
    released.exec(`
      DROP TABLE worktree_templates;
      CREATE TABLE worktree_templates (
        cache_key TEXT NOT NULL PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        repo_root TEXT NOT NULL,
        common_dir TEXT NOT NULL,
        worktree_root TEXT NOT NULL,
        path TEXT NOT NULL,
        backend TEXT NOT NULL,
        source_commit TEXT NOT NULL,
        content_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('preparing', 'ready')),
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      ) STRICT;
    `);
    released
      .prepare("INSERT INTO worktree_templates VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 10, 10)")
      .run(
        params.cacheKey,
        id,
        params.repoRoot,
        params.commonDir,
        params.worktreeRoot,
        legacyPath,
        params.backend,
        params.sourceCommit,
        params.contentKey,
      );
  } finally {
    released.close();
  }
  const original = { id, path: legacyPath, status: "ready", sourceCommit: params.sourceCommit };
  expect(await templateRegistry.readTemplateAsync(env, params.cacheKey)).toMatchObject(original);
  const build = vi.fn(params.prepare);
  const selected = await prepare({ prepare: build });
  expect(selected).toMatchObject(original);
  expect(build).not.toHaveBeenCalled();
  await selected?.release();
  const refreshed = await prepare({
    contentKey: "commit-2",
    sourceCommit: "b".repeat(40),
    prepare: build,
    refresh: async (existing, staged) => {
      expect(await templateRegistry.readTemplateAsync(env, params.cacheKey)).toMatchObject(
        original,
      );
      await fs.cp(existing.path, staged.path, { recursive: true });
      await fs.writeFile(path.join(staged.path, "source"), "updated");
      expect(await source(existing)).toBe("source");
      return true;
    },
  });
  assert(refreshed, "Released templates must support staged refresh");
  expect(refreshed.id).not.toBe(id);
  expect(await templateRegistry.readTemplateAsync(env, params.cacheKey)).toMatchObject({
    id: refreshed.id,
    status: "ready",
    sourceCommit: "b".repeat(40),
  });
  expect(await source(refreshed)).toBe("updated");
  expect(await source({ path: legacyPath })).toBe("source");
  expect(build).not.toHaveBeenCalled();
  await refreshed.release();
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
  // Replacement must not wait for filesystem retirement; GC owns the old generation.
  expect(await source(left)).toBe("changed");
  await collect();
  expect(await list()).toMatchObject([{ id: rebuilt.id }]);
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
  let attempts = 0;
  const next: Partial<typeof params> = {
    contentKey: "commit-2",
    sourceCommit: "b".repeat(40),
    refresh: block(async (existing: { path: string }, record: { path: string }) => {
      await fs.cp(existing.path, record.path, { recursive: true });
      await fs.writeFile(path.join(record.path, "source"), "updated");
      if (fail && attempts++ === 0) {
        throw failure;
      }
      return true;
    }),
  };
  const refreshing = prepare(next);
  await entered;
  expect(await templateRegistry.readTemplateAsync(env, params.cacheKey)).toMatchObject({
    id: original?.id,
    status: "ready",
    contentKey: params.contentKey,
  });
  const concurrent = prepare(next);
  const rejected = fail ? expect(refreshing).rejects.toBe(failure) : undefined;
  finish();
  const refreshed = fail ? (await rejected, undefined) : await refreshing;
  const reused = await concurrent;
  expect(reused?.id).not.toBe(original?.id);
  expect(await source(original!)).toBe("source");
  expect(await source(reused!)).toBe("updated");
  await refreshed?.release();
  expect(await templateRegistry.readTemplateAsync(env, params.cacheKey)).toMatchObject({
    status: "ready",
    contentKey: next.contentKey,
    sourceCommit: next.sourceCommit,
  });
  await reused?.release();
});

it.each(["validation", "replacement"])(
  "keeps the last-good generation when %s is interrupted before a resumed burst",
  async (phase) => {
    const original = await idle();
    const controller = new AbortController();
    const { entered, finish, validate, prepare: build } = preparationGate();
    const interrupted = prepare({
      options: { ...options, signal: controller.signal },
      ...(phase === "validation" ? { validate } : { backend: "replacement", prepare: build }),
    });
    await entered;
    const rejection = expect(interrupted).rejects.toMatchObject({
      code: "OPENCLAW_STATE_LEASE_ABORTED",
    });
    controller.abort();
    finish();
    await rejection;
    expect(await templateRegistry.readTemplateAsync(env, params.cacheKey)).toMatchObject({
      id: original?.id,
      status: "ready",
    });
    const rebuild = vi.fn(params.prepare);
    const resumed = await Promise.all(
      Array.from({ length: 20 }, () => prepare({ prepare: rebuild })),
    );
    expect(resumed.map((record) => record?.id)).toEqual(Array(20).fill(original?.id));
    expect(rebuild).not.toHaveBeenCalled();
    await Promise.all(resumed.map(async (record) => await record?.release()));
  },
);

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
  { phase: "refresh", uncertain: true },
  { phase: "retire", uncertain: false },
  { phase: "retire", uncertain: true },
])("retains $phase custody ($uncertain)", async ({ phase, uncertain }) => {
  const prepared = phase === "build" ? undefined : await idle();
  const failure = uncertain ? new CommandProcessCleanupError() : new Error("settled");
  if (phase === "retire") {
    vi.spyOn(nativeWorktreeFilesystem, "remove").mockImplementationOnce(async (directory) => {
      await fs.unlink(path.join(directory, "source"));
      throw failure;
    });
    const onError = vi.fn();
    await collect(onError);
    expect(onError).toHaveBeenCalledWith(failure, prepared?.id);
  } else {
    const fail = () => Promise.reject(failure);
    const build: typeof params.prepare = (...args) => params.prepare(...args).then(fail);
    await expect(
      prepare(
        phase === "build"
          ? { prepare: build }
          : phase === "refresh"
            ? {
                contentKey: "commit-2",
                refresh: (_existing, record, guard) => build(record, guard).then(() => true),
              }
            : { validate: fail },
      ),
    ).rejects.toBe(failure);
  }
  if (phase === "refresh") {
    await collect();
    expect(await list()).toHaveLength(2);
    expect(await templateRegistry.readTemplateAsync(env, params.cacheKey)).toMatchObject({
      id: prepared?.id,
      status: "ready",
    });
    expect(await source(prepared!)).toBe("source");
    return;
  }
  const [record] = await list();
  expect(record?.status).toBe("preparing");
  if (phase !== "retire" || !uncertain) {
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

it.each(["nested", "template"])(
  "retires only the selected template with a %s symlink",
  async (link) => {
    const retired = await idle();
    const sibling = await prepare({ cacheKey: "other-volume" });
    assert(retired && sibling);
    const outside = directories.make("outside-template-root-");
    await fs.writeFile(path.join(outside, "source"), "outside bytes");
    if (link === "template") {
      await fs.rename(retired.path, `${retired.path}-preserved`);
      await fs.symlink(outside, retired.path, "junction");
    } else {
      await fs.mkdir(path.join(retired.path, "node_modules"));
      await fs.symlink(outside, path.join(retired.path, "node_modules", "outside"), "junction");
      await fs.symlink(path.join(outside, "source"), path.join(retired.path, "file-link"));
    }
    try {
      await collect();
      await expect(fs.lstat(retired.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await source(sibling)).toBe("source");
      expect(await source({ path: outside })).toBe("outside bytes");
      expect(await list()).toMatchObject([{ id: sibling.id }]);
      if (link === "template") {
        expect(await source({ path: `${retired.path}-preserved` })).toBe("source");
      }
    } finally {
      await sibling.release();
    }
  },
);

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
