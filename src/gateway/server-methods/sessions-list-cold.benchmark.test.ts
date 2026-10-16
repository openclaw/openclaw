import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import * as history from "../../config/sessions/session-transcript-worker-runtime.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { serializeGatewayFrame } from "../serialized-json.js";
import * as listFilters from "../session-list-filters.js";
import { retainSessionListForegroundWork } from "../session-projection-work.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  listSessions,
  requestContext,
} from "./sessions-read-cache.test-support.js";

it.runIf(process.env.OPENCLAW_DB_WORKER_BENCH === "1")(
  "measures six cold sidebar requests over a synthetic session inventory",
  async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const rows = 5_000;
      const cfg = { agents: { entries: { main: {} } }, plugins: { enabled: false } };
      setRuntimeConfigSnapshot(cfg);
      runOpenClawAgentWriteTransaction(
        () => {
          for (let index = 0; index < rows; index++) {
            replaceSessionEntrySync(
              { agentId: "main", sessionKey: `agent:main:dashboard:cold-${index}` },
              {
                sessionId: `cold-${index}`,
                updatedAt: index + 1,
                visibility: "shared",
                label: `Synthetic conversation ${index} ${"context ".repeat(190)}`,
              },
            );
          }
        },
        { agentId: "main" },
      );
      const release = retainSessionListForegroundWork();
      const context = requestContext(cfg);
      const clients = Array.from({ length: 6 }, (_, index) => ({
        ...identifiedClient("cold-viewer"),
        connId: `cold-${index}`,
      }));
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
      try {
        const init = performance.now();
        await initializeSessionReadContext(context);
        const initMs = performance.now() - init;
        const filter = vi.spyOn(listFilters, "filterSessionEntries");
        const request = async (client: (typeof clients)[number]) => {
          const start = performance.now();
          const result = await listSessions({
            context,
            client,
            acceptsSerializedJson: true,
            request: {
              limit: 200,
              rowMode: "compact",
              source: "sidebar",
              agentId: "main",
              includeGlobal: true,
              includeUnknown: true,
              configuredAgentsOnly: true,
            },
          });
          const frame = serializeGatewayFrame({
            type: "res",
            id: client.connId,
            ok: true,
            payload: result,
          });
          expect(result.sessions).toHaveLength(200);
          expect(result.totalCount).toBe(rows);
          return { ms: performance.now() - start, bytes: Buffer.byteLength(frame) };
        };
        const cold = await Promise.all(clients.map(request));
        const coldSelections = filter.mock.calls.length;
        const coldReads = reads.splice(0);
        const warm = await Promise.all(clients.map(request));
        console.log(
          JSON.stringify({ rows, initMs, cold, coldSelections, coldReads, warm, warmReads: reads }),
        );
      } finally {
        getSessionRowProjection(context)?.dispose();
        release();
        vi.restoreAllMocks();
      }
    });
  },
);
