import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as worker from "../../infra/sqlite-worker-store.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as admission from "../../state/agent-database-admission.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import * as execution from "../../state/openclaw-agent-execution.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { replaceSessionEntry } from "./session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import {
  listKnownSessionStoreAgentIdsAsync as knownOwners,
  resolveAllAgentSessionStoreTargetsAsync as allTargets,
  resolveExistingAgentSessionStoreTargetsAsync as existingTargets,
} from "./targets-runtime.js";

type Entries = NonNullable<OpenClawConfig["agents"]>["entries"];
const config = (entries: Entries, store?: string): OpenClawConfig => ({
  agents: { ownership: "explicit", defaults: { sessionStore: { agentId: "main" } }, entries },
  ...(store ? { session: { store } } : {}),
});
type Scope = Parameters<typeof replaceSessionEntry>[0];
const write = (agentId: string, scope: Omit<Scope, "agentId" | "sessionKey">) =>
  replaceSessionEntry(
    { ...scope, agentId, sessionKey: `agent:${agentId}:main` },
    { sessionId: `${agentId}-session`, updatedAt: 1 },
  );

it("discovers committed owners and stores without executing host SQL", async () => {
  await withOpenClawTestState({ label: "target-discovery-worker" }, async (state) => {
    const storePath = state.path("shared.sqlite");
    const cfg = config({ main: {}, ops: {} }, storePath);
    const existing = () => existingTargets(cfg, "ops");
    await write("main", { env: state.env, storePath });
    expect(await existing()).toEqual([]);
    await write("ops", { env: state.env, storePath });
    const observed = observeHostDataSql();
    using _ = { [Symbol.dispose]: observed.restore };
    expect(await existing()).toEqual([{ agentId: "ops", storePath }]);
    expect(await knownOwners(cfg, state)).toEqual(["main", "ops"]);
    expect(await allTargets(cfg, state)).toContainEqual({ agentId: "main", storePath });
    expect(observed.queries).toEqual([]);
  });
});
it.for(["canonical", "refused unsuffixed", "refused suffixed"] as const)(
  "discovers healthy stores while a refused agent's native database open is pending (%s)",
  async (layout, { signal }) => {
    await withOpenClawTestState({ label: "target-discovery-pending-open" }, async (state) => {
      const storePath = layout === "canonical" ? undefined : state.statePath("shared.json");
      const cfg = config({ slow: {}, main: {}, ...(storePath ? { fresh: {} } : {}) }, storePath);
      const discover = () => allTargets(cfg, state);
      const targets = ["slow", "main"].map((agentId) => ({
        agentId,
        storePath: storePath ?? state.statePath("agents", agentId, "sessions", "sessions.json"),
      }));
      for (const target of targets) {
        await write(target.agentId, {
          storePath: target.storePath,
          defaultAgentId: layout === "refused unsuffixed" ? "slow" : "main",
          env: state.env,
        });
      }
      await closeOpenClawAgentDatabasesAsync(state.stateDir);
      const dbScope = { agentId: "slow", env: state.env };
      const db = resolveSqliteTargetFromSessionStorePath(targets[0]!.storePath, dbScope).path;
      const refusal = admission.createAgentDatabaseInspectionRefusal({
        agentId: dbScope.agentId,
        paths: [db],
        reason: "Database integrity check is running",
        pending: true,
      });
      admission.recordAgentDatabaseAdmissions([refusal], state);
      const [entered, release] = [createDeferredCore(), createDeferredCore()];
      const open = worker.openAgentDatabaseSqliteWorkerStore;
      const gate = vi.spyOn(worker, "openAgentDatabaseSqliteWorkerStore");
      gate.mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return open(...args);
      });
      const opening = admission.preparePendingAgentDatabase(
        refusal,
        { env: state.env, assertCurrent() {} },
        async () => {
          await execution.prepareOpenClawAgentDatabaseExecution({ ...dbScope, path: db }, () => {});
          expect(await discover()).toEqual(expect.arrayContaining(targets));
        },
      );
      try {
        await withinTest(entered.promise, signal);
        expect(execution.getPendingOpenClawAgentDatabasePreparation(db)).toBeDefined();
        expect(await withinTest(discover(), signal)).toEqual(targets.slice(1));
        expect(fs.existsSync(state.statePath("shared.fresh.sqlite"))).toBe(false);
      } finally {
        release.resolve();
        gate.mockRestore();
        await opening;
      }
      expect(await discover()).toEqual(expect.arrayContaining(targets));
      expect(fs.existsSync(state.statePath("shared.fresh.sqlite"))).toBe(false);
    });
  },
);
