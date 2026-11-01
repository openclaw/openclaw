import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerOperations } from "../../state/openclaw-state-worker-contract.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { expectNoMainThreadSql as withoutMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { useWorktreeStateRoots } from "./state-fixture.test-support.js";
import * as registry from "./template-registry-async.js";
import type { WorktreeTemplateRecord } from "./template-registry.js";

const tempDirs = useWorktreeStateRoots();
let env: NodeJS.ProcessEnv;
let template: WorktreeTemplateRecord & { status: "preparing" };
const guard = () => {};
const read = () => registry.readTemplateAsync(env, template.cacheKey);
const list = () => registry.listTemplatesAsync(env);
const reserve = (record = template) => registry.reserveTemplateAsync(env, record, guard);
const ready = (id: string, now: number) => registry.markTemplateReadyAsync(env, id, now, guard);
const remove = (id: string) => registry.deleteTemplateAsync(env, id, guard);
const release = (key: string) => registry.releaseTemplateReaderAsync(env, key, guard);
const published = (record = template, lastUsedAt = 20) => ({
  ...record,
  status: "ready",
  lastUsedAt,
});
const owner = { pid: 1, host: "synthetic-remote-owner", startedAt: null };
const retain = (input: Parameters<typeof registry.retainTemplateReaderAsync>[1]) =>
  registry.retainTemplateReaderAsync(env, input, guard);
const retire = () => retain({ id: template.id, key: "retire", owner, unpublish: true });

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
  const root = tempDirs.make("openclaw-worktree-template-registry-");
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
    contentKey: "checkout-inputs",
    status: "preparing",
    createdAt: 10,
    lastUsedAt: 10,
  };
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

  const readerQueues: string[] = [];
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
          readerQueues.push(event.kind);
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
    expect(new Set(readerQueues)).toEqual(new Set(["stateRead"]));
  });
});

it("admits readers only from retained ready generations and refuses retirement until they settle", async () => {
  await reserve();
  await ready(template.id, 20);
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
      expect(
        await selected.read({ type: "worktrees.templates.has", input: undefined }),
      ).toMatchObject({ type: "worktrees.templates.has", has: true });
      await execute("worktrees.templates.ready", { id: template.id, now: 20 });
      await execute("worktrees.templates.retainReader", {
        id: template.id,
        key: "reader",
        owner,
        unpublish: true,
      });
      expect(
        await selected.read({
          type: "worktrees.templates.read",
          input: { cacheKey: template.cacheKey },
        }),
      ).toMatchObject({
        type: "worktrees.templates.read",
        record: { ...template, lastUsedAt: 20 },
      });
      expect(await execute("worktrees.templates.hasReaders", { id: template.id })).toBe(true);
      await execute("worktrees.templates.releaseReader", { key: "reader" });
      expect(await execute("worktrees.templates.hasReaders", { id: template.id })).toBe(false);
      await execute("worktrees.templates.delete", { id: template.id });
      expect(
        await selected.read({ type: "worktrees.templates.list", input: undefined }),
      ).toMatchObject({ type: "worktrees.templates.list", records: [] });
    });
  });
});
