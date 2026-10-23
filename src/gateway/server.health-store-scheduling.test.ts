import { once } from "node:events";
import http from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as flushImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, test, vi } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { spyOnSessionStoreSummaries } from "../config/sessions/session-store-summary.test-support.js";
import { recordAgentDatabaseAdmissions } from "../state/agent-database-admission.js";
import { getOpenClawAgentDatabaseIfOpen } from "../state/openclaw-agent-db.js";
import type { StatusSummary } from "../status/summary.js";
import type { HealthSummary } from "./health/types.js";
import { startGatewayServerHarness } from "./server.e2e-ws-harness.js";
import { installGatewayTestHooks, rpcReq, testState } from "./test-helpers.js";

installGatewayTestHooks();

test.each(["separate", "shared"] as const)(
  "registered Gateway health/status preserve %s resident snapshots while serving HTTP",
  async (layout) => {
    const collector = await import("./health/collector.js");
    const actualCollector = await vi.importActual<typeof collector>("./health/collector.js");
    vi.mocked(collector.collectGatewayHealthSnapshot).mockImplementation(
      actualCollector.collectGatewayHealthSnapshot,
    );
    const status = await import("../status/summary.js");
    const actualStatus = await vi.importActual<typeof status>("../status/summary.js");
    vi.mocked(status.prepareStatusSummary).mockImplementation(actualStatus.prepareStatusSummary);
    const root = expectDefined(process.env.OPENCLAW_STATE_DIR, "isolated state");
    const agentCount = 12;
    const agentIds = Array.from({ length: agentCount }, (_, index) => `fleet${index}`);
    const storeTemplate = path.join(
      root,
      "fleet",
      layout === "shared" ? "shared.sqlite" : "{agentId}/sessions.json",
    );
    testState.agentsConfig = {
      ownership: "explicit",
      entries: Object.fromEntries(agentIds.map((agentId) => [agentId, {}])),
    };
    testState.sessionStorePath = storeTemplate;
    const storeFor = (agentId: string) => resolveSessionStorePathCore(storeTemplate, { agentId });
    const writeSession = (agentId: string, suffix: string, updatedAt: number) => {
      sessionAccessor.replaceSessionEntrySync(
        { agentId, storePath: storeFor(agentId), sessionKey: `agent:${agentId}:${suffix}` },
        { sessionId: `${agentId}-${suffix}`, updatedAt },
      );
    };
    for (const agentId of agentIds) {
      for (let sessionIndex = 0; sessionIndex < 12; sessionIndex += 1) {
        writeSession(agentId, `session${sessionIndex}`, 100 + sessionIndex);
      }
    }
    if (layout === "shared") {
      writeSession("retired", "main", 50);
    }
    const harness = await startGatewayServerHarness();
    let readWorkMs = performance.now();
    const workClock = vi.spyOn(performance, "now").mockImplementation(() => readWorkMs);
    let closing: Promise<void> | undefined;
    const httpAgent = new http.Agent({ keepAlive: true });
    const requestHealth = async () => {
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${harness.port}/healthz`, { agent: httpAgent }, resolve)
          .once("error", reject);
      });
      response.resume();
      await once(response, "end");
      expect(response.statusCode).toBe(200);
    };
    const { calls: sqliteSummaries, restore: restoreSummaries } = spyOnSessionStoreSummaries();
    try {
      const { ws } = await harness.openClient();
      const health = () => rpcReq<HealthSummary>(ws, "health", { probe: true });
      const statusSummary = () =>
        rpcReq<StatusSummary>(ws, "status", { includeChannelSummary: false });
      await health();
      await requestHealth();
      sqliteSummaries.mockClear();
      const projection = expectDefined(
        vi.mocked(collector.collectGatewayHealthSnapshot).mock.calls.at(-1)?.[0]
          ?.sessionRowProjection,
        "registered Gateway resident session projection",
      );
      const originalRead = projection.selectEntries;
      let updatedAt = 300;
      const changeResidentSession = async () => {
        // These scenarios exercise fresh selection; unchanged health reads reuse preparation.
        writeSession("fleet0", "session0", updatedAt++);
        await projection.prepareSelection();
      };
      let inserted = false;
      for (const method of ["health", "status"] as const) {
        await changeResidentSession();
        let reads = 0;
        let httpAtRead: number | undefined;
        let traffic: Promise<void> | undefined;
        let write: Promise<void> | undefined;
        const completedReads: number[] = [];
        const read = vi.spyOn(projection, "selectEntries").mockImplementation((...args) => {
          const result = originalRead(...args);
          // Exercise costly resident selection independently of fixture size.
          readWorkMs += 20;
          reads += 1;
          setImmediate(() => completedReads.push(reads));
          if (reads === 1) {
            traffic = requestHealth().then(() => {
              httpAtRead = reads;
            });
            if (layout === "shared" && !inserted) {
              write = flushImmediate().then(() => {
                const database = expectDefined(
                  getOpenClawAgentDatabaseIfOpen({ agentId: "main", path: storeFor("fleet0") }),
                  "shared database",
                );
                expect(database.db.isTransaction).toBe(false);
                writeSession("fleet11", "new", 200);
                inserted = true;
              });
            }
          }
          return result;
        });
        try {
          if (method === "health") {
            const response = await health();
            expect(response.ok).toBe(true);
            expect(response.payload?.agents.map((agent) => agent.sessions.count)).toEqual(
              agentIds.map(() => 12),
            );
          } else {
            const response = await statusSummary();
            expect(response).toMatchObject({ ok: true });
            const sessions = expectDefined(response.payload?.sessions, "status sessions");
            expect(sessions.count).toBe(agentCount * 12 + (layout === "shared" ? 2 : 0));
          }
          await Promise.all([traffic, write, flushImmediate()]);
          const physicalStores = layout === "shared" ? 1 : agentCount;
          expect(reads).toBe(physicalStores);
          expect(completedReads).toEqual(Array.from({ length: reads }, (_, index) => index + 1));
          if (layout === "separate") {
            expect(httpAtRead).toBeLessThan(physicalStores);
          }
        } finally {
          read.mockRestore();
          await Promise.all([traffic, write]);
        }
      }
      if (layout === "shared") {
        using read = vi.spyOn(projection, "selectEntries");
        const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        const failRead = async <T>(request: () => Promise<T>, error: Error) => {
          await changeResidentSession();
          read.mockClear().mockImplementationOnce(() => {
            throw error;
          });
          const response = await request();
          expect(read).toHaveBeenCalledOnce();
          return response;
        };
        const failedRead = await failRead(health, busy);
        expect(failedRead.ok).toBe(true);
        expect(failedRead.payload?.agents.map((agent) => agent.sessions.count)).toEqual(
          agentIds.map(() => 0),
        );
        expect((await health()).payload?.agents.at(-1)?.sessions.count).toBe(13);
        expect((await failRead(health, new Error("invalid session state"))).ok).toBe(false);
        expect((await failRead(statusSummary, busy)).ok).toBe(false);
        expect((await statusSummary()).payload?.sessions.count).toBe(146);
      }
      if (layout === "separate") {
        await changeResidentSession();
        const read = vi.spyOn(projection, "selectEntries").mockImplementation((...args) => {
          const rows = originalRead(...args);
          readWorkMs += 20;
          if (rows.some((row) => row.agentId === "fleet11")) {
            setImmediate(() =>
              recordAgentDatabaseAdmissions(
                [
                  {
                    agentId: "fleet11",
                    paths: [storeFor("fleet11")],
                    embeddedOwnerId: "other",
                    code: "agent-database-ownership-mismatch",
                    reason: "fixture ownership mismatch",
                    repairHint: "repair fixture ownership",
                  },
                ],
                { source: "startup" },
              ),
            );
          }
          return rows;
        });
        try {
          expect((await health()).payload?.agents.at(-1)?.sessions.count).toBe(0);
          expect(read).toHaveBeenCalledTimes(12);
          read.mockClear();
          const statusResponse = await statusSummary();
          expect(statusResponse.payload?.sessions.count).toBe(132);
          expect(
            statusResponse.payload?.sessions.byAgent.find((agent) => agent.agentId === "fleet11"),
          ).toMatchObject({ count: 0, status: "degraded" });
          expect(read).toHaveBeenCalledTimes(11);
        } finally {
          read.mockRestore();
          recordAgentDatabaseAdmissions([], { source: "startup" });
        }
        await changeResidentSession();
        const lifecycle: string[] = [];
        vi.mocked(collector.collectGatewayHealthSnapshot).mockImplementation(async (params) => {
          try {
            return await actualCollector.collectGatewayHealthSnapshot(params);
          } finally {
            lifecycle.push("settled");
          }
        });
        using closingRead = vi
          .spyOn(projection, "selectEntries")
          .mockImplementationOnce((...args) => {
            const result = originalRead(...args);
            readWorkMs += 20;
            setImmediate(() => {
              lifecycle.push("closing");
              closing = harness.close().then(() => {
                lifecycle.push("closed");
              });
            });
            return result;
          });
        await Promise.allSettled([health()]);
        await closing;
        expect(lifecycle).toEqual(["closing", "settled", "closed"]);
        const completedReads = closingRead.mock.calls.length;
        await flushImmediate();
        expect(closingRead).toHaveBeenCalledTimes(completedReads);
      }
      expect(sqliteSummaries).not.toHaveBeenCalled();
    } finally {
      restoreSummaries();
      workClock.mockRestore();
      httpAgent.destroy();
      await (closing ?? harness.close());
    }
  },
);
