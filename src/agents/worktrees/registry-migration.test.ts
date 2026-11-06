import { once } from "node:events";
import path from "node:path";
import { afterEach, expect, it, onTestFinished } from "vitest";
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
    ) VALUES (?, '0123456789abcdef', ?, ?, ?, 'HEAD', 'manual', 1, 1, ?)
  `);
  for (const id of ["legacy", "current"]) {
    insert.run(
      id,
      path.join(root, "repo"),
      path.join(root, id),
      `openclaw/${id}`,
      id === "legacy" ? null : "[]",
    );
  }
  const rewrite = {
    id: "current",
    fromPath: path.join(root, "current"),
    toPath: path.join(root, "moved"),
  };
  return {
    env,
    rewrite,
    discard: (ids = ["legacy"]) => discardLegacyRegistryWorktrees(env, ids),
    move: (rewrites = [rewrite]) => rewriteRegistryWorktreePathsForMigration(env, rewrites),
    rows: () => db.prepare("SELECT id, path FROM worktrees ORDER BY id").all(),
  };
}

it("refuses business writes when a Gateway acquires the root after schema preparation", async () => {
  const { env, rows, discard, move } = migrationFixture();
  const original = rows();
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
    env,
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
        for (const mutate of [discard, move]) {
          expect(mutate([])).toBe(0);
          expect.soft(() => mutate()).toThrow(StateSchemaMutationConflictError);
        }
        expect.soft(rows()).toEqual(original);
      } finally {
        child.stdin.end();
      }
    },
  });
  expect(result.code, result.stderr).toBe(0);
});

it.each(["offline", "inherited maintenance"] as const)("preserves %s migration", async (mode) => {
  const { env, rows, rewrite, discard, move } = migrationFixture();
  const facts = new Map();
  onTestFinished(
    worktreeRegistryPublication.subscribeFacts((change) => {
      if (change.kind === "committed") {
        for (const [key, fact] of change.receipt.facts) {
          facts.set(key, fact);
        }
      }
    }),
  );
  const migrate = () => {
    expect(discard()).toBe(1);
    expect(facts.get(JSON.stringify(["worktrees", "legacy"]))).toEqual({ kind: "absent" });
    expect(move()).toBe(1);
    expect(facts.get(JSON.stringify(["worktrees", "current"]))).toMatchObject({
      kind: "postimage",
      value: { id: "current", path: rewrite.toPath },
    });
  };
  if (mode === "inherited maintenance") {
    const owner = await acquireGatewayLock({
      env,
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
  expect(rows()).toEqual([{ id: "current", path: rewrite.toPath }]);
});
