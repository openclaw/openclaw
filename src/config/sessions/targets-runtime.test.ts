import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as sqliteWorkerStore from "../../infra/sqlite-worker-store.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createAgentDatabaseInspectionRefusal,
  preparePendingAgentDatabase,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  getPendingOpenClawAgentDatabasePreparation,
  prepareOpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { replaceSessionEntry } from "./session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import {
  listKnownSessionStoreAgentIdsAsync,
  resolveAllAgentSessionStoreTargetsAsync,
  resolveExistingAgentSessionStoreTargetsAsync,
} from "./targets-runtime.js";

it("discovers committed owners and stores without executing host SQL", async () => {
  await withOpenClawTestState({ label: "target-discovery-worker" }, async (state) => {
    const storePath = path.join(state.root, "shared.sqlite");
    const cfg: OpenClawConfig = {
      session: { store: storePath },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "main" } },
        entries: { main: {}, ops: {} },
      },
    };
    const write = (agentId: string) =>
      replaceSessionEntry(
        { agentId, env: state.env, storePath, sessionKey: `agent:${agentId}:main` },
        { sessionId: `${agentId}-session`, updatedAt: 1 },
      );
    await write("main");
    expect(await resolveExistingAgentSessionStoreTargetsAsync(cfg, "ops", state)).toEqual([]);
    await write("ops");
    const observed = observeHostDataSql();
    try {
      expect(await resolveExistingAgentSessionStoreTargetsAsync(cfg, "ops", state)).toEqual([
        { agentId: "ops", storePath },
      ]);
      expect(await listKnownSessionStoreAgentIdsAsync(cfg, state)).toEqual(["main", "ops"]);
      expect(await resolveAllAgentSessionStoreTargetsAsync(cfg, state)).toContainEqual({
        agentId: "main",
        storePath,
      });
      expect(observed.queries).toEqual([]);
    } finally {
      observed.restore();
    }
  });
});

it.for(["canonical", "refused unsuffixed", "refused suffixed"] as const)(
  "discovers healthy stores while a refused agent's native database open is pending (%s)",
  async (layout, { signal }) => {
    await withOpenClawTestState({ label: "target-discovery-pending-open" }, async (state) => {
      const storePath = layout === "canonical" ? undefined : state.statePath("shared.json");
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "main" } },
          entries: { slow: {}, main: {}, ...(storePath ? { fresh: {} } : {}) },
        },
        ...(storePath ? { session: { store: storePath } } : {}),
      };
      const targets = ["slow", "main"].map((agentId) => ({
        agentId,
        storePath: storePath ?? path.join(state.sessionsDir(agentId), "sessions.json"),
      }));
      for (const target of targets) {
        await replaceSessionEntry(
          {
            ...target,
            defaultAgentId: layout === "refused unsuffixed" ? "slow" : "main",
            env: state.env,
            sessionKey: `agent:${target.agentId}:main`,
          },
          { sessionId: `${target.agentId}-session`, updatedAt: 1 },
        );
      }
      await closeOpenClawAgentDatabasesAsync(state.stateDir);
      const slow = targets[0]!;
      const slowDatabase = resolveSqliteTargetFromSessionStorePath(slow.storePath, {
        agentId: slow.agentId,
        env: state.env,
      }).path;
      const refusal = createAgentDatabaseInspectionRefusal({
        agentId: slow.agentId,
        paths: [slowDatabase],
        reason: "Database integrity check is running",
        pending: true,
      });
      recordAgentDatabaseAdmissions([refusal], state);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const open = sqliteWorkerStore.openAgentDatabaseSqliteWorkerStore;
      const openingGate = vi
        .spyOn(sqliteWorkerStore, "openAgentDatabaseSqliteWorkerStore")
        .mockImplementationOnce(async (...args) => {
          entered.resolve();
          await release.promise;
          return open(...args);
        });
      const opening = preparePendingAgentDatabase(
        refusal,
        { env: state.env, assertCurrent() {} },
        async () => {
          await prepareOpenClawAgentDatabaseExecution(
            { agentId: slow.agentId, path: slowDatabase, env: state.env },
            () => {},
          );
          expect(await resolveAllAgentSessionStoreTargetsAsync(cfg, state)).toEqual(
            expect.arrayContaining(targets),
          );
        },
      );
      try {
        await withinTest(entered.promise, signal);
        expect(getPendingOpenClawAgentDatabasePreparation(slowDatabase)).toBeDefined();
        expect(
          await withinTest(resolveAllAgentSessionStoreTargetsAsync(cfg, state), signal),
        ).toEqual(targets.slice(1));
        expect(fs.existsSync(state.statePath("shared.fresh.sqlite"))).toBe(false);
      } finally {
        release.resolve();
        openingGate.mockRestore();
        await opening;
      }
      expect(await resolveAllAgentSessionStoreTargetsAsync(cfg, state)).toEqual(
        expect.arrayContaining(targets),
      );
      expect(fs.existsSync(state.statePath("shared.fresh.sqlite"))).toBe(false);
    });
  },
);
