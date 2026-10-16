import { once } from "node:events";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCliProcessChild } from "../../cli/cli-process-child.test-helpers.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { StateSchemaMutationConflictError } from "../../infra/state-database-maintenance.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { worktreeRegistryPublication } from "./registry-publication.js";
import {
  discardLegacyRegistryWorktrees,
  rewriteRegistryWorktreePathsForMigration,
} from "./registry.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseAsync());

function migrationFixture() {
  const root = tempDirs.make("openclaw-worktree-migration-owner-");
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  };
  const { db } = openOpenClawStateDatabase({ env });
  const insert = db.prepare(`
    INSERT INTO worktrees (
      id, repo_fingerprint, repo_root, path, branch, base_ref,
      owner_kind, created_at, last_active_at, provisioned_paths_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const id of ["legacy", "current"]) {
    insert.run(
      id,
      "0123456789abcdef",
      path.join(root, "repo"),
      path.join(root, id),
      `openclaw/${id}`,
      "HEAD",
      "manual",
      1,
      1,
      id === "legacy" ? null : "[]",
    );
  }
  return {
    env,
    rewrite: {
      id: "current",
      fromPath: path.join(root, "current"),
      toPath: path.join(root, "moved"),
    },
    rows: () =>
      openOpenClawStateDatabase({ env })
        .db.prepare("SELECT id, path FROM worktrees ORDER BY id")
        .all(),
  };
}

describe("native worktree migration ownership", () => {
  it("refuses business writes when a Gateway acquires the root after schema preparation", async () => {
    const fixture = migrationFixture();
    const original = fixture.rows();
    const ready = createDeferred();
    const lockModule = resolveRuntimeWorkerUrl({
      currentModuleUrl: import.meta.url,
      sourceWorkerName: "../../infra/gateway-lock",
      distWorkerPath: "infra/gateway-lock.js",
    });
    const result = await runCliProcessChild({
      nodeArgs: [
        ...resolveRuntimeWorkerArgv(lockModule).slice(0, -1),
        "--input-type=module",
        "--eval",
        `import { once } from "node:events";
         import { acquireGatewayLock } from ${JSON.stringify(lockModule.href)};
         const owner = await acquireGatewayLock({ allowInTests: true, timeoutMs: 0 });
         if (!owner) throw new Error("Synthetic Gateway owner was not acquired");
         try {
           const stopped = once(process.stdin, "end");
           process.stdin.resume();
           process.stdout.write("held\\n");
           await stopped;
         } finally {
           await owner.release();
         }`,
      ],
      env: fixture.env,
      onStdout: (text) => {
        if (text.includes("held")) {
          ready.resolve();
        }
      },
      interact: async (child) => {
        try {
          await awaitGateBeforeSettlement(
            ready.promise,
            once(child, "exit"),
            "Foreign Gateway owner exited before acquiring custody",
          );
          expect(discardLegacyRegistryWorktrees(fixture.env, [])).toBe(0);
          expect(rewriteRegistryWorktreePathsForMigration(fixture.env, [])).toBe(0);
          expect
            .soft(() => discardLegacyRegistryWorktrees(fixture.env, ["legacy"]))
            .toThrow(StateSchemaMutationConflictError);
          expect
            .soft(() => rewriteRegistryWorktreePathsForMigration(fixture.env, [fixture.rewrite]))
            .toThrow(StateSchemaMutationConflictError);
          expect.soft(fixture.rows()).toEqual(original);
        } finally {
          child.stdin.end();
        }
      },
    });
    expect(result.code, result.stderr).toBe(0);
  });

  it.each(["offline", "inherited maintenance"] as const)("preserves %s migration", async (mode) => {
    const fixture = migrationFixture();
    const facts = new Map();
    const unsubscribe = worktreeRegistryPublication.subscribeFacts((change) => {
      if (change.kind === "committed") {
        for (const [key, fact] of change.receipt.facts) {
          facts.set(key, fact);
        }
      }
    });
    const migrate = () => {
      expect(discardLegacyRegistryWorktrees(fixture.env, ["legacy"])).toBe(1);
      expect(facts.get(JSON.stringify(["worktrees", "legacy"]))).toEqual({ kind: "absent" });
      expect(rewriteRegistryWorktreePathsForMigration(fixture.env, [fixture.rewrite])).toBe(1);
      expect(facts.get(JSON.stringify(["worktrees", "current"]))).toMatchObject({
        kind: "postimage",
        value: { id: "current", path: fixture.rewrite.toPath },
      });
    };
    try {
      if (mode === "inherited maintenance") {
        const owner = await acquireGatewayLock({
          env: fixture.env,
          role: "sqlite-maintenance",
          allowInTests: true,
          timeoutMs: 0,
        });
        expect(owner).not.toBeNull();
        try {
          owner!.run(migrate);
        } finally {
          await owner?.release();
        }
      } else {
        migrate();
      }
      expect(fixture.rows()).toEqual([{ id: "current", path: fixture.rewrite.toPath }]);
    } finally {
      unsubscribe();
    }
  });
});
