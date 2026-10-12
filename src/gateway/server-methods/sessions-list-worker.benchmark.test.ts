import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import * as sqlite from "../../infra/kysely-sync.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { serializeGatewayFrame } from "../serialized-json.js";
import { retainSessionListForegroundWork } from "../session-projection-work.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  listSessions,
  requestContext,
} from "./sessions-read-cache.test-support.js";

afterEach(() => vi.restoreAllMocks());

it.runIf(process.env.OPENCLAW_DB_WORKER_BENCH === "1").each(["same", "distinct"] as const)(
  "measures resident sessions.list for 25 connections with %s identities over 5,000 stored sessions",
  async (identities) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const rows = 5_000;
      const viewers = 25;
      const cfg = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      runOpenClawAgentWriteTransaction(
        () => {
          for (let index = 0; index < rows; index++) {
            replaceSessionEntrySync(
              { agentId: "main", sessionKey: `agent:main:list-bench-${index}` },
              { sessionId: `list-bench-${index}`, updatedAt: index + 1, visibility: "shared" },
            );
          }
        },
        { agentId: "main" },
      );
      const release = retainSessionListForegroundWork();
      vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      const context = requestContext(cfg);
      try {
        await initializeSessionReadContext(context);
        await getSessionRowProjection(context)!.ensureMaterialized();
        const clients = Array.from({ length: viewers }, (_, index) => ({
          ...identifiedClient(`viewer-${identities === "same" ? 0 : index}`),
          connId: `list-bench-${index}`,
        }));
        const request = (client: (typeof clients)[number]) =>
          listSessions({
            context,
            client,
            acceptsSerializedJson: true,
            request: { limit: 100, rowMode: "compact" },
          });
        const golden = await request(clients[0]!);
        expect(golden.totalCount).toBe(rows);
        expect(golden.sessions).toHaveLength(100);
        const query = vi.spyOn(sqlite, "executeSqliteQuerySync");
        const first = vi.spyOn(sqlite, "executeSqliteQueryTakeFirstSync");
        try {
          let mainThreadQueries = 0;
          const samples: {
            cpuMs: number;
            wallMs: number;
            wireBytes: number;
            rowArrays: number;
            selections: number;
          }[] = [];
          for (let round = 0; round < 7; round++) {
            replaceSessionEntrySync(
              { agentId: "main", sessionKey: `agent:main:list-bench-${rows - 1}` },
              {
                sessionId: `list-bench-${rows - 1}`,
                updatedAt: rows,
                visibility: "shared",
                label: `Changed row ${round}`,
              },
            );
            // Session broadcasts await row readiness before views reload the list.
            await getSessionRowProjection(context)!.ensureMaterialized();
            query.mockClear();
            first.mockClear();
            const start = performance.now();
            const cpu = process.threadCpuUsage();
            const responses = await Promise.all(clients.map(request));
            const frames = responses.map((payload, index) =>
              serializeGatewayFrame({ type: "res", id: `request-${index}`, ok: true, payload }),
            );
            const elapsed = process.threadCpuUsage(cpu);
            mainThreadQueries += query.mock.calls.length + first.mock.calls.length;
            if (round >= 2) {
              samples.push({
                cpuMs: (elapsed.user + elapsed.system) / 1_000 / viewers,
                wallMs: (performance.now() - start) / viewers,
                wireBytes: Buffer.byteLength(frames[0]!),
                rowArrays: new Set(responses.map((response) => response.sessions)).size,
                selections: new Set(responses.map((response) => response.owners)).size,
              });
            }
            expect(responses[0]!.sessions[0]!.label).toBe(`Changed row ${round}`);
            for (const response of responses) {
              expect(response.sessions).toEqual(responses[0]!.sessions);
              expect(response.totalCount).toBe(rows);
            }
          }
          console.log(
            JSON.stringify({
              method: "sessions.list",
              rows,
              viewers,
              identities,
              samples,
              mainThreadQueries,
              medianCpuMs: samples.map((sample) => sample.cpuMs).toSorted((a, b) => a - b)[2],
              medianWallMs: samples.map((sample) => sample.wallMs).toSorted((a, b) => a - b)[2],
            }),
          );
          expect(mainThreadQueries).toBe(0);
        } finally {
          query.mockRestore();
          first.mockRestore();
        }
      } finally {
        getSessionRowProjection(context)?.dispose();
        release();
      }
    });
  },
);
