import fs from "node:fs/promises";
import path from "node:path";
import { assert, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerOperations } from "../../state/openclaw-state-worker-contract.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import * as allocation from "./allocation.js";
import { useWorktreeStateRoots } from "./state-fixture.test-support.js";
import { collectWorktreeTemplates, prepareWorktreeTemplate } from "./template-cache.js";
import * as registry from "./template-registry-async.js";
import type { WorktreeTemplateRecord } from "./template-registry.js";
import { interceptWorktreeWorkerOperation } from "./worker-operation.test-support.js";

const directories = useWorktreeStateRoots();
const commitGuard = () => {};
const options = { commitGuard };
let env: NodeJS.ProcessEnv;
let template: WorktreeTemplateRecord & { status: "preparing" };
let params: Parameters<typeof prepareWorktreeTemplate>[0];
const prepare = (overrides: Partial<typeof params> = {}) =>
  prepareWorktreeTemplate({ ...params, ...overrides });
const collect = (onError?: Parameters<typeof collectWorktreeTemplates>[3]) =>
  collectWorktreeTemplates(env, 101, options, onError);
const list = () => registry.listTemplatesAsync(env);
const source = (record: { path: string }) => fs.readFile(path.join(record.path, "source"), "utf8");
async function idle() {
  const record = await prepare();
  await record?.release();
  return record;
}
function preparationGate() {
  const entered = createDeferred();
  const finish = createDeferred();
  const block =
    <Args extends unknown[], Result>(run: (...args: Args) => Promise<Result>) =>
    async (...args: Args) => {
      entered.resolve();
      await finish.promise;
      return await run(...args);
    };
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
  const retain = registry.retainTemplateReaderAsync;
  vi.spyOn(registry, "retainTemplateReaderAsync").mockImplementation(async (...args) => {
    const result = await retain(...args);
    if ("selection" in args[1]) {
      attempted.resolve();
    }
    return result;
  });
  return attempted.promise;
}

const read = () => registry.readTemplateAsync(env, template.cacheKey);
const reserve = (record = template) => registry.reserveTemplateAsync(env, record, commitGuard);
const ready = (id: string, now: number) =>
  registry.markTemplateReadyAsync(env, id, now, commitGuard);
const remove = (id: string) => registry.deleteTemplateAsync(env, id, commitGuard);
const published = (record = template, lastUsedAt = 20) => ({
  ...record,
  status: "ready",
  lastUsedAt,
});
const owner = { pid: 1, host: "synthetic-remote-owner", startedAt: null };

async function withoutMainThreadSql(run: () => Promise<void>) {
  const sql = observeMainThreadSql();
  try {
    await run();
    sql.expectIdle();
  } finally {
    sql.restore();
  }
}

function worker(databasePath?: string, revokeAtCommit = false) {
  const location = { env, path: databasePath };
  const context = captureOpenClawStateWorkerContext(location);
  return {
    read: (command: Parameters<typeof executeExistingOpenClawStateRead>[1]) =>
      executeExistingOpenClawStateRead(location, command, { context, current: true }),
    run: (operation: Parameters<typeof runOpenClawStateWorkerOperation>[1]) =>
      runOpenClawStateWorkerOperation(context, operation, {
        createAdmission: () => ({
          nativeLocations: [context.admission.databasePath],
          admission: createSqliteWorkerOperationAdmission((request, grant) => {
            context.admission.assertCurrent();
            if (revokeAtCommit && request.stage === "commit") {
              throw new Error("allocation lease lost");
            }
            grant();
          }),
        }),
      }),
  };
}

