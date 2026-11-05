import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import * as history from "../../config/sessions/session-transcript-worker-runtime.js";
import { serializeGatewayFrame } from "../serialized-json.js";
import * as listFilters from "../session-list-filters.js";
import { withListBenchmark } from "./sessions-list-benchmark.test-support.js";
import { initializeSessionReadContext } from "./sessions-read-cache.test-support.js";

afterEach(() => vi.restoreAllMocks());

it.runIf(process.env.OPENCLAW_DB_WORKER_BENCH === "1")(
  "measures six cold sidebar requests over a synthetic session inventory",
  () =>
    withListBenchmark("cold", async ({ rows, context, clients: makeClients, request }) => {
      const clients = makeClients();
      const readDatabases = history.withSessionHistoryWorkerDatabases;
      const reads: { count: number; ms: number }[] = [];
      vi.spyOn(history, "withSessionHistoryWorkerDatabases").mockImplementation(
        (targets, consume, lane) =>
          readDatabases(
            targets,
            (owners) =>
              consume(
                owners.map((owner) => ({
                  ...owner,
                  async readRowFacts(input) {
                    const start = performance.now();
                    const result = await owner.readRowFacts(input);
                    reads.push({ count: input.sessionKeys.length, ms: performance.now() - start });
                    return result;
                  },
                })),
              ),
            lane,
          ),
      );
      const init = performance.now();
      await initializeSessionReadContext(context);
      const initMs = performance.now() - init;
      const filter = vi.spyOn(listFilters, "filterSessionEntries");
      const measure = async (client: (typeof clients)[number]) => {
        const start = performance.now();
        const result = await request(client);
        const frame = serializeGatewayFrame({
          type: "res",
          id: client.connId,
          ok: true,
          payload: result,
        });
        expect(result.sessions).toHaveLength(200);
        expect(result.totalCount).toBe(rows);
        return {
          ms: performance.now() - start,
          bytes: typeof frame === "string" ? Buffer.byteLength(frame) : frame.byteLength,
        };
      };
      const cold = await Promise.all(clients.map(measure));
      const coldSelections = filter.mock.calls.length;
      const coldReads = reads.splice(0);
      const warm = await Promise.all(clients.map(measure));
      console.log(
        JSON.stringify({ rows, initMs, cold, coldSelections, coldReads, warm, warmReads: reads }),
      );
    }),
);
