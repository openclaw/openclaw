import { realpathSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import * as fsSafe from "@openclaw/fs-safe/root";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { AGENT_LIFECYCLE_MUTATION_LEASE_SCOPE } from "../agents/agent-lifecycle-lease.js";
import { readWorkspaceStateSnapshot } from "../agents/workspace-state-store.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { createClawAgentAdoptionFixture } from "./add-agent-adoption.test-support.js";
import { withClawAgentMutationLease } from "./add-apply-lease.js";
import { applyClawAddPlan } from "./add.js";
import { persistClawPackageRef, readClawInstallRecord, readClawPackageRefs } from "./provenance.js";
import { readClawWorkspaceAdoption } from "./workspace-origin.js";
import { readClawWorkspaceFiles } from "./workspace.js";

vi.mock(import("@openclaw/fs-safe/root"), async (importOriginal) => ({
  ...(await importOriginal()),
}));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

it("runs one add operation under its agent lease", async () => {
  const root = tempDirs.make("openclaw-claw-add-lease-unit-");
  const env = { OPENCLAW_STATE_DIR: join(root, "state") };

  await expect(
    withClawAgentMutationLease("WORKER", { env }, async (lease) => {
      lease.assertOwned();
      return "owned";
    }),
  ).resolves.toBe("owned");
});

it("preserves files and ownership rows when the acquired add lease expires during rollback", async () => {
  const { root, plan, config } = await createClawAgentAdoptionFixture(
    tempDirs.make("openclaw-claw-add-lease-unit-"),
    {
      plugin: true,
      bootstrap: true,
      managedFile: true,
    },
  );
  const env = { OPENCLAW_STATE_DIR: join(root, "state") };
  const workspace = realpathSync(plan.agent.workspace);
  const originalConfig = structuredClone(config);
  const snapshot = async () => ({
    install: readClawInstallRecord("worker", { env }),
    workspaceFiles: readClawWorkspaceFiles("worker", { env }),
    packages: readClawPackageRefs({ env, agentId: "worker" }),
    origin: readClawWorkspaceAdoption("worker", workspace, { env }),
    setup: (await readWorkspaceStateSnapshot(workspace, { env })).setup,
    entries: (await readdir(workspace)).toSorted(),
    files: await Promise.all(
      ["BOOTSTRAP.md", "SKILL.md"].map(async (name) => {
        const path = join(workspace, name);
        const { dev, ino, birthtimeNs } = await lstat(path, { bigint: true });
        return { name, dev, ino, birthtimeNs, content: await readFile(path, "utf8") };
      }),
    ),
  });
  let beforeRollback: Awaited<ReturnType<typeof snapshot>> | undefined;
  let revoked = false;
  const successfulMoves: string[] = [];
  const successfulRemovals: string[] = [];
  let restoreRoot = () => {};
  const commitConfig = vi.fn(async () => {
    beforeRollback = await snapshot();
    const realRoot = fsSafe.root;
    const rootSpy = vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
      const opened = await realRoot(...args);
      if (opened.rootReal === workspace) {
        const move = opened.move.bind(opened);
        opened.move = async (from, to, options) => {
          if (from === "SKILL.md" && !revoked) {
            // Revoke the acquired grant after rollback admission, before its first real move.
            runOpenClawStateWriteTransaction(
              ({ db }) => {
                const expired = executeSqliteQuerySync(
                  db,
                  getNodeSqliteKysely<Pick<DB, "state_leases">>(db)
                    .updateTable("state_leases")
                    .set({ expires_at: 0 })
                    .where("scope", "=", AGENT_LIFECYCLE_MUTATION_LEASE_SCOPE)
                    .where("lease_key", "=", plan.agent.finalId)
                    .where("expires_at", ">", Date.now()),
                );
                expect(expired.numAffectedRows).toBe(1n);
              },
              { env },
            );
            revoked = true;
          }
          await move(from, to, options);
          successfulMoves.push(from);
        };
        const remove = opened.remove.bind(opened);
        opened.remove = async (...removeArgs) => {
          const result = await remove(...removeArgs);
          successfulRemovals.push(removeArgs[0]);
          return result;
        };
      }
      return opened;
    });
    restoreRoot = () => rootSpy.mockRestore();
    throw new Error("config claim failed");
  });

  try {
    await expect(
      applyClawAddPlan(plan, {
        env,
        consentPlanIntegrity: plan.planIntegrity,
        readConfig: () => config,
        installPackages: async (currentPlan, options) => [
          persistClawPackageRef(
            currentPlan,
            {
              kind: "plugin",
              source: "clawhub",
              ref: "@acme/audit",
              version: "1.0.0",
              integrity: `sha256:${"a".repeat(64)}`,
            },
            options,
          ),
        ],
        commitConfig,
      }),
    ).rejects.toMatchObject({
      code: "apply_lease_failed",
      message: expect.stringContaining("was lost"),
    });
    expect(commitConfig).toHaveBeenCalledOnce();
    expect(revoked).toBe(true);
    expect(successfulMoves).toEqual([]);
    expect(successfulRemovals).toEqual([]);
    expect(beforeRollback).toMatchObject({
      install: { status: "workspace_ready", agentClaimed: false },
      workspaceFiles: [{ path: "SKILL.md", status: "complete" }],
      packages: [{ ref: "@acme/audit", status: "complete" }],
      origin: {
        adopted: true,
        bootstrapSeeded: true,
        bootstrapPublication: expect.any(Object),
        filePublications: { "SKILL.md": expect.any(Object) },
      },
      setup: { bootstrapSeededAt: expect.any(String) },
      files: [
        { name: "BOOTSTRAP.md", content: "# First run\n" },
        { name: "SKILL.md", content: "managed by claw" },
      ],
    });
    expect(await snapshot()).toEqual(beforeRollback);
    expect(config).toEqual(originalConfig);
  } finally {
    restoreRoot();
  }
});
