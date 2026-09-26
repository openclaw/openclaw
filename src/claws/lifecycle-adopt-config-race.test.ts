// Adoption must acquire config admission before writing or claiming workspace files.
import { AsyncResource } from "node:async_hooks";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createConfigIO } from "../config/io.js";
import { mutateConfigFile, withConfigMutationExclusive } from "../config/mutate.js";
import { resetConfigRuntimeState } from "../config/runtime-snapshot.js";
import { closeIdleSqliteCoordinators } from "../infra/sqlite-coordinator.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { applyClawAddPlan } from "./add.js";
import { makeProvenancePlan, stateEnv } from "./provenance.test-helpers.js";
import { readClawWorkspaceFiles } from "./workspace.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    resetConfigRuntimeState();
    for (const dir of tempDirs.dirs) {
      closeIdleSqliteCoordinators(dir);
    }
    cleanup();
  });
});

beforeEach(() => resetConfigRuntimeState());

// Gates observe owner transitions rather than elapsed time.
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// The missing HEARTBEAT.md must stay absent, and matching SOUL.md must stay unclaimed.
async function expectUnclaimedWorkspace(workspace: string, env: NodeJS.ProcessEnv) {
  expect({
    files: await readdir(workspace),
    soul: await readFile(join(workspace, "SOUL.md"), "utf8"),
    ownedFiles: readClawWorkspaceFiles("worker", { env }),
  }).toEqual({ files: ["SOUL.md"], soul: "# Soul\n", ownedFiles: [] });
}

describe("applyClawAddPlan config admission exclusion", () => {
  it.each(["same-workspace", "ancestor", "descendant", "same-agent-id"] as const)(
    "does not write or claim files ahead of a queued %s collision",
    async (collision) => {
      const root = tempDirs.make("openclaw-claw-adopt-config-race-");
      const workspace = join(root, "adoption", "existing-workspace");
      const mainWorkspace = join(root, "main-workspace");
      const env = stateEnv(root);
      const configPath = join(env.OPENCLAW_STATE_DIR, "openclaw.json");
      await mkdir(join(root, "content"));
      await mkdir(workspace, { recursive: true });
      await mkdir(env.OPENCLAW_STATE_DIR);
      await writeFile(join(root, "content", "SOUL.md"), "# Soul\n");
      await writeFile(join(root, "content", "HEARTBEAT.md"), "# Heartbeat\n");
      await writeFile(join(workspace, "SOUL.md"), "# Soul\n");
      const initialConfig = `${JSON.stringify({
        gateway: { mode: "local" },
        agents: { entries: { main: { workspace: mainWorkspace } } },
      })}\n`;
      await writeFile(configPath, initialConfig);

      await withEnvAsync(
        {
          HOME: root,
          USERPROFILE: root,
          OPENCLAW_HOME: root,
          ...env,
          OPENCLAW_CONFIG_PATH: configPath,
        },
        async () => {
          const { plan } = await makeProvenancePlan(
            root,
            {
              schemaVersion: 1,
              agent: { id: "worker" },
              workspace: {
                bootstrapFiles: {
                  "SOUL.md": { source: "content/SOUL.md" },
                  "HEARTBEAT.md": { source: "content/HEARTBEAT.md" },
                },
              },
            },
            { workspace, adoptExistingWorkspace: true },
          );
          expect(plan.blockers).toEqual([]);
          expect(plan.actions).toContainEqual(
            expect.objectContaining({ kind: "workspaceFile", id: "SOUL.md", action: "adopt" }),
          );
          expect(plan.actions).toContainEqual(
            expect.objectContaining({ kind: "workspaceFile", id: "HEARTBEAT.md", action: "write" }),
          );
          await expectUnclaimedWorkspace(workspace, env);

          const competitorId = collision === "same-agent-id" ? "worker" : "other";
          const competitorWorkspace =
            collision === "ancestor"
              ? dirname(workspace)
              : collision === "descendant"
                ? join(workspace, "other-agent")
                : collision === "same-agent-id"
                  ? join(root, "other-workspace")
                  : workspace;
          const competitorEntry = { name: "Concurrent owner", workspace: competitorWorkspace };
          const entered = deferred();
          const release = deferred();
          const queued = deferred();
          let observeAdoption = false;
          // A restored call-through spy retains the original method and forwards its receiver.
          const enqueue = vi.spyOn(KeyedAsyncQueue.prototype, "enqueue");
          enqueue.mockRestore();
          const queueSpy = vi
            .spyOn(KeyedAsyncQueue.prototype, "enqueue")
            .mockImplementation(function (this: KeyedAsyncQueue, key, task, hooks) {
              // Call through unchanged. While the competitor is gated, only adoption can
              // enqueue this exact config path; unrelated queues cannot satisfy the gate.
              const pending = enqueue.call(this, key, task, hooks);
              if (observeAdoption && key === configPath) {
                queued.resolve();
              }
              return pending;
            });
          // The competitor owns its own async context; adoption must not inherit its
          // reentrant config lock. Publication is withheld until we inspect queued adoption.
          const context = new AsyncResource("claw-adoption-config-competitor");
          const competitor = context.runInAsyncScope(() =>
            withConfigMutationExclusive(async () => {
              entered.resolve();
              await release.promise;
              await mutateConfigFile({
                mutate: (draft) => {
                  draft.agents = {
                    ...draft.agents,
                    entries: { ...draft.agents?.entries, [competitorId]: competitorEntry },
                  };
                },
              });
            }),
          );
          const operations: Promise<unknown>[] = [competitor];
          const failures: unknown[] = [];
          try {
            await Promise.race([
              entered.promise,
              competitor.then(() => {
                throw new Error("Competing config writer settled before holding admission");
              }),
            ]);
            observeAdoption = true;
            const adoption = applyClawAddPlan(plan, {
              consentPlanIntegrity: plan.planIntegrity,
              env,
            });
            operations.push(adoption);
            await Promise.race([
              queued.promise,
              adoption.then(() => {
                throw new Error("Adoption settled without queuing for config admission");
              }),
            ]);

            // On the old path, the final config commit queues only after both file
            // effects. On the repaired path, admission queues before either effect.
            expect(await readFile(configPath, "utf8")).toBe(initialConfig);
            await expectUnclaimedWorkspace(workspace, env);
            release.resolve();
            await competitor;
            expect(await adoption).toMatchObject({
              status: "partial",
              configCommitted: false,
              workspaceFiles: [],
              error: {
                code: collision === "same-agent-id" ? "agent_id_collision" : "workspace_collision",
              },
            });
            await expectUnclaimedWorkspace(workspace, env);
            const snapshot = await createConfigIO({ configPath }).readConfigFileSnapshot();
            expect(snapshot.valid).toBe(true);
            expect(snapshot.sourceConfig.agents?.entries).toEqual({
              main: { workspace: mainWorkspace },
              [competitorId]: competitorEntry,
            });
          } catch (error) {
            failures.push(error);
          } finally {
            // Assertion failures must still release the real lock and join every writer
            // before the environment scope, database, or temporary directories disappear.
            release.resolve();
            try {
              const settled = await Promise.allSettled(operations);
              failures.push(
                ...settled.flatMap((result) =>
                  result.status === "rejected" ? [result.reason] : [],
                ),
              );
            } finally {
              queueSpy.mockRestore();
              context.emitDestroy();
            }
          }
          if (failures.length > 0) {
            throw new AggregateError(failures, "Config race assertions or operations failed");
          }
        },
      );
    },
  );
});
