import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import * as sqlite from "../../infra/kysely-sync.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { retainSessionListForegroundWork } from "../session-projection-work.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  listSessions,
  requestContext,
} from "./sessions-read-cache.test-support.js";

afterEach(() => vi.restoreAllMocks());

it.runIf(process.env.OPENCLAW_DB_WORKER_BENCH === "1")(
  "measures resident sessions.list for 50 viewers over 5,000 stored sessions",
  async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const rows = 5_000;
      const viewers = 50;
      const cfg = { agents: { list: [{ id: "main", default: true }] } };
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
        const clients = Array.from({ length: viewers }, (_, index) =>
          identifiedClient(`viewer-${index}`),
        );
        const request = (client: (typeof clients)[number]) =>
          listSessions({ context, client, request: { limit: 100 } });
        const golden = await request(clients[0]!);
        expect(golden.totalCount).toBe(rows);
        expect(golden.sessions).toHaveLength(100);
        const query = vi.spyOn(sqlite, "executeSqliteQuerySync");
        const first = vi.spyOn(sqlite, "executeSqliteQueryTakeFirstSync");
        try {
          const samples: { cpuMs: number; wallMs: number }[] = [];
          for (let round = 0; round < 7; round++) {
            const start = performance.now();
            const cpu = process.threadCpuUsage();
            const responses = await Promise.all(clients.map(request));
            const elapsed = process.threadCpuUsage(cpu);
            if (round >= 2) {
              samples.push({
                cpuMs: (elapsed.user + elapsed.system) / 1_000 / viewers,
                wallMs: (performance.now() - start) / viewers,
              });
            }
            for (const response of responses) {
              expect(response.sessions).toEqual(golden.sessions);
            }
          }
          const mainThreadQueries = query.mock.calls.length + first.mock.calls.length;
          console.log(
            JSON.stringify({
              method: "sessions.list",
              rows,
              viewers,
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
