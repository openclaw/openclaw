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
const mediaCaption = "Here is the generated image.";
const fallbackText = "The backup produced a second answer.";

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
  "ambiguous-media",
  "recovery-owned-media",
  "all-ambiguous-media",
  "direct-ambiguous-media",
  "direct-recovery-owned-media",
  "direct-confirmed-media",
  "direct-rejected-media",
  "direct-no-delivery",
  "fallback-ambiguous",
  "fallback-recovery-owned",
  "fallback-rejected",
  "fallback-direct-ambiguous",
  "fallback-direct-recovery-owned",
  "fallback-direct-rejected",
] as const)(
  "dispatchInboundMessageWithBufferedDispatcher settles %s streamed blocks before final suppression",
  async (scenario) => {
    const timesOut = scenario === "timeout" || scenario === "timeout-media";
    const fallback = scenario.startsWith("fallback-");
    const fallbackDirect = scenario.startsWith("fallback-direct-");
    const fallbackRejected = fallback && scenario.endsWith("-rejected");
    const fallbackRecoveryOwned = fallback && scenario.endsWith("-recovery-owned");
    const directMedia =
      scenario === "direct-ambiguous-media" ||
      scenario === "direct-recovery-owned-media" ||
      scenario === "direct-confirmed-media" ||
      scenario === "direct-rejected-media" ||
      scenario === "direct-no-delivery";
    const allAmbiguous = scenario === "all-ambiguous" || scenario === "all-ambiguous-media";
    const uncertainMedia =
      scenario === "ambiguous-media" ||
      scenario === "recovery-owned-media" ||
      scenario === "all-ambiguous-media";
    const responseText = directMedia
      ? mediaCaption
      : scenario === "timeout-media" || uncertainMedia
        ? `${finalText}\nMEDIA:${finalMediaUrl}`
        : finalText;
    const state = await createOpenClawTestState({
      label: "block-streaming-recovery",
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    });
    const requests: Array<{ method?: string; url?: string; model?: string }> = [];
    const toolRequestBodies: string[] = [];
    const attempted: Array<{ kind: string; text: string | undefined; mediaUrls?: string[] }> = [];
    const delivered: Array<{ kind: string; text: string | undefined; mediaUrls?: string[] }> = [];
    const fallbackEvents: string[] = [];
    const server = createServer((request, response) => {
      const requestRecord: { method?: string; url?: string; model?: string } = {
        method: request.method,
        url: request.url,
      };
      requests.push(requestRecord);
      const sendResponse = () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (fallback) {
          const backup = requestRecord.model === "backup";
          fallbackEvents.push(`request:${requestRecord.model}`);
          const text = backup ? fallbackText : `${finalText}\nMEDIA:${finalMediaUrl}`;
          const item = {
            id: "message-fixture",
            type: "message",
            role: "assistant",
            phase: "final_answer",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          };
          for (const event of [
            {
              type: "response.created",
              response: { id: "response-fixture", status: "in_progress" },
            },
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, status: "in_progress", content: [] },
            },
            {
              type: "response.output_text.delta",
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              delta: text,
            },
            {
              type: "response.output_text.done",
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              text,
            },
            { type: "response.output_item.done", output_index: 0, item },
          ]) {
            response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          }
          const terminal = {
            type: backup ? "response.completed" : "response.failed",
            response: {
              id: "response-fixture",
              model: requestRecord.model,
              status: backup ? "completed" : "failed",
              output: [item],
              ...(backup
                ? {}
                : {
                    error: {
                      code: "insufficient_balance",
                      message: "Insufficient balance. Top up to continue.",
                    },
                  }),
            },
          };
          response.end(`event: ${terminal.type}\ndata: ${JSON.stringify(terminal)}\n\n`);
          return;
        }
        if (directMedia && requests.length === 1) {
          response.end(
            `data: ${JSON.stringify({
              id: "completion-fixture",
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: "media-call",
                        type: "function",
                        function: { name: "fixture_media", arguments: "{}" },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            })}\n\ndata: [DONE]\n\n`,
          );
          return;
        }
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
      };
      if (directMedia || fallback) {
        const chunks: string[] = [];
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          chunks.push(chunk);
        });
        request.on("end", () => {
          const body = chunks.join("");
          if (fallback) {
            const parsed: { model: string } = JSON.parse(body);
            requestRecord.model = parsed.model;
          } else {
            toolRequestBodies.push(body);
          }
          sendResponse();
        });
      } else {
        request.resume();
        sendResponse();
      }
    });
    try {
      const toolPluginPath = state.statePath("media-plugin", "index.cjs");
      if (directMedia) {
        await state.writeJson("media-plugin/openclaw.plugin.json", {
          id: "fixture-media",
          configSchema: { type: "object", additionalProperties: false, properties: {} },
          contracts: { tools: ["fixture_media"] },
        });
        await state.writeText(
          "media-plugin/index.cjs",
          `module.exports = {
          id: "fixture-media",
          register(api) {
            api.registerTool({
              name: "fixture_media", label: "Fixture media", description: "Generate a fixture image",
              parameters: { type: "object", properties: {} },
              async execute() {
                return {
                  content: [{ type: "text", text: "Fixture generated image." }],
                  details: { media: { mediaUrls: [${JSON.stringify(finalMediaUrl)}] } },
                };
              },
            });
          },
        };`,
        );
      }
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
            model: {
              primary: "fixture/answer",
              ...(fallback ? { fallbacks: ["fixture-backup/backup"] } : {}),
            },
            models: {
              "fixture/answer": { agentRuntime: { id: "openclaw" } },
              ...(fallback
                ? { "fixture-backup/backup": { agentRuntime: { id: "openclaw" } } }
                : {}),
            },
            blockStreamingDefault: directMedia || fallbackDirect ? "off" : "on",
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
              api: fallback ? "openai-responses" : "openai-completions",
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
            ...(fallback
              ? {
                  "fixture-backup": {
                    baseUrl: `http://127.0.0.1:${address.port}/v1`,
                    apiKey: "synthetic-backup-key",
                    api: "openai-responses" as const,
                    request: { allowPrivateNetwork: true },
                    models: [
                      {
                        id: "backup",
                        name: "Backup",
                        reasoning: false,
                        input: ["text" as const],
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        contextWindow: 128000,
                        maxTokens: 4096,
                      },
                    ],
                  },
                }
              : {}),
          },
        },
        channels: {
          discord: {
            streaming: { mode: "off", block: { enabled: !directMedia && !fallbackDirect } },
          },
        },
        messages: { visibleReplies: "automatic" },
        plugins: {
          slots: { memory: "none" },
          ...(directMedia ? { allow: ["fixture-media"], load: { paths: [toolPluginPath] } } : {}),
        },
        tools: { profile: "minimal", ...(directMedia ? { alsoAllow: ["fixture_media"] } : {}) },
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
            if (fallback && info.kind === "block" && payload.text !== fallbackText) {
              fallbackEvents.push("primary-block");
              if (fallbackRejected) {
                throw noSend;
              }
              if (fallbackRecoveryOwned) {
                const error = new OutboundDeliveryError("retained for recovery", { cause: noSend });
                error.queueCustody = "held";
                throw error;
              }
              throw new Error("transport response lost after send");
            }
            if (scenario === "direct-no-delivery" && info.kind === "final") {
              throw noSend;
            }
            if (info.kind === "block") {
              blocks++;
              if (directMedia && payload.mediaUrls?.includes(finalMediaUrl)) {
                if (scenario === "direct-confirmed-media") {
                  delivered.push(call);
                  return { visibleReplySent: true };
                }
                if (scenario === "direct-rejected-media" || scenario === "direct-no-delivery") {
                  throw noSend;
                }
                if (scenario === "direct-recovery-owned-media") {
                  const error = new OutboundDeliveryError("retained for recovery", {
                    cause: noSend,
                  });
                  error.queueCustody = "held";
                  throw error;
                }
                throw new Error("transport response lost after send");
              }
              if (allAmbiguous) {
                throw new Error("transport response lost after send");
              }
              if (scenario === "concurrent" && blocks === 1) {
                blockStarted.resolve();
                await releaseBlock.promise;
              }
              if (uncertainMedia ? payload.mediaUrls?.includes(finalMediaUrl) : blocks === 2) {
                if (timesOut) {
                  await releaseBlock.promise;
                  delivered.push(call);
                  return { visibleReplySent: true };
                }
                if (scenario === "recovery-owned" || scenario === "recovery-owned-media") {
                  const error = new OutboundDeliveryError("retained for recovery", {
                    cause: noSend,
                  });
                  error.queueCustody = "held";
                  throw error;
                }
                if (
                  scenario === "ambiguous" ||
                  scenario === "ambiguous-media" ||
                  scenario === "mixed"
                ) {
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
      if (scenario === "direct-no-delivery") {
        await expect(dispatch).rejects.toBe(noSend);
        console.log(
          JSON.stringify({
            scenario,
            requests: requests.length,
            attempted,
            delivered,
            outcome: "retryable-no-send",
          }),
        );
        expect(toolRequestBodies[1]).toContain("Fixture generated image.");
        expect(attempted).toEqual([
          { kind: "block", text: mediaCaption, mediaUrls: [finalMediaUrl] },
          { kind: "final", text: mediaCaption },
        ]);
        expect(delivered).toEqual([]);
        return;
      }
      if (fallback) {
        let providerFailure: unknown;
        const result = await dispatch.catch((error: unknown) => {
          providerFailure = error;
          return undefined;
        });
        console.log(
          JSON.stringify({
            scenario,
            requests,
            fallbackEvents,
            attempted,
            delivered,
            result,
            providerFailure:
              providerFailure instanceof Error ? providerFailure.message : providerFailure,
          }),
        );
        expect(fallbackEvents).toContain("primary-block");
        if (fallbackRejected) {
          expect(requests.map((entry) => entry.model)).toEqual(["answer", "backup"]);
          expect(delivered.some((call) => call.text === fallbackText)).toBe(true);
          expect(providerFailure).toBeUndefined();
        } else {
          expect(requests.map((entry) => entry.model)).toEqual(["answer"]);
          expect(attempted.some((call) => call.text === fallbackText)).toBe(false);
          if (result) {
            expect(result.settledReceipt?.hasPendingDelivery).toBe(true);
          } else {
            expect(providerFailure).toBeInstanceOf(Error);
          }
        }
        return;
      }
      const result = await dispatch;
      console.log(
        JSON.stringify({
          scenario,
          requests: requests.length,
          requestEndpoints: requests,
          attempted,
          delivered,
          result,
          concurrentElapsedMs,
        }),
      );
      expect(requests).toEqual(
        scenario === "concurrent" || directMedia
          ? [
              { method: "POST", url: "/v1/chat/completions" },
              { method: "POST", url: "/v1/chat/completions" },
            ]
          : [{ method: "POST", url: "/v1/chat/completions" }],
      );
      expect(blocks).toBeGreaterThanOrEqual(directMedia ? 1 : 2);
      if (directMedia) {
        expect(toolRequestBodies[0]).toContain('"fixture_media"');
        expect(toolRequestBodies[1]).toContain("Fixture generated image.");
        expect(attempted).toEqual([
          { kind: "block", text: mediaCaption, mediaUrls: [finalMediaUrl] },
          ...(scenario === "direct-rejected-media" ? [{ kind: "final", text: mediaCaption }] : []),
        ]);
        if (scenario === "direct-confirmed-media") {
          expect(delivered).toEqual([
            { kind: "block", text: mediaCaption, mediaUrls: [finalMediaUrl] },
          ]);
        } else if (scenario === "direct-rejected-media") {
          expect(delivered).toEqual([{ kind: "final", text: mediaCaption }]);
          expect(result.settledReceipt?.counts.block.failedBeforeSend).toBe(1);
          expect(result.settledReceipt?.hasPendingDelivery).not.toBe(true);
        } else {
          expect(delivered).toEqual([]);
        }
        expect(result.settledReceipt?.counts.final.delivered).toBe(
          scenario === "direct-rejected-media" ? 1 : 0,
        );
        if (scenario === "direct-recovery-owned-media") {
          expect(result.settledReceipt?.hasPendingDelivery).toBe(true);
        } else if (scenario === "direct-ambiguous-media") {
          expect(result.settledReceipt?.counts.block.failedAfterSend).toBe(1);
        }
      } else if (uncertainMedia) {
        const mediaAttempts = attempted.filter((call) => call.mediaUrls?.includes(finalMediaUrl));
        expect(mediaAttempts).toEqual([
          expect.objectContaining({ kind: "block", mediaUrls: [finalMediaUrl] }),
        ]);
        expect(mediaAttempts[0]?.text).not.toBe(finalText);
        expect(delivered.filter((call) => call.mediaUrls?.length)).toEqual([]);
        expect(result.settledReceipt?.counts.block.delivered).toBe(allAmbiguous ? 0 : blocks - 1);
        expect(attempted.filter((call) => call.kind === "final")).toEqual([]);
        if (scenario === "recovery-owned-media") {
          expect(result.settledReceipt?.hasPendingDelivery).toBe(true);
        } else {
          expect(result.settledReceipt?.counts.block.failedAfterSend).toBe(
            allAmbiguous ? blocks : 1,
          );
        }
      } else if (scenario === "timeout-media") {
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
