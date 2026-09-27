import { performance } from "node:perf_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
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
import { registerChatAbortController } from "../chat-abort.js";
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

it.runIf(process.env.OPENCLAW_DB_WORKER_BENCH === "1")(
  "measures active and inactive chat.history delta serialization",
  async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const now = 1_800_000_000_000;
      const requestsPerSample = 5;
      const targets = [8 * 1024, 128 * 1024, 900 * 1024];
      const scopes = targets.map((targetBytes) => ({
        agentId: "main",
        sessionKey: `agent:main:delta-bytes-${targetBytes}`,
        sessionId: `delta-bytes-${targetBytes}`,
      }));
      for (const scope of scopes) {
        replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      }
      vi.spyOn(Date, "now").mockReturnValue(now);
      const context = await createHistoryReadContext();
      const handler = expectDefined(chatHistoryHandlers["chat.history"], "history handler");
      const marker = 'delta-byte-benchmark: 漢字🤖\n"\\';
      for (const [index, scope] of scopes.entries()) {
        const targetBytes = targets[index]!;
        let cursor = "";
        let content: Array<{ type: string; text: string }> = [];
        const request = async () => {
          let encoded: string | undefined;
          let responses = 0;
          await handler({
            params: { sessionKey: scope.sessionKey, cursor, maxBytes: 1_000_000 },
            context,
            client: null,
            req: { type: "req", id: "delta-byte-bench", method: "chat.history" },
            isWebchatConnect: () => false,
            respond: (ok, payload, error) => {
              responses++;
              encoded = JSON.stringify({ type: "res", id: "delta-byte-bench", ok, payload, error });
            },
          });
          return { encoded, responses };
        };
        const inspect = (response: Awaited<ReturnType<typeof request>>) => {
          expect(response.responses).toBe(1);
          const encoded = expectDefined(response.encoded, "encoded history response");
          const frame = expectDefined(asOptionalRecord(JSON.parse(encoded)), "history frame");
          expect(frame.ok).toBe(true);
          expect(frame.error).toBeUndefined();
          const payload = expectDefined(asOptionalRecord(frame.payload), "history payload");
          expect(payload).toMatchObject({
            kind: "delta",
            messages: [{ messageId: "result", message: { role: "toolResult", content } }],
          });
          expect(payload).not.toHaveProperty("messagesBytes");
          expect(payload).not.toHaveProperty("activityBytes");
          const messagesBytes = Buffer.byteLength(JSON.stringify(payload.messages), "utf8");
          const activityBytes =
            Array.isArray(payload.activity) && payload.activity.length > 0
              ? Buffer.byteLength(JSON.stringify({ activity: payload.activity }), "utf8") - 1
              : 0;
          return { payload, encoded, messagesBytes, activityBytes };
        };
        // Leave room for session metadata and report the actual projected sizes below.
        const text = marker + "x".repeat(targetBytes - 4 * 1024);
        content = Array.from({ length: Math.ceil(text.length / 7_000) }, (_, block) => ({
          type: "text",
          text: text.slice(block * 7_000, (block + 1) * 7_000),
        }));
        await replaceTranscriptEvents(scope, [
          { type: "session", version: 3, id: scope.sessionId },
        ]);
        await waitForSessionTranscriptProjection(scope);
        const head = deltaEvents.readTranscriptDisplayDelta(scope);
        if (head.kind !== "page") {
          throw new Error("Expected initial delta benchmark cursor");
        }
        cursor = head.cursor;
        await appendTranscriptMessages(scope, {
          messages: [
            {
              eventId: "result",
              now: 42,
              message: {
                role: "toolResult",
                toolName: "read",
                toolCallId: "read-result",
                content,
              },
            },
          ],
        });
        await waitForSessionTranscriptProjection(scope);
        const readSpy = vi.spyOn(deltaEvents, "readTranscriptDisplayDelta");
        try {
          for (const active of [false, true]) {
            const runId = `run-${scope.sessionId}`;
            const registration = active
              ? registerChatAbortController({
                  chatAbortControllers: context.chatAbortControllers,
                  ...scope,
                  runId,
                  now,
                  timeoutMs: 60_000,
                })
              : undefined;
            if (active) {
              const run = context.chatRunState.getOrCreate(runId);
              run.buffer = "Partial synthetic reply. ".repeat(100);
              run.planSnapshot = {
                steps: [{ step: "Read synthetic history", status: "in_progress" }],
              };
            }
            try {
              const golden = inspect(await request());
              expect(golden.payload.inFlightRun === undefined).toBe(!active);
              const projectedBytes = golden.messagesBytes + golden.activityBytes;
              const samples: Array<{
                mainThreadCpuMs: number;
                processCpuMs: number;
                wallMs: number;
              }> = [];
              for (let round = 0; round < 7; round++) {
                const responses: Array<Awaited<ReturnType<typeof request>>> = [];
                const cpu = process.cpuUsage();
                const threadCpu = process.threadCpuUsage();
                const start = performance.now();
                for (let repeat = 0; repeat < requestsPerSample; repeat++) {
                  responses.push(await request());
                }
                const wallMs = (performance.now() - start) / requestsPerSample;
                const threadElapsed = process.threadCpuUsage(threadCpu);
                const elapsed = process.cpuUsage(cpu);
                if (round >= 2) {
                  samples.push({
                    mainThreadCpuMs:
                      (threadElapsed.user + threadElapsed.system) / 1_000 / requestsPerSample,
                    processCpuMs: (elapsed.user + elapsed.system) / 1_000 / requestsPerSample,
                    wallMs,
                  });
                }
                for (const response of responses) {
                  expect(response.responses).toBe(1);
                  expect(response.encoded).toBe(golden.encoded);
                }
              }
              expect(readSpy).not.toHaveBeenCalled();
              console.log(
                JSON.stringify({
                  method: "chat.history",
                  mode: "delta-serialization",
                  active,
                  targetBytes,
                  projectedBytes,
                  responseBytes: Buffer.byteLength(golden.encoded, "utf8"),
                  messagesBytes: golden.messagesBytes,
                  activityBytes: golden.activityBytes,
                  requestsPerSample,
                  samples,
                  mainThreadDeltaReads: readSpy.mock.calls.length,
                  medianMainThreadCpuMs: samples
                    .map((sample) => sample.mainThreadCpuMs)
                    .toSorted((a, b) => a - b)[2],
                  medianProcessCpuMs: samples
                    .map((sample) => sample.processCpuMs)
                    .toSorted((a, b) => a - b)[2],
                  medianWallMs: samples.map((sample) => sample.wallMs).toSorted((a, b) => a - b)[2],
                }),
              );
            } finally {
              registration?.cleanup();
              context.chatRunState.clearRun(runId);
            }
          }
        } finally {
          readSpy.mockRestore();
        }
      }
    });
  },
);
