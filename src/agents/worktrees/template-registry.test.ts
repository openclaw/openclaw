import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  deleteTemplate,
  listTemplates,
  markTemplateReady,
  readTemplate,
  reserveTemplate,
  touchTemplate,
  type WorktreeTemplateRecord,
} from "./template-registry.js";

describe("worktree template registry", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
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

  it("recovers an absent same-version table and fences stale replacement mutations", () => {
    const database = openOpenClawStateDatabase({ env });
    const databasePath = database.path;
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const older = new DatabaseSync(databasePath);
    older.exec("DROP TABLE IF EXISTS worktree_templates");
    older.close();

    reserveTemplate(env, template, guard);
    expect(() => reserveTemplate(env, { ...template, id: "contender" }, guard)).toThrow();
    expect(touchTemplate(env, template.id, 15, guard)).toBe(false);
    expect(markTemplateReady(env, template.id, 20, guard)).toBe(true);
    closeOpenClawStateDatabaseForTest();
    expect(readTemplate(env, template.cacheKey)).toEqual({
      ...template,
      status: "ready",
      lastUsedAt: 20,
    });

    expect(deleteTemplate(env, template.id, guard)).toBe(true);
    const replacement = {
      ...template,
      id: "generation-2",
      path: path.join(template.worktreeRoot, "generation-2"),
    };
    reserveTemplate(env, replacement, guard);
    expect(markTemplateReady(env, template.id, 30, guard)).toBe(false);
    expect(touchTemplate(env, template.id, 30, guard)).toBe(false);
    expect(deleteTemplate(env, template.id, guard)).toBe(false);
    expect(markTemplateReady(env, replacement.id, 40, guard)).toBe(true);
    expect(touchTemplate(env, replacement.id, 50, guard)).toBe(true);
    expect(listTemplates(env)).toEqual([{ ...replacement, status: "ready", lastUsedAt: 50 }]);
  });

  it("rechecks the allocation guard inside a mutation before publishing ready state", () => {
    reserveTemplate(env, template, guard);
    let admitted = false;
    const revokedAtAdmission = () => {
      if (admitted) {
        throw new Error("allocation lease lost");
      }
      admitted = true;
    };
    expect(() => markTemplateReady(env, template.id, 20, revokedAtAdmission)).toThrow(
      "allocation lease lost",
    );
    expect(readTemplate(env, template.cacheKey)).toEqual(template);
  });
});
