import { createServer } from "node:http";
import { expect, it } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { setSessionMcpRuntimeScheduler } from "../agents/agent-bundle-mcp-manager-api.js";
import { getSessionMcpRuntimeTestManager } from "../agents/agent-bundle-mcp-manager.test-support.js";
import { model as createModelFixture } from "../agents/model-catalog-fixtures.test-support.js";
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
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { dispatchInboundMessageWithBufferedDispatcher } from "./dispatch.js";

const finalText = "```ts\n" + "const answer = 42;\n".repeat(20) + "```";
const finalMediaUrl = "https://example.test/final.png";
const mediaCaption = "Here is the generated image.";
const fallbackText = "The backup produced a second answer.";
const mediaBlock = { kind: "block", text: mediaCaption, mediaUrls: [finalMediaUrl] };
const mediaFinal = { kind: "final", text: undefined, mediaUrls: [finalMediaUrl] };
const completionRequest = { method: "POST", url: "/v1/chat/completions" };

function responseFrames(model?: string) {
  const backup = model === "backup";
  const status = backup ? "completed" : "failed";
  const error = backup
    ? undefined
    : { code: "insufficient_balance", message: "Insufficient balance. Top up to continue." };
  const text = backup ? fallbackText : `${finalText}\nMEDIA:${finalMediaUrl}`;
  const item = {
    id: "message-fixture",
    type: "message",
    role: "assistant",
    phase: "final_answer",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const indices = { item_id: item.id, output_index: 0, content_index: 0 };
  const frame = (type: string, fields: Record<string, unknown>) => {
    const event = { type: `response.${type}`, ...fields };
    return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  };
  return [
    frame("created", { response: { id: "response-fixture", status: "in_progress" } }),
    frame("output_item.added", {
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    }),
    frame("output_text.delta", { ...indices, delta: text }),
    frame("output_text.done", { ...indices, text }),
    frame("output_item.done", { output_index: 0, item }),
    frame(status, {
      response: {
        id: "response-fixture",
        model,
        status,
        output: [item],
        error,
      },
    }),
  ];
}

function completion(delta: Record<string, unknown>, finish_reason?: string) {
  return `data: ${JSON.stringify({ id: "completion-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
}

function fixtureProvider(
  baseUrl: string,
  id: "answer" | "backup",
  api: "openai-responses" | "openai-completions",
) {
  return {
    baseUrl,
    apiKey: id === "answer" ? "synthetic-test-key" : "synthetic-backup-key",
    api,
    request: { allowPrivateNetwork: true },
    models: [
      createModelFixture(id, id === "answer" ? "Answer" : "Backup", {
        contextWindow: 128000,
        maxTokens: 4096,
      }),
    ],
  };
}

it.for([
  "rejected",
  "deferred-rejection",
  "mixed",
  "concurrent",
  "timeout-media",
  "ambiguous-media",
  "recovery-owned-media",
  "all-ambiguous-media",
  "direct-confirmed-media",
  "direct-no-delivery",
  "fallback-ambiguous",
  "fallback-rejected",
  "fallback-direct-rejected",
] as const)(
  "dispatchInboundMessageWithBufferedDispatcher settles %s streamed blocks before final suppression",
  { timeout: 60000 },
  async (scenario, { signal }) => {
    const timesOut = scenario === "timeout-media";
    const fallback = scenario.startsWith("fallback-");
    const fallbackDirect = scenario.startsWith("fallback-direct-");
    const fallbackRejected = fallback && scenario.endsWith("-rejected");
    const directMedia = scenario === "direct-confirmed-media" || scenario === "direct-no-delivery";
    const allAmbiguous = scenario === "all-ambiguous-media";
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
    const scheduler = createTestGatewayScheduler();
    const requests: Array<{ method?: string; url?: string; model?: string }> = [];
    const toolRequestBodies: string[] = [];
    const attempted: Array<{ kind: string; text: string | undefined; mediaUrls?: string[] }> = [];
    const delivered: Array<{ kind: string; text: string | undefined; mediaUrls?: string[] }> = [];
    let primaryBlockAttempted = false;
    const server = createServer((request, response) => {
      const requestRecord: { method?: string; url?: string; model?: string } = {
        method: request.method,
        url: request.url,
      };
      requests.push(requestRecord);
      const sendResponse = () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (fallback) {
          const frames = responseFrames(requestRecord.model);
          for (const frame of frames.slice(0, -1)) {
            response.write(frame);
          }
          response.end(frames.at(-1));
          return;
        }
        if (directMedia && requests.length === 1) {
          response.end(
            completion(
              {
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
              "tool_calls",
            ) + "data: [DONE]\n\n",
          );
          return;
        }
        for (const text of [responseText.slice(0, 180), responseText.slice(180)]) {
          response.write(completion({ role: "assistant", content: text }));
        }
        response.end(completion({}, "stop") + "data: [DONE]\n\n");
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
      await setSessionMcpRuntimeScheduler(scheduler);
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
      const baseUrl = `${await listenLoopback(server)}/v1`;
      const configuredModels: Array<[string, "answer" | "backup"]> = [["fixture", "answer"]];
      if (fallback) {
        configuredModels.push(["fixture-backup", "backup"]);
      }
      const cfg = {
        agents: {
          ownership: "explicit",
          entries: { main: {} },
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            model: {
              primary: "fixture/answer",
              ...(fallback ? { fallbacks: ["fixture-backup/backup"] } : {}),
            },
            models: Object.fromEntries(
              configuredModels.map(([provider, id]) => [
                `${provider}/${id}`,
                { agentRuntime: { id: "openclaw" as const } },
              ]),
            ),
            blockStreamingDefault: directMedia || fallbackDirect ? "off" : "on",
            blockStreamingChunk: { minChars: 80, maxChars: 160 },
            blockStreamingCoalesce: { minChars: 1, maxChars: 160, idleMs: 0 },
          },
        },
        models: {
          mode: "replace",
          providers: Object.fromEntries(
            configuredModels.map(([provider, id]) => [
              provider,
              fixtureProvider(baseUrl, id, fallback ? "openai-responses" : "openai-completions"),
            ]),
          ),
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
        tools: {
          profile: "minimal",
          // This provider scripts a direct media call to exercise delivery settlement.
          ...(directMedia ? { toolSearch: false, alsoAllow: ["fixture_media"] } : {}),
        },
      } satisfies OpenClawConfig;
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      applyGatewayLaneConcurrency(resolveGatewayLaneConcurrency(cfg));
      let blocks = 0;
      const blockStarted = createDeferred();
      const releaseBlock = createDeferred();
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
              primaryBlockAttempted = true;
              if (fallbackRejected) {
                throw noSend;
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
                throw noSend;
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
                if (scenario === "recovery-owned-media") {
                  const error = new OutboundDeliveryError("retained for recovery", {
                    cause: noSend,
                  });
                  error.queueCustody = "held";
                  throw error;
                }
                if (scenario === "ambiguous-media" || scenario === "mixed") {
                  throw new Error("transport response lost after send");
                }
                if (scenario === "deferred-rejection") {
                  return { finalization: Promise.reject(noSend) };
                }
                throw noSend;
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
          await withinTest(
            awaitGateBeforeSettlement(blockStarted.promise, dispatch, "first transport start"),
            signal,
          );
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
          const other = await withinTest(otherDispatch, signal);
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
        expect(toolRequestBodies[1]).toContain("Fixture generated image.");
        expect(attempted).toEqual([mediaBlock, { kind: "final", text: mediaCaption }]);
        expect(delivered).toEqual([]);
        return;
      }
      if (fallback) {
        let providerFailure: unknown;
        const result = await dispatch.catch((error: unknown) => {
          providerFailure = error;
          return undefined;
        });
        expect(primaryBlockAttempted).toBe(true);
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
      expect(requests).toEqual(
        Array.from(
          { length: scenario === "concurrent" || directMedia ? 2 : 1 },
          () => completionRequest,
        ),
      );
      expect(blocks).toBeGreaterThanOrEqual(directMedia ? 1 : 2);
      if (directMedia) {
        expect(toolRequestBodies[0]).toContain('"fixture_media"');
        expect(toolRequestBodies[1]).toContain("Fixture generated image.");
        expect(attempted).toEqual([mediaBlock]);
        expect(delivered).toEqual([mediaBlock]);
        expect(result.settledReceipt?.counts.final.delivered).toBe(0);
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
        expect(attempted.filter((call) => call.kind === "final")).toEqual([mediaFinal]);
        expect(delivered.filter((call) => call.mediaUrls?.length)).toEqual([mediaFinal]);
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
        expect(result.settledReceipt?.counts.block.failedAfterSend).toBe(1);
      }
    } finally {
      const mcpManager = getSessionMcpRuntimeTestManager();
      for (const sessionId of mcpManager.listSessionIds()) {
        if (mcpManager.peekSession({ sessionId })?.workspaceDir === state.workspaceDir) {
          await mcpManager.disposeSession(sessionId);
        }
      }
      await scheduler.stop();
      await closeHttpServer(server);
      await state.cleanup();
      resetCommandQueueStateForTest();
    }
  },
);
