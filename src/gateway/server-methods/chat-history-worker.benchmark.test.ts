import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import {
  appendTranscriptMessages,
  replaceSessionEntrySync,
  replaceTranscriptEvents,
  waitForSessionTranscriptProjection,
} from "../../config/sessions/session-accessor.js";
import * as deltaEvents from "../../config/sessions/session-accessor.sqlite-history-events.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { identifiedClient } from "./sessions-read-cache.test-support.js";
import type { RespondFn } from "./types.js";

afterEach(() => vi.restoreAllMocks());

it.runIf(process.env.OPENCLAW_DB_WORKER_BENCH === "1")(
  "measures chat.history cursor reads for 50 viewers over 5,000 stored sessions",
  async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const rows = 5_000;
      const viewers = 50;
      const scope = { agentId: "main", sessionKey: "agent:main:bench-0", sessionId: "bench-0" };
      runOpenClawAgentWriteTransaction(
        () => {
          for (let index = 0; index < rows; index++) {
            replaceSessionEntrySync(
              { agentId: "main", sessionKey: `agent:main:bench-${index}` },
              { sessionId: `bench-${index}`, updatedAt: 1, visibility: "shared" },
            );
          }
        },
        { agentId: "main" },
      );
      await replaceTranscriptEvents(scope, [{ type: "session", version: 3, id: scope.sessionId }]);
      await waitForSessionTranscriptProjection(scope);
      const initial = deltaEvents.readTranscriptDisplayDelta(scope);
      if (initial.kind !== "page") {
        throw new Error("Expected initial history cursor");
      }
      await appendTranscriptMessages(scope, {
        messages: Array.from({ length: 100 }, (_, index) => ({
          eventId: `message-${index}`,
          now: index + 1,
          message: {
            role: "assistant",
            content: [{ type: "text", text: `Visible message ${index}` }],
          },
        })),
      });
      await waitForSessionTranscriptProjection(scope);
      vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      const context = await createHistoryReadContext();
      const clients = Array.from({ length: viewers }, (_, index) =>
        identifiedClient(`viewer-${index}`),
      );
      const request = async (client: (typeof clients)[number]) => {
        let response: Parameters<RespondFn> | undefined;
        await chatHistoryHandlers["chat.history"]!({
          params: { sessionKey: scope.sessionKey, cursor: initial.cursor },
          context,
          client,
          req: { type: "req", id: "history-bench", method: "chat.history" },
          isWebchatConnect: () => false,
          respond: (...args) => {
            response = args;
          },
        });
        expect(response?.[0]).toBe(true);
        expect(response?.[1]).toMatchObject({ kind: "delta", messages: expect.any(Array) });
        return JSON.stringify(response?.[1]);
      };
      const goldens = await Promise.all(clients.map(request));
      expect(JSON.parse(goldens[0]!).messages).toHaveLength(100);
      const readSpy = vi.spyOn(deltaEvents, "readTranscriptDisplayDelta");
      try {
        const samples: Array<{ cpuMs: number; wallMs: number }> = [];
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
          const changes = responses.flatMap((response, index) => {
            if (response === goldens[index]) {
              return [];
            }
            const actual = JSON.parse(response);
            const expected = JSON.parse(goldens[index]!);
            return [
              {
                viewer: index,
                fields: Object.keys(actual).filter(
                  (key) => JSON.stringify(actual[key]) !== JSON.stringify(expected[key]),
                ),
              },
            ];
          });
          expect(changes).toEqual([]);
        }
        console.log(
          JSON.stringify({
            method: "chat.history",
            mode: "delta",
            rows,
            viewers,
            messages: 100,
            samples,
            mainThreadDeltaReads: readSpy.mock.calls.length,
            medianCpuMs: samples.map((sample) => sample.cpuMs).toSorted((a, b) => a - b)[2],
            medianWallMs: samples.map((sample) => sample.wallMs).toSorted((a, b) => a - b)[2],
          }),
        );
      } finally {
        readSpy.mockRestore();
      }
    });
  },
);
