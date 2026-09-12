import { createServer } from "node:http";
import { expect, it } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  applyGatewayLaneConcurrency,
  resolveGatewayLaneConcurrency,
} from "../gateway/server-lanes.js";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
} from "../infra/outbound/deliver-types.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { dispatchInboundMessageWithBufferedDispatcher } from "./dispatch.js";

const finalText = "```ts\n" + "const answer = 42;\n".repeat(20) + "```";
const finalMediaUrl = "https://example.test/final.png";

it.each([
  "rejected",
  "confirmed",
  "ambiguous",
  "recovery-owned",
  "deferred-rejection",
  "mixed",
  "concurrent",
  "timeout",
  "all-ambiguous",
  "timeout-media",
] as const)(
  "dispatchInboundMessageWithBufferedDispatcher settles %s streamed blocks before final suppression",
  async (scenario) => {
    const timesOut = scenario === "timeout" || scenario === "timeout-media";
    const responseText =
      scenario === "timeout-media" ? `${finalText}\nMEDIA:${finalMediaUrl}` : finalText;
    const state = await createOpenClawTestState({
      label: "block-streaming-recovery",
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    });
    const requests: string[] = [];
    const attempted: Array<{ kind: string; text: string | undefined; mediaUrls?: string[] }> = [];
    const delivered: Array<{ kind: string; text: string | undefined; mediaUrls?: string[] }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      requests.push(Buffer.concat(chunks).toString());
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const text of [responseText.slice(0, 180), responseText.slice(180)]) {
        response.write(
          `data: ${JSON.stringify({
            id: "completion-fixture",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { role: "assistant", content: text } }],
          })}\n\n`,
        );
      }
      response.end(
        `data: ${JSON.stringify({
          id: "completion-fixture",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`,
      );
    });
    try {
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("fixture server did not bind");
      }
      const cfg = {
        agents: {
          ownership: "explicit",
          entries: { main: {} },
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            heartbeat: { every: "0m" },
            model: { primary: "fixture/answer" },
            models: { "fixture/answer": { agentRuntime: { id: "openclaw" } } },
            blockStreamingDefault: "on",
            blockStreamingChunk: { minChars: 80, maxChars: 160 },
            blockStreamingCoalesce: { minChars: 1, maxChars: 160, idleMs: 0 },
          },
        },
        models: {
          mode: "replace",
          providers: {
            fixture: {
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              apiKey: "synthetic-test-key",
              api: "openai-completions",
              request: { allowPrivateNetwork: true },
              models: [
                {
                  id: "answer",
                  name: "Answer",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128000,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
        channels: { discord: { streaming: { mode: "off", block: { enabled: true } } } },
        messages: { visibleReplies: "automatic" },
        plugins: { slots: { memory: "none" } },
        tools: { profile: "minimal" },
      } satisfies OpenClawConfig;
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      applyGatewayLaneConcurrency(resolveGatewayLaneConcurrency(cfg));
      let blocks = 0;
      const blockStarted = createDeferred();
      const releaseBlock = createDeferred();
      let concurrentElapsedMs: number | undefined;
      const noSend = new PlatformMessageNotDispatchedError("channel rejected the continuation", {
        cause: new Error("transport unavailable before send"),
      });
      const dispatchParams = {
        ctx: {
          Body: "Show the complete example.",
          From: "discord:user:1001",
          To: "discord:channel:2001",
          SessionKey: `agent:main:discord:direct:${scenario}`,
          MessageSid: `request-${scenario}`,
          Provider: "discord",
          Surface: "discord",
          ChatType: "direct",
          CommandAuthorized: true,
        },
        cfg,
      };
      const dispatch = dispatchInboundMessageWithBufferedDispatcher({
        ...dispatchParams,
        replyOptions: {
          blockReplyTimeoutMs: timesOut ? 50 : undefined,
          onAgentRunTerminalOutcome: () => {
            if (timesOut) {
              releaseBlock.resolve();
            }
          },
        },
        dispatcherOptions: {
          propagateRetryableNoSendFailure: true,
          deliver: async (payload, info) => {
            const call = {
              kind: info.kind,
              text: payload.text,
              ...(payload.mediaUrls?.length ? { mediaUrls: payload.mediaUrls } : {}),
            };
            attempted.push(call);
            if (info.kind === "block") {
              blocks++;
              if (scenario === "all-ambiguous") {
                throw new Error("transport response lost after send");
              }
              if (scenario === "concurrent" && blocks === 1) {
                blockStarted.resolve();
                await releaseBlock.promise;
              }
              if (blocks === 2) {
                if (timesOut) {
                  await releaseBlock.promise;
                  delivered.push(call);
                  return { visibleReplySent: true };
                }
                if (scenario === "recovery-owned") {
                  const error = new OutboundDeliveryError("retained for recovery", {
                    cause: noSend,
                  });
                  error.queueCustody = "held";
                  throw error;
                }
                if (scenario === "ambiguous" || scenario === "mixed") {
                  throw new Error("transport response lost after send");
                }
                if (scenario === "deferred-rejection") {
                  return { finalization: Promise.reject(noSend) };
                }
                if (scenario !== "confirmed") {
                  throw noSend;
                }
              }
              if (scenario === "mixed" && blocks === 3) {
                throw noSend;
              }
            }
            delivered.push(call);
            return { visibleReplySent: true };
          },
        },
      });
      if (scenario === "concurrent") {
        let otherDispatch:
          | ReturnType<typeof dispatchInboundMessageWithBufferedDispatcher>
          | undefined;
        try {
          await withTestTimeout(blockStarted.promise, 10000, "first transport start");
          const started = performance.now();
          otherDispatch = dispatchInboundMessageWithBufferedDispatcher({
            ...dispatchParams,
            ctx: {
              ...dispatchParams.ctx,
              SessionKey: "agent:main:discord:direct:1002",
              From: "discord:user:1002",
              MessageSid: "request-2",
            },
            dispatcherOptions: { deliver: async () => ({ visibleReplySent: true }) },
          });
          const other = await withTestTimeout(
            otherDispatch,
            10000,
            "other conversation during held transport",
          );
          concurrentElapsedMs = performance.now() - started;
          expect(other.settledReceipt?.anyVisibleDelivered).toBe(true);
          expect(other.settledReceipt?.counts.block.delivered).toBe(3);
          expect(other.settledReceipt?.counts.final.delivered).toBe(0);
          expect(delivered).toEqual([]);
        } finally {
          releaseBlock.resolve();
          await dispatch;
          await otherDispatch;
        }
      }
      const result = await dispatch;
      console.log(
        JSON.stringify({
          scenario,
          requests: requests.length,
          attempted,
          delivered,
          result,
          concurrentElapsedMs,
        }),
      );
      expect(requests.length).toBeGreaterThan(0);
      expect(blocks).toBeGreaterThanOrEqual(2);
      if (scenario === "timeout-media") {
        expect(blocks).toBe(2);
        expect(attempted.filter((call) => call.kind === "final")).toEqual([
          { kind: "final", text: undefined, mediaUrls: [finalMediaUrl] },
        ]);
        expect(delivered.filter((call) => call.mediaUrls?.length)).toEqual([
          { kind: "final", text: undefined, mediaUrls: [finalMediaUrl] },
        ]);
        expect(result.settledReceipt?.counts.final.delivered).toBe(1);
        expect(result.settledReceipt?.counts.block.delivered).toBe(2);
      } else if (
        scenario === "rejected" ||
        scenario === "deferred-rejection" ||
        scenario === "concurrent"
      ) {
        expect(delivered).toContainEqual({ kind: "final", text: finalText });
        expect(result.settledReceipt?.counts.block.failedBeforeSend).toBe(1);
        expect(result.settledReceipt?.counts.final.delivered).toBe(1);
      } else {
        expect(attempted.filter((call) => call.kind === "final")).toEqual([]);
        expect(result.settledReceipt?.counts.final.delivered).toBe(0);
        if (scenario === "confirmed" || scenario === "timeout") {
          expect(result.settledReceipt?.counts.block.delivered).toBe(blocks);
          if (scenario === "timeout") {
            expect(blocks).toBe(2);
          }
        } else if (scenario === "recovery-owned") {
          expect(result.settledReceipt?.hasPendingDelivery).toBe(true);
        } else {
          expect(result.settledReceipt?.counts.block.failedAfterSend).toBe(
            scenario === "all-ambiguous" ? blocks : 1,
          );
        }
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await state.cleanup();
      resetCommandQueueStateForTest();
    }
  },
  60000,
);
