import http from "node:http";
import path from "node:path";
import { setImmediate as flushImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, test, vi } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { recordAgentDatabaseAdmissions } from "../state/agent-database-admission.js";
import { getOpenClawAgentDatabaseIfOpen } from "../state/openclaw-agent-db.js";
import type { StatusSummary } from "../status/summary.js";
import type { HealthSummary } from "./health/types.js";
import { startGatewayServerHarness } from "./server.e2e-ws-harness.js";
import { installGatewayTestHooks, rpcReq, testState } from "./test-helpers.js";

installGatewayTestHooks();

test.each(["separate", "shared", "single", "empty"] as const)(
  "registered Gateway health/status preserve %s SQLite snapshots while serving HTTP",
  async (layout) => {
    const collector = await import("./health/collector.js");
    const actualCollector = await vi.importActual<typeof collector>("./health/collector.js");
    vi.mocked(collector.collectGatewayHealthSnapshot).mockImplementation(
      actualCollector.collectGatewayHealthSnapshot,
    );
    const status = await import("../status/summary.js");
    const actualStatus = await vi.importActual<typeof status>("../status/summary.js");
    vi.mocked(status.getStatusSummary).mockImplementation(actualStatus.getStatusSummary);
    const root = expectDefined(process.env.OPENCLAW_STATE_DIR, "isolated state");
    const agentCount = layout === "empty" ? 0 : layout === "single" ? 1 : 12;
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
    if (layout === "empty") {
      await expect(startGatewayServerHarness()).rejects.toThrow(
        "agents.entries must contain at least one configured agent",
      );
      return;
    }
    const harness = await startGatewayServerHarness();
    let closing: Promise<void> | undefined;
    const httpAgent = new http.Agent({ keepAlive: true });
    const requestHealth = () =>
      new Promise<void>((resolve, reject) => {
        const request = http.get(
          `http://127.0.0.1:${harness.port}/healthz`,
          { agent: httpAgent },
          (response) => {
            response.resume();
            response.once("end", () => {
              if (response.statusCode !== 200) {
                reject(new Error(`healthz returned ${response.statusCode}`));
              } else {
                resolve();
              }
            });
          },
        );
        request.once("error", reject);
      });
    try {
      const { ws } = await harness.openClient();
      await rpcReq(ws, "health", { probe: true });
      await requestHealth();
      const originalRead = sessionAccessor.readSessionStoreSummaryReadOnly;
      let inserted = false;
      for (const method of ["health", "status"] as const) {
        let reads = 0;
        let httpAtRead: number | undefined;
        let traffic: Promise<void> | undefined;
        let write: Promise<void> | undefined;
        const completedReads: number[] = [];
        const read = vi
          .spyOn(sessionAccessor, "readSessionStoreSummaryReadOnly")
          .mockImplementation((...args) => {
            const result = originalRead(...args);
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
            const response = await rpcReq<HealthSummary>(ws, "health", { probe: true });
            expect(response.ok).toBe(true);
            expect(
              response.payload?.agents.map((agent) => [agent.agentId, agent.sessions.count]),
            ).toEqual(agentIds.map((agentId) => [agentId, 12]));
            expect(
              response.payload?.agents.map((agent) => agent.sessions.recent.map(({ key }) => key)),
            ).toEqual(
              agentIds.map((agentId) =>
                Array.from({ length: 5 }, (_, index) => `agent:${agentId}:session${11 - index}`),
              ),
            );
          } else {
            const response = await rpcReq<StatusSummary>(ws, "status", {
              includeChannelSummary: false,
            });
            expect(response.ok).toBe(true);
            const sessions = expectDefined(response.payload?.sessions, "status sessions");
            expect(sessions.count).toBe(agentCount * 12 + (layout === "shared" ? 2 : 0));
            expect(sessions.recent).toHaveLength(agentCount === 0 ? 0 : 10);
            expect(
              sessions.byAgent.map((agent) => [agent.agentId, agent.count, agent.recent.length]),
            ).toEqual(
              agentIds
                .toSorted()
                .map((agentId) => [agentId, agentId === "fleet11" && inserted ? 13 : 12, 10]),
            );
            for (const agent of sessions.byAgent) {
              const keys = Array.from(
                { length: 10 },
                (_, index) => `agent:${agent.agentId}:session${11 - index}`,
              );
              expect(agent.recent.map(({ key }) => key)).toEqual(
                agent.agentId === "fleet11" && inserted
                  ? ["agent:fleet11:new", ...keys.slice(0, 9)]
                  : keys,
              );
            }
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
        const read = vi.spyOn(sessionAccessor, "readSessionStoreSummaryReadOnly");
        try {
          read.mockImplementationOnce(() => {
            throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
          });
          const failedRead = await rpcReq<HealthSummary>(ws, "health", { probe: true });
          expect(failedRead.ok).toBe(true);
          expect(failedRead.payload?.agents.map((agent) => agent.sessions.count)).toEqual(
            agentIds.map(() => 0),
          );
          expect(read).toHaveBeenCalledOnce();
          const recovered = await rpcReq<HealthSummary>(ws, "health", { probe: true });
          expect(recovered.payload?.agents.at(-1)?.sessions.count).toBe(13);
          read.mockClear().mockImplementationOnce(() => {
            throw new Error("invalid session state");
          });
          const fatal = await rpcReq(ws, "health", { probe: true });
          expect(fatal.ok).toBe(false);
          expect(read).toHaveBeenCalledOnce();
          read.mockClear().mockImplementationOnce(() => {
            throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
          });
          const failedStatus = await rpcReq(ws, "status", { includeChannelSummary: false });
          expect(failedStatus.ok).toBe(false);
          expect(read).toHaveBeenCalledOnce();
          const recoveredStatus = await rpcReq<StatusSummary>(ws, "status", {
            includeChannelSummary: false,
          });
          expect(recoveredStatus.payload?.sessions.count).toBe(146);
        } finally {
          read.mockRestore();
        }
      }
      if (layout === "separate") {
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
        );
        const read = vi.spyOn(sessionAccessor, "readSessionStoreSummaryReadOnly");
        try {
          const response = await rpcReq<HealthSummary>(ws, "health", { probe: true });
          expect(response.payload?.agents.at(-1)?.sessions.count).toBe(0);
          expect(read).toHaveBeenCalledTimes(11);
          read.mockClear();
          const statusResponse = await rpcReq<StatusSummary>(ws, "status", {
            includeChannelSummary: false,
          });
          expect(statusResponse.payload?.sessions.count).toBe(132);
          expect(
            statusResponse.payload?.sessions.byAgent.find((agent) => agent.agentId === "fleet11"),
          ).toMatchObject({ count: 0, status: "degraded" });
          expect(read).toHaveBeenCalledTimes(11);
        } finally {
          read.mockRestore();
          recordAgentDatabaseAdmissions([], { source: "startup" });
        }
        const lifecycle: string[] = [];
        vi.mocked(collector.collectGatewayHealthSnapshot).mockImplementation(async (params) => {
          try {
            return await actualCollector.collectGatewayHealthSnapshot(params);
          } finally {
            lifecycle.push("settled");
          }
        });
        const closingRead = vi
          .spyOn(sessionAccessor, "readSessionStoreSummaryReadOnly")
          .mockImplementationOnce((...args) => {
            const result = originalRead(...args);
            setImmediate(() => {
              lifecycle.push("closing");
              closing = harness.close().then(() => {
                lifecycle.push("closed");
              });
            });
            return result;
          });
        try {
          await Promise.allSettled([rpcReq(ws, "health", { probe: true })]);
          await closing;
          expect(lifecycle).toEqual(["closing", "settled", "closed"]);
          const completedReads = closingRead.mock.calls.length;
          await flushImmediate();
          expect(closingRead).toHaveBeenCalledTimes(completedReads);
        } finally {
          closingRead.mockRestore();
        }
      }
    } finally {
      httpAgent.destroy();
      await (closing ?? harness.close());
    }
  },
);
