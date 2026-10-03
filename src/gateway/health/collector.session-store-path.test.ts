import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import * as configRuntime from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { spyOnSessionStoreSummaries } from "../../config/sessions/session-store-summary.test-support.js";
import { historyLane } from "../../config/sessions/session-transcript-worker-resources.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { recordAgentDatabaseAdmissions } from "../../state/agent-database-admission.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  buildHealthAgentSummaries,
  collectGatewayHealthSnapshot,
  resolveHealthAgentOrder,
} from "./collector.js";

vi.mock("../../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: () => [],
}));

async function summarizeStore(storePath: string, agentId: string) {
  const cfg: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { [agentId]: {} } },
    session: { store: storePath },
  };
  const agents = await buildHealthAgentSummaries(cfg, resolveHealthAgentOrder(cfg));
  return expectDefined(agents[0], "health agent summary").sessions;
}

describe("health session store paths", () => {
  const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-health-session-store-");

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeStateDatabaseForTest();
  });

  it("reports the SQLite database that supplied the session count", async () => {
    const stateDir = tempDirs.make();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "main";
    const storePath = resolveSessionStorePathCore(undefined, { agentId, env });
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId, env });

    await sessionAccessor.upsertSessionEntryCore(
      { agentId, env, sessionKey: `agent:${agentId}:main`, storePath },
      { sessionId: "session-1", updatedAt: 10 },
    );
    await closeOpenClawAgentDatabasesAsync(stateDir);
    closeOpenClawAgentDatabasesForTest(stateDir);

    const summary = await summarizeStore(storePath, agentId);

    expect(summary.count).toBe(1);
    expect(summary.path).toBe(databasePath);
    expect(fs.existsSync(summary.path)).toBe(true);
  });

  it.each(["agent", "shared"] as const)(
    "counts and orders bounded %s summaries without main-thread SQLite",
    async (layout) => {
      const stateDir = tempDirs.make();
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const agentIds = layout === "shared" ? ["main", "other"] : ["main"];
      const storePath =
        layout === "shared"
          ? path.join(stateDir, "shared.sqlite")
          : resolveSessionStorePathCore(undefined, { agentId: "main", env });
      const now = vi.spyOn(Date, "now");
      for (const agentId of agentIds) {
        for (const timestamp of [30, 70, 10, 60, 40, 20, 50]) {
          const updatedAt = timestamp + (agentId === "other" ? 100 : 0);
          now.mockReturnValue(updatedAt);
          await sessionAccessor.upsertSessionEntryCore(
            { agentId, env, sessionKey: `agent:${agentId}:session-${timestamp}`, storePath },
            {
              sessionId: `session-${agentId}-${timestamp}`,
              updatedAt,
              skillsSnapshot: { prompt: "large runtime prompt", skills: [{ name: "demo" }] },
            },
          );
        }
      }
      const inspectedAt = layout === "shared" ? 200 : 100;
      now.mockReturnValue(inspectedAt);
      // Cold-open canonical validation is separate from the warm health projection.
      sessionAccessor.loadExactSessionEntryReadOnly({
        agentId: "main",
        env,
        sessionKey: "agent:main:session-70",
        storePath,
      });
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: Object.fromEntries(agentIds.map((agentId) => [agentId, {}])),
        },
        session: { store: storePath },
      };

      const agents = await buildHealthAgentSummaries(cfg, resolveHealthAgentOrder(cfg));

      expect(prepare).not.toHaveBeenCalled();
      expect(agents.map((agent) => agent.agentId)).toEqual(agentIds);
      for (const agent of agents) {
        expect(agent.sessions).toMatchObject({
          count: 7,
          recent: [70, 60, 50, 40, 30].map((timestamp) => {
            const updatedAt = timestamp + (agent.agentId === "other" ? 100 : 0);
            return {
              key: `agent:${agent.agentId}:session-${timestamp}`,
              updatedAt,
              age: inspectedAt - updatedAt,
            };
          }),
        });
      }
    },
  );

  it.each(["template", "shared"] as const)(
    "scopes %s stores and recovers from transient reads",
    async (layout) => {
      const stateDir = tempDirs.make();
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const storeTemplate = path.join(
        stateDir,
        "stores",
        layout === "shared" ? "shared.sqlite" : "{agentId}/sessions.json",
      );
      const populatedAgentId = "helper";
      const populatedStorePath = resolveSessionStorePathCore(storeTemplate, {
        agentId: populatedAgentId,
        env,
      });
      const populatedDatabasePath = resolveSqliteTargetFromSessionStorePath(populatedStorePath, {
        agentId: populatedAgentId,
        env,
      }).path;

      expect(populatedStorePath).toBe(
        layout === "shared"
          ? path.join(stateDir, "stores", "shared.sqlite")
          : path.join(stateDir, "stores", populatedAgentId, "sessions.json"),
      );
      await sessionAccessor.upsertSessionEntryCore(
        {
          agentId: populatedAgentId,
          env,
          sessionKey: `agent:${populatedAgentId}:main`,
          storePath: populatedStorePath,
        },
        { sessionId: "session-1", updatedAt: 10 },
      );
      await closeOpenClawAgentDatabasesAsync(stateDir);
      closeOpenClawAgentDatabasesForTest(stateDir);

      const populated = await summarizeStore(populatedStorePath, populatedAgentId);
      const emptyAgentId = "third";
      const emptyStorePath = resolveSessionStorePathCore(storeTemplate, {
        agentId: emptyAgentId,
        env,
      });
      const empty = await summarizeStore(emptyStorePath, emptyAgentId);

      expect(populated).toMatchObject({ count: 1, path: populatedDatabasePath });
      expect(fs.existsSync(populated.path)).toBe(true);
      expect(empty).toMatchObject({
        count: 0,
        path: resolveSqliteTargetFromSessionStorePath(emptyStorePath, {
          agentId: emptyAgentId,
          env,
        }).path,
      });

      vi.spyOn(configRuntime, "getRuntimeConfig").mockReturnValue({
        agents: { ownership: "explicit", entries: { helper: {}, third: {} } },
        session: { store: storeTemplate },
      });
      const { calls: reads } = spyOnSessionStoreSummaries();
      const collect = () => collectGatewayHealthSnapshot({ audience: "admin", probe: false });
      const summary = await collect();
      expect(summary.agents.map((agent) => [agent.agentId, agent.sessions.count])).toEqual([
        [populatedAgentId, 1],
        [emptyAgentId, 0],
      ]);
      expect(summary.sessions).toEqual(summary.agents[0]?.sessions);
      expect(reads).toHaveBeenCalledTimes(layout === "shared" ? 1 : 2);

      reads
        .mockClear()
        .mockRejectedValueOnce(
          Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
        );
      expect((await collect()).agents.map((agent) => agent.sessions.count)).toEqual([0, 0]);
      expect(reads).toHaveBeenCalledTimes(layout === "shared" ? 1 : 2);
      expect((await collect()).agents.map((agent) => agent.sessions.count)).toEqual([1, 0]);

      const fatal = new Error("invalid session state");
      reads.mockRejectedValueOnce(fatal);
      await expect(collect()).rejects.toBe(fatal);
    },
  );

  it.each(["admission-refused", "owner-closed"] as const)(
    "does not publish a delayed worker summary after %s",
    async (change) => {
      const stateDir = tempDirs.make();
      const storePath = resolveSessionStorePathCore(undefined, {
        agentId: "main",
        env: { OPENCLAW_STATE_DIR: stateDir },
      });
      await sessionAccessor.upsertSessionEntryCore(
        { agentId: "main", storePath, sessionKey: "agent:main:delayed" },
        { sessionId: "delayed-session", updatedAt: 1 },
      );
      const replied = createDeferred();
      const release = createDeferred();
      const run = historyLane.pool.run.bind(historyLane.pool);
      const held = vi.spyOn(historyLane.pool, "run").mockImplementation(async (...args) => {
        const result = await run(...args);
        if (
          result.ok &&
          typeof result.value !== "boolean" &&
          !Array.isArray(result.value) &&
          result.value.kind === "session-store-summary"
        ) {
          expect(result.value.summary.count).toBe(1);
          replied.resolve();
          await release.promise;
        }
        return result;
      });
      const pending = summarizeStore(storePath, "main");
      try {
        await awaitGateBeforeSettlement(replied.promise, pending, "Summary bypassed its worker");
        if (change === "admission-refused") {
          recordAgentDatabaseAdmissions(
            [
              {
                agentId: "main",
                paths: [storePath],
                code: "agent-database-inspection-pending",
                reason: "fixture admission changed",
                repairHint: "finish fixture inspection",
              },
            ],
            { source: "startup" },
          );
        } else {
          closeOpenClawAgentDatabasesForTest();
        }
        release.resolve();
        if (change === "admission-refused") {
          await expect(pending).resolves.toMatchObject({ count: 0, recent: [] });
        } else {
          await expect(pending).rejects.toThrow(/revoked|no longer current/);
        }
      } finally {
        release.resolve();
        await pending.catch(() => {});
        held.mockRestore();
        recordAgentDatabaseAdmissions([], { source: "startup" });
      }
    },
  );
});
