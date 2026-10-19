import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import {
  deleteTemplateAsync,
  hasTemplatesAsync,
  listTemplatesAsync,
  markTemplateReadyAsync,
  readTemplateAsync,
  reserveTemplateAsync,
  retainTemplateReaderAsync,
  releaseTemplateReaderAsync,
} from "./template-registry-async.js";
import type { WorktreeTemplateRecord } from "./template-registry.js";

describe("worktree template registry", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      await closeStateDatabaseForTest();
      cleanup();
    }),
  );
  let env: NodeJS.ProcessEnv;
  let template: WorktreeTemplateRecord & { status: "preparing" };
  const guard = () => {};
  const read = () => readTemplateAsync(env, template.cacheKey);
  const list = () => listTemplatesAsync(env);
  const reserve = (record = template) => reserveTemplateAsync(env, record, guard);
  const ready = (id: string, now: number) => markTemplateReadyAsync(env, id, now, guard);
  const remove = (id: string) => deleteTemplateAsync(env, id, guard);
  const release = (key: string) => releaseTemplateReaderAsync(env, key, guard);
  const owner = { pid: 1, host: "synthetic-remote-owner", startedAt: null };
  const retain = (input: Parameters<typeof retainTemplateReaderAsync>[1]) =>
    retainTemplateReaderAsync(env, input, guard);
  const retire = () => retain({ id: template.id, key: "retire", owner, unpublish: true });

  async function withoutMainThreadSql(run: () => Promise<void>) {
    const sql = observeMainThreadSql();
    try {
      await run();
      sql.expectIdle();
    } finally {
      sql.restore();
    }
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
    const database = openOpenClawStateDatabase({ env });
    const databasePath = database.path;
    await closeStateDatabaseForTest();
    await fs.rename(databasePath, `${databasePath}.template`);
    await fs.copyFile(`${databasePath}.template`, databasePath, fs.constants.COPYFILE_EXCL);
    const { DatabaseSync } = requireNodeSqlite();
    const older = new DatabaseSync(databasePath);
    older.exec("DROP TABLE IF EXISTS worktree_templates");
    older.close();

    const readerQueues: string[] = [];
    onTestFinished(
      onInternalDiagnosticEvent(
        (event) => {
          if (
            event.type === "worker.request" &&
            event.phase === "queued" &&
            [
              "worktrees.templates.read",
              "worktrees.templates.has",
              "worktrees.templates.list",
            ].includes(event.requestClass)
          ) {
            readerQueues.push(event.kind);
          }
        },
        { include: ["worker.request"] },
      ),
    );
    await withoutMainThreadSql(async () => {
      expect(await read()).toBeUndefined();
      expect(await hasTemplatesAsync(env)).toBe(false);
      expect(await list()).toEqual([]);
      await reserve();
      expect(await read()).toEqual(template);
      expect(await hasTemplatesAsync(env)).toBe(true);
    });
    await expect(reserve({ ...template, id: "contender" })).rejects.toThrow();
    expect(await ready(template.id, 20)).toBe(true);
    await closeStateDatabaseForTest();
    expect(await read()).toEqual({
      ...template,
      status: "ready",
      lastUsedAt: 20,
    });

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
      expect(await list()).toEqual([{ ...replacement, status: "ready", lastUsedAt: 40 }]);
      await waitForDiagnosticEventsDrained();
      expect(readerQueues.length).toBeGreaterThan(0);
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
    expect(await retain(selection)).toEqual({
      ...template,
      status: "ready",
      lastUsedAt: 20,
    });
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
    const context = captureOpenClawStateWorkerContext({ env });
    await expect(
      runOpenClawStateWorkerOperation(
        context,
        (scope) =>
          scope.execute({
            type: "worktrees.templates.ready",
            input: { id: template.id, now: 20 },
          }),
        {
          createAdmission: () => ({
            nativeLocations: [context.admission.databasePath],
            admission: createSqliteWorkerOperationAdmission((request, grant) => {
              context.admission.assertCurrent();
              if (request.stage === "commit") {
                throw new Error("allocation lease lost");
              }
              grant();
            }),
          }),
        },
      ),
    ).rejects.toThrow("allocation lease lost");
    expect(await read()).toEqual(template);
  });

  it("keeps template rows and reader custody in the worker's selected database", async () => {
    const selectedPath = path.join(env.OPENCLAW_STATE_DIR!, "selected.sqlite");
    const context = captureOpenClawStateWorkerContext({ env, path: selectedPath });
    const readSelected = (command: Parameters<typeof executeExistingOpenClawStateRead>[1]) =>
      executeExistingOpenClawStateRead({ env, path: selectedPath }, command, {
        context,
        current: true,
      });
    await withoutMainThreadSql(async () => {
      await runOpenClawStateWorkerOperation(
        context,
        async (scope) => {
          const hasReaders = () =>
            scope.execute({
              type: "worktrees.templates.hasReaders",
              input: { id: template.id },
            });
          await scope.execute({ type: "worktrees.templates.reserve", input: template });
          expect(
            await readSelected({ type: "worktrees.templates.has", input: undefined }),
          ).toMatchObject({ type: "worktrees.templates.has", has: true });
          await scope.execute({
            type: "worktrees.templates.ready",
            input: { id: template.id, now: 20 },
          });
          await scope.execute({
            type: "worktrees.templates.retainReader",
            input: {
              id: template.id,
              key: "reader",
              owner,
              unpublish: true,
            },
          });
          expect(
            await readSelected({
              type: "worktrees.templates.read",
              input: { cacheKey: template.cacheKey },
            }),
          ).toMatchObject({
            type: "worktrees.templates.read",
            record: { ...template, lastUsedAt: 20 },
          });
          expect(await hasReaders()).toBe(true);
          await scope.execute({
            type: "worktrees.templates.releaseReader",
            input: { key: "reader" },
          });
          expect(await hasReaders()).toBe(false);
          await scope.execute({ type: "worktrees.templates.delete", input: { id: template.id } });
          expect(
            await readSelected({ type: "worktrees.templates.list", input: undefined }),
          ).toMatchObject({ type: "worktrees.templates.list", records: [] });
        },
        {
          createAdmission: () => ({
            nativeLocations: [selectedPath],
            admission: createSqliteWorkerOperationAdmission((_request, grant) => {
              context.admission.assertCurrent();
              grant();
            }),
          }),
        },
      );
    });
  });
});
