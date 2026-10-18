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
    const absentSql = observeMainThreadSql();
    try {
      expect(await readTemplateAsync(env, template.cacheKey)).toBeUndefined();
      expect(await hasTemplatesAsync(env)).toBe(false);
      expect(await listTemplatesAsync(env)).toEqual([]);
      await reserveTemplateAsync(env, template, guard);
      expect(await readTemplateAsync(env, template.cacheKey)).toEqual(template);
      expect(await hasTemplatesAsync(env)).toBe(true);
      absentSql.expectIdle();
    } finally {
      absentSql.restore();
    }
    await expect(
      reserveTemplateAsync(env, { ...template, id: "contender" }, guard),
    ).rejects.toThrow();
    expect(await markTemplateReadyAsync(env, template.id, 20, guard)).toBe(true);
    await closeStateDatabaseForTest();
    expect(await readTemplateAsync(env, template.cacheKey)).toEqual({
      ...template,
      status: "ready",
      lastUsedAt: 20,
    });

    expect(await deleteTemplateAsync(env, template.id, guard)).toBe(true);
    const sql = observeMainThreadSql();
    try {
      const replacement = {
        ...template,
        id: "generation-2",
        path: path.join(template.worktreeRoot, "generation-2"),
      };
      await reserveTemplateAsync(env, replacement, guard);
      expect(await markTemplateReadyAsync(env, template.id, 30, guard)).toBe(false);
      expect(await deleteTemplateAsync(env, template.id, guard)).toBe(false);
      expect(await markTemplateReadyAsync(env, replacement.id, 40, guard)).toBe(true);
      expect(await listTemplatesAsync(env)).toEqual([
        { ...replacement, status: "ready", lastUsedAt: 40 },
      ]);
      await waitForDiagnosticEventsDrained();
      expect(readerQueues.length).toBeGreaterThan(0);
      expect(new Set(readerQueues)).toEqual(new Set(["stateRead"]));
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });

  it("admits readers only from retained ready generations and refuses retirement until they settle", async () => {
    await reserveTemplateAsync(env, template, guard);
    await markTemplateReadyAsync(env, template.id, 20, guard);
    const owner = { pid: 1, host: "synthetic-remote-owner", startedAt: null };
    const selection = {
      selection: {
        cacheKey: template.cacheKey,
        contentKey: template.contentKey,
        backend: template.backend,
      },
      key: "warm",
      owner,
    };
    expect(await retainTemplateReaderAsync(env, selection, guard)).toBeUndefined();
    await retainTemplateReaderAsync(env, { id: template.id, key: "first", owner }, guard);
    expect(
      await retainTemplateReaderAsync(
        env,
        { ...selection, selection: { ...selection.selection, contentKey: "other" } },
        guard,
      ),
    ).toBeUndefined();
    expect(await retainTemplateReaderAsync(env, selection, guard)).toEqual({
      ...template,
      status: "ready",
      lastUsedAt: 20,
    });
    expect(
      await retainTemplateReaderAsync(
        env,
        {
          id: template.id,
          key: "retire",
          owner,
          unpublish: true,
        },
        guard,
      ),
    ).toBeUndefined();
    await releaseTemplateReaderAsync(env, "first", guard);
    expect(
      await retainTemplateReaderAsync(
        env,
        {
          id: template.id,
          key: "retire",
          owner,
          unpublish: true,
        },
        guard,
      ),
    ).toBeUndefined();
    await releaseTemplateReaderAsync(env, "warm", guard);
    expect(
      await retainTemplateReaderAsync(
        env,
        {
          id: template.id,
          key: "retire",
          owner,
          unpublish: true,
        },
        guard,
      ),
    ).toMatchObject({ id: template.id });
    expect(await retainTemplateReaderAsync(env, selection, guard)).toBeUndefined();
    expect((await readTemplateAsync(env, template.cacheKey))?.status).toBe("preparing");
    await releaseTemplateReaderAsync(env, "retire", guard);
  });

  it("rolls back ready publication when custody is revoked at worker commit", async () => {
    await reserveTemplateAsync(env, template, guard);
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
    expect(await readTemplateAsync(env, template.cacheKey)).toEqual(template);
  });

  it("keeps template rows and reader custody in the worker's selected database", async () => {
    const selectedPath = path.join(env.OPENCLAW_STATE_DIR!, "selected.sqlite");
    const context = captureOpenClawStateWorkerContext({ env, path: selectedPath });
    const sql = observeMainThreadSql();
    try {
      await runOpenClawStateWorkerOperation(
        context,
        async (scope) => {
          await scope.execute({ type: "worktrees.templates.reserve", input: template });
          expect(
            await executeExistingOpenClawStateRead(
              { env, path: selectedPath },
              { type: "worktrees.templates.has", input: undefined },
              { context, current: true },
            ),
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
              owner: { pid: 1, host: "synthetic-remote-owner", startedAt: null },
              unpublish: true,
            },
          });
          expect(
            await executeExistingOpenClawStateRead(
              { env, path: selectedPath },
              { type: "worktrees.templates.read", input: { cacheKey: template.cacheKey } },
              { context, current: true },
            ),
          ).toMatchObject({
            type: "worktrees.templates.read",
            record: { ...template, lastUsedAt: 20 },
          });
          expect(
            await scope.execute({
              type: "worktrees.templates.hasReaders",
              input: { id: template.id },
            }),
          ).toBe(true);
          await scope.execute({
            type: "worktrees.templates.releaseReader",
            input: { key: "reader" },
          });
          expect(
            await scope.execute({
              type: "worktrees.templates.hasReaders",
              input: { id: template.id },
            }),
          ).toBe(false);
          await scope.execute({ type: "worktrees.templates.delete", input: { id: template.id } });
          expect(
            await executeExistingOpenClawStateRead(
              { env, path: selectedPath },
              { type: "worktrees.templates.list", input: undefined },
              { context, current: true },
            ),
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
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });
});
