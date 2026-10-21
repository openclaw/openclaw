import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import * as sqlite from "../../infra/kysely-sync.js";
import { serializeGatewayFrame } from "../serialized-json.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { withListBenchmark } from "./sessions-list-benchmark.test-support.js";
import { initializeSessionReadContext } from "./sessions-read-cache.test-support.js";

afterEach(() => vi.restoreAllMocks());

it.runIf(process.env.OPENCLAW_DB_WORKER_BENCH === "1").each(["same", "distinct"] as const)(
  "measures resident sessions.list for 25 connections with %s identities over 5,000 stored sessions",
  (identities) =>
    withListBenchmark(
      identities,
      async ({ rows, viewers, context, clients: makeClients, request, replaceLast }) => {
        vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
        await initializeSessionReadContext(context);
        const projection = getSessionRowProjection(context)!;
        await projection.ensureMaterialized();
        const clients = makeClients();
        const golden = await request(clients[0]!);
        expect(golden.totalCount).toBe(rows);
        expect(golden.sessions).toHaveLength(100);
        const query = vi.spyOn(sqlite, "executeSqliteQuerySync");
        const first = vi.spyOn(sqlite, "executeSqliteQueryTakeFirstSync");
        try {
          let mainThreadQueries = 0;
          const samples: Record<
            "cpuMs" | "wallMs" | "wireBytes" | "rowArrays" | "selections",
            number
          >[] = [];
          for (let round = 0; round < 7; round++) {
            replaceLast(`Changed row ${round}`);
            // Session broadcasts await row readiness before views reload the list.
            await projection.ensureMaterialized();
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
      },
    ),
);
