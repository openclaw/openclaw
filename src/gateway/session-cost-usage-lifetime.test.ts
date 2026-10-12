import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.transcript-turn.js";
import * as aggregation from "../infra/session-cost-usage-aggregation.js";
import * as cacheRuntime from "../infra/session-cost-usage-cache-runtime.js";
import { onSessionCostUsageUpdated } from "../infra/session-cost-usage-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import type { SessionCostUsagePublication } from "../shared/usage-types.js";
import {
  createAgentDatabaseInspectionRefusal,
  preparePendingAgentDatabase,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as agentList from "./agent-list.js";
import { startSessionCostUsageProjectionLifetime } from "./session-cost-usage-lifetime.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it("projects committed usage after startup preparation without borrowing its expired context", ({
  signal,
  onTestFinished,
}) => {
  const run = withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config = { agents: { entries: { main: {} } } };
    const target = {
      agentId: "main",
      sessionKey: "agent:main:usage-admission",
      sessionId: "usage-admission",
    };
    const timestamp = Date.parse("2026-09-18T12:00:00Z");
    replaceSessionEntrySync(target, { sessionId: target.sessionId, updatedAt: timestamp });
    const append = (tokens: number) =>
      persistSessionTranscriptTurn(target, {
        messages: [
          {
            message: {
              role: "assistant",
              content: "Synthetic usage",
              timestamp,
              usage: {
                input: tokens,
                output: 0,
                totalTokens: tokens,
                cost: { total: tokens / 100 },
              },
            },
          },
        ],
        touchSessionEntry: false,
      });
    await append(10);
    const publisher = new AsyncLocalStorage<"owner" | "preparation">();
    const firstStarted = createDeferred();
    const nextStarted = createDeferred();
    const releaseRefresh = createDeferred();
    let holdRefresh = false;
    const outcomes: Array<
      Promise<
        | { ok: true; context: string | undefined }
        | { ok: false; context: string | undefined; error: unknown }
      >
    > = [];
    const actualRefresh = aggregation.refreshCostUsageCacheForAgent;
    vi.spyOn(aggregation, "refreshCostUsageCacheForAgent").mockImplementation((params) => {
      const context = publisher.getStore();
      const operation = (async () => {
        if (holdRefresh) {
          await releaseRefresh.promise;
        }
        return actualRefresh(params);
      })();
      outcomes.push(
        operation.then(
          () => ({ ok: true as const, context }),
          (error: unknown) => ({ ok: false as const, context, error }),
        ),
      );
      firstStarted.resolve();
      if (outcomes.length > 1) {
        nextStarted.resolve();
      }
      return operation;
    });
    const requested = vi.spyOn(cacheRuntime, "requestCostUsageCacheRefresh");
    const roster = vi.spyOn(agentList, "listGatewayAgentsBasic");
    const publications: SessionCostUsagePublication[] = [];
    const offUsage = onSessionCostUsageUpdated((event) => publications.push(event));
    const warn = vi.fn();
    const lifetime = publisher.run("owner", () =>
      startSessionCostUsageProjectionLifetime({ getConfig: () => config, warn }),
    );
    let pendingRefreshes = -1;
    try {
      await withinTest(firstStarted.promise, signal);
      expect(await withinTest(outcomes[0]!, signal)).toEqual({ ok: true, context: "owner" });
      const initialRequests = requested.mock.calls.length;
      const refusal = createAgentDatabaseInspectionRefusal({
        agentId: target.agentId,
        paths: [resolveOpenClawAgentSqlitePath({ agentId: target.agentId })],
        pending: true,
        reason: "Startup preparation is pending",
      });
      recordAgentDatabaseAdmissions([refusal], { source: "startup" });
      holdRefresh = true;
      await preparePendingAgentDatabase(refusal, { assertCurrent() {} }, () =>
        publisher.run("preparation", async () => {
          await append(20);
          sessionChanges.emit({ all: true, scope: { agentId: target.agentId, topology: true } });
          await roster.mock.results.at(-1)?.value;
          // Let any incorrectly accepted queue enter aggregation before expiring its borrow.
          if (requested.mock.calls.length > initialRequests) {
            await withinTest(nextStarted.promise, signal);
          }
          pendingRefreshes = outcomes.length - 1;
        }),
      );
      // The admission owner's completion publication is the only recovery trigger.
      await roster.mock.results.at(-1)?.value;
      await withinTest(nextStarted.promise, signal);
      releaseRefresh.resolve();
      const settled = await withinTest(Promise.all(outcomes), signal);
      await lifetime.stop();
      const summary = await cacheRuntime.loadCostUsageSummaryFromCache({
        config,
        agentId: target.agentId,
        startMs: timestamp - 1,
        endMs: timestamp + 1,
        requestRefresh: false,
      });
      expect.soft(summary).toMatchObject({
        totals: { totalTokens: 30 },
        cacheStatus: { status: "fresh" },
      });
      expect.soft(pendingRefreshes).toBe(0);
      expect(settled).toEqual([
        { ok: true, context: "owner" },
        { ok: true, context: "owner" },
      ]);
      expect(publications.filter((event) => event.usageRefreshFailed)).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      releaseRefresh.resolve();
      await Promise.all(outcomes);
      await lifetime.stop();
      offUsage();
    }
  });
  onTestFinished(() => run);
  return run;
});