beforeEach(() => {
  const root = directories.make("openclaw-worktree-template-");
  env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  template = {
    cacheKey: "repository-volume",
    id: "generation-1",
    repoRoot: path.join(root, "repo"),
    commonDir: path.join(root, "repo", ".git"),
    worktreeRoot: path.join(root, "worktrees"),
    path: path.join(root, "templates", "generation-1"),
    backend: "btrfs",
    sourceCommit: "a".repeat(40),
    contentKey: "commit-1",
    status: "preparing",
    createdAt: 10,
    lastUsedAt: 10,
  };
  params = {
    ...template,
    env,
    now: () => 100,
    options,
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
  const first = prepare({ prepare: build, validate });
  await entered;
  const attempted = observeReaderAttempt();
  const second = prepare({ prepare: build, validate });
  await attempted;
  finish();
  const [left, right] = await Promise.all([first, second]);
  assert(left && right, "Both callers must acquire the prepared template");
  expect([left.id, left.status, right.status]).toEqual([right.id, "ready", "ready"]);
  const warm = await allocation.withWorktreeMutationLease(
    { env, ...options, id: `template:${params.cacheKey}` },
    () => prepare({ validate, options: { ...options, waitBudget: { remainingMs: 0 } } }),
  );
  expect(warm).toMatchObject({ id: left.id, path: left.path, status: "ready" });
  await warm?.release();
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
  expect(reused?.id === original?.id).toBe(!fail);
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
  const retain = registry.retainTemplateReaderAsync;
  const handoff =
    boundary === "reservation"
      ? vi.spyOn(registry, "retainTemplateReaderAsync").mockImplementation(async (...args) => {
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
    registry.markTemplateReadyAsync(env, prepared!.id, 101, options.commitGuard),
  ).rejects.toMatchObject({ code: "outcome-unknown", cause: failure });
});

it("reads absent templates without writer queueing and recovers on the first mutation", async ({
  onTestFinished,
}) => {
  const { path: databasePath } = openOpenClawStateDatabase({ env });
  await closeStateDatabaseForTest();
  await fs.rename(databasePath, `${databasePath}.template`);
  await fs.copyFile(`${databasePath}.template`, databasePath, fs.constants.COPYFILE_EXCL);
  const { DatabaseSync } = requireNodeSqlite();
  const older = new DatabaseSync(databasePath);
  older.exec("DROP TABLE IF EXISTS worktree_templates");
  older.close();

  const readerQueues = new Set<string>();
  const readRequests = new Set(
    ["read", "has", "list"].map((name) => `worktrees.templates.${name}`),
  );
  onTestFinished(
    onInternalDiagnosticEvent(
      (event) => {
        if (
          event.type === "worker.request" &&
          event.phase === "queued" &&
          readRequests.has(event.requestClass)
        ) {
          readerQueues.add(event.kind);
        }
      },
      { include: ["worker.request"] },
    ),
  );
  await withoutMainThreadSql(async () => {
    expect(await read()).toBeUndefined();
    expect(await registry.hasTemplatesAsync(env)).toBe(false);
    expect(await list()).toEqual([]);
    await reserve();
    expect(await read()).toEqual(template);
    expect(await registry.hasTemplatesAsync(env)).toBe(true);
  });
  await expect(reserve({ ...template, id: "contender" })).rejects.toThrow();
  expect(await ready(template.id, 20)).toBe(true);
  await closeStateDatabaseForTest();
  expect(await read()).toEqual(published());

  expect(await remove(template.id)).toBe(true);
  await withoutMainThreadSql(async () => {
    const replacement = {
      ...template,
      id: "generation-2",
      path: path.join(template.worktreeRoot, "generation-2"),
    };
    await reserve(replacement);
    expect(await ready(template.id, 30)).toBe(false);
    expect(await remove(template.id)).toBe(false);
    expect(await ready(replacement.id, 40)).toBe(true);
    expect(await list()).toEqual([published(replacement, 40)]);
    await waitForDiagnosticEventsDrained();
    expect(readerQueues).toEqual(new Set(["stateRead"]));
  });
});

it("rolls back ready publication when custody is revoked at worker commit", async () => {
  await reserve();
  await expect(
    worker(undefined, true).run((scope) =>
      scope.execute({
        type: "worktrees.templates.ready",
        input: { id: template.id, now: 20 },
      }),
    ),
  ).rejects.toThrow("allocation lease lost");
  expect(await read()).toEqual(template);
});

it("admits matching selections only while a ready generation has readers", async () => {
  await reserve();
  await ready(template.id, 20);
  const retain = (input: Parameters<typeof registry.retainTemplateReaderAsync>[1]) =>
    registry.retainTemplateReaderAsync(env, input, commitGuard);
  const release = (key: string) => registry.releaseTemplateReaderAsync(env, key, commitGuard);
  const retire = () => retain({ id: template.id, key: "retire", owner, unpublish: true });
  const selection = {
    selection: {
      cacheKey: template.cacheKey,
      contentKey: template.contentKey,
      backend: template.backend,
    },
    key: "warm",
    owner,
  };
  expect(await retain(selection)).toBeUndefined();
  await retain({ id: template.id, key: "first", owner });
  expect(
    await retain({ ...selection, selection: { ...selection.selection, contentKey: "other" } }),
  ).toBeUndefined();
  expect(await retain(selection)).toEqual(published());
  expect(await retire()).toBeUndefined();
  await release("first");
  expect(await retire()).toBeUndefined();
  await release("warm");
  expect(await retire()).toMatchObject({ id: template.id });
  expect(await retain(selection)).toBeUndefined();
  expect((await read())?.status).toBe("preparing");
  await release("retire");
});

it("keeps template rows and reader custody in the worker's selected database", async () => {
  const selectedPath = path.join(env.OPENCLAW_STATE_DIR!, "selected.sqlite");
  const selected = worker(selectedPath);
  await withoutMainThreadSql(async () => {
    await selected.run(async (scope) => {
      const execute = <Key extends keyof OpenClawStateWorkerOperations>(
        type: Key,
        input: OpenClawStateWorkerOperations[Key]["input"],
      ) => scope.execute({ type, input });
      await execute("worktrees.templates.reserve", template);
      await expect(
        selected.read({ type: "worktrees.templates.has", input: undefined }),
      ).resolves.toMatchObject({ has: true });
      await execute("worktrees.templates.ready", { id: template.id, now: 20 });
      await execute("worktrees.templates.retainReader", {
        id: template.id,
        key: "reader",
        owner,
        unpublish: true,
      });
      await expect(
        selected.read({ type: "worktrees.templates.read", input: { cacheKey: template.cacheKey } }),
      ).resolves.toMatchObject({ record: { ...template, lastUsedAt: 20 } });
      expect(await execute("worktrees.templates.hasReaders", { id: template.id })).toBe(true);
      await execute("worktrees.templates.releaseReader", { key: "reader" });
      expect(await execute("worktrees.templates.hasReaders", { id: template.id })).toBe(false);
      await execute("worktrees.templates.delete", { id: template.id });
      await expect(
        selected.read({ type: "worktrees.templates.list", input: undefined }),
      ).resolves.toMatchObject({ records: [] });
    });
  });
});
