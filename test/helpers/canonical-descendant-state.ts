import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll } from "vitest";
import { resetConfigRuntimeState } from "../../src/config/runtime-snapshot.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../src/infra/kysely-sync.js";
import {
  captureStateDatabaseCoordinatorRuntime,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "../../src/infra/state-database-coordinator.js";
import { clearPluginStateStoreForTests } from "../../src/plugin-state/plugin-state-store.test-helpers.js";
import { AsyncWorkScope } from "../../src/shared/async-work-scope.js";
import type { DB as AgentDatabase } from "../../src/state/openclaw-agent-db.generated.js";
import { runOpenClawAgentWriteTransaction } from "../../src/state/openclaw-agent-db.js";
import type { DB as StateDatabase } from "../../src/state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../../src/state/openclaw-state-db.js";
import { captureEnv } from "../../src/test-utils/env.js";
import {
  createOpenClawTestState,
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../src/test-utils/openclaw-test-state.js";
import { drainSessionStateForTest } from "../../src/test-utils/session-state-cleanup.js";

function withFixtureCoordinator<T>(run: () => T): T {
  // Windows puts coordinator files below the temporary home; never lend their
  // handles to the process idle pool after the fixture closes its databases.
  return withStateDatabaseCoordinatorRuntimeDirectory(
    { ...captureStateDatabaseCoordinatorRuntime(), keepAlive: false },
    run,
  );
}

/** Keep admitted databases warm; native transports and registries remain case-owned. */
export function useCanonicalDescendantState(env: Record<string, string>) {
  let shared: OpenClawTestState;
  let sequence = 0;
  beforeAll(async () => {
    shared = await createOpenClawTestState({
      label: "canonical-descendant",
      env,
      applyEnv: false,
    });
  });
  afterAll(async () => {
    shared?.applyEnv();
    await withFixtureCoordinator(() => shared?.cleanup());
  });

  return async (run: (state: OpenClawTestState) => Promise<void>, isolated = false) => {
    if (isolated) {
      // Worker-claim cases also own placement/environment rows and projections.
      await withOpenClawTestState({ label: "canonical-descendant-worker", env }, run);
      return;
    }
    const previousEnv = captureEnv(Object.keys(shared.envVars));
    shared.applyEnv();
    return await withFixtureCoordinator(async () => {
      const work = new AsyncWorkScope();
      const workspaceDir = path.join(shared.workspaceDir, `case-${++sequence}`);
      try {
        await fs.mkdir(workspaceDir, { recursive: true });
        await work.track(() => run({ ...shared, workspaceDir }));
      } finally {
        try {
          await work.drain();
          await drainSessionStateForTest({ stateDir: shared.stateDir, rootPath: shared.root });
          // Cascades remove windows, transcript rows, and their indexes without
          // replacing admitted database handles or terminating their workers.
          runOpenClawAgentWriteTransaction(
            ({ db }) => {
              const kysely = getNodeSqliteKysely<AgentDatabase>(db);
              // FTS identities have no foreign key; their delete trigger clears search content.
              executeSqliteQuerySync(db, kysely.deleteFrom("session_transcript_fts_rows"));
              executeSqliteQuerySync(db, kysely.deleteFrom("session_nodes"));
            },
            { agentId: "main" },
          );
          runOpenClawStateWriteTransaction(({ db }) => {
            const kysely = getNodeSqliteKysely<StateDatabase>(db);
            for (const table of [
              "session_upstream_links",
              "session_watch_cursors",
              "session_state_events",
              "session_state_heads",
            ] as const) {
              executeSqliteQuerySync(db, kysely.deleteFrom(table));
            }
          });
          clearPluginStateStoreForTests();
          await fs.rm(workspaceDir, { recursive: true, force: true });
        } finally {
          previousEnv.restore();
          resetConfigRuntimeState();
        }
      }
    });
  };
}
