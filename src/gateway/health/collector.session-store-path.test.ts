import fs from "node:fs";
import path from "node:path";
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

  it("scopes template stores and recovers from transient reads", async () => {
    const stateDir = tempDirs.make();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const storeTemplate = path.join(stateDir, "stores", "{agentId}/sessions.json");
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
      path.join(stateDir, "stores", populatedAgentId, "sessions.json"),
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
    expect(reads).toHaveBeenCalledTimes(2);

    reads
      .mockClear()
      .mockRejectedValueOnce(
        Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
      );
    expect((await collect()).agents.map((agent) => agent.sessions.count)).toEqual([0, 0]);
    expect(reads).toHaveBeenCalledTimes(2);
    expect((await collect()).agents.map((agent) => agent.sessions.count)).toEqual([1, 0]);

    const fatal = new Error("invalid session state");
    reads.mockRejectedValueOnce(fatal);
    await expect(collect()).rejects.toBe(fatal);
  });

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
