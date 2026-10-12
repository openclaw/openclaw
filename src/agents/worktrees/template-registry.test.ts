import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import {
  deleteTemplateAsync,
  listTemplatesAsync,
  markTemplateReadyAsync,
  readTemplateAsync,
  reserveTemplateAsync,
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

  it("recovers an absent same-version table and fences stale replacement mutations", async () => {
    const database = openOpenClawStateDatabase({ env });
    const databasePath = database.path;
    await closeStateDatabaseForTest();
    await fs.rename(databasePath, `${databasePath}.template`);
    await fs.copyFile(`${databasePath}.template`, databasePath, fs.constants.COPYFILE_EXCL);
    const { DatabaseSync } = requireNodeSqlite();
    const older = new DatabaseSync(databasePath);
    older.exec("DROP TABLE IF EXISTS worktree_templates");
    older.close();

    await reserveTemplateAsync(env, template, guard);
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
      sql.expectIdle();
    } finally {
      sql.restore();
    }
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
          expect(await scope.execute({ type: "worktrees.templates.has", input: undefined })).toBe(
            true,
          );
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
            await scope.execute({
              type: "worktrees.templates.read",
              input: { cacheKey: template.cacheKey },
            }),
          ).toEqual({ ...template, lastUsedAt: 20 });
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
            await scope.execute({ type: "worktrees.templates.list", input: undefined }),
          ).toEqual([]);
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
