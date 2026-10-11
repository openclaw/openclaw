import { createServer } from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { GatewayClientOptions } from "../../src/gateway/client.js";
import { buildMockOpenAiResponsesProvider } from "../../src/gateway/test-openai-responses-model.js";
import { loadOrCreateDeviceIdentity } from "../../src/infra/device-identity.js";
import { reserveTestPortListener } from "../../src/test-utils/port-claims.js";
import { acquireGatewayTestClient } from "./gateway-client.js";
import { writeOpenAiResponsesSse, writeOpenAiResponsesText } from "./openai-responses-sse.js";
import { createOpenClawTestInstance } from "./openclaw-test-instance.js";
import { createDeferred } from "./promise.js";

/** Real provider transport and CLI process; no question/admission owners are mocked. */
export async function createDurableQuestionGateway(
  signal: AbortSignal,
  options?: { config?: Record<string, unknown>; continuationToolEffect?: boolean },
) {
  const asked = createDeferred();
  const continued = createDeferred<string>();
  const busyStarted = createDeferred();
  const busyRelease = createDeferred();
  let busyIssued = false;
  let continuationCount = 0;
  let continuationToolIssued = false;
  const failed = createDeferred<never>();
  void failed.promise.catch(() => {});
  let issued = false;
  let searched = false;
  let ordinal = 0;
  let observedToolNames: string[] = [];
  let observedDurableGuidance = false;
  const provider = await reserveTestPortListener({
    offsets: [0],
    signal,
    createListener: () =>
      createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
          }
          const text = Buffer.concat(chunks).toString("utf8");
          const body: unknown = JSON.parse(text);
          if (!isRecord(body) || request.url !== "/v1/responses") {
            throw new Error(`Unexpected provider route ${request.url}`);
          }
          ordinal += 1;
          observedDurableGuidance ||= text.includes(
            "Durably accepted ordinary questions hand off this turn",
          );
          observedToolNames = Array.isArray(body.tools)
            ? body.tools.flatMap((tool) =>
                isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [],
              )
            : [];
          const nativeTools =
            Array.isArray(body.tools) &&
            body.tools.some((tool) => isRecord(tool) && tool.name === "ask_user");
          if (text.includes("DURABLE_ASK_PROOF") && !issued && !nativeTools && !searched) {
            if (
              !observedToolNames.includes("tool_search") ||
              !observedToolNames.includes("tool_call")
            ) {
              throw new Error(
                `Native question discovery unavailable: ${observedToolNames.join(", ")}`,
              );
            }
            searched = true;
            const item = {
              type: "function_call",
              id: "fc_question_search",
              call_id: "call_question_search",
              name: "tool_search",
              arguments: JSON.stringify({ query: "ask_user" }),
            };
            writeOpenAiResponsesSse(response, [
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { ...item, arguments: "" },
              },
              {
                type: "response.function_call_arguments.delta",
                output_index: 0,
                item_id: item.id,
                delta: item.arguments,
              },
              { type: "response.output_item.done", output_index: 0, item },
              {
                type: "response.completed",
                response: {
                  id: "resp_question_search",
                  status: "completed",
                  output: [item],
                  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                },
              },
            ]);
            return;
          }
          if (text.includes("DURABLE_ASK_PROOF") && !issued) {
            issued = true;
            const questionArgs = {
              questions: [
                {
                  id: "choice",
                  header: "Deployment",
                  question: "Which environment?",
                  options: [
                    { label: "Staging", description: "Test deployment" },
                    { label: "Production", description: "Live deployment" },
                  ],
                },
              ],
              timeoutSeconds: 900,
            };
            const args = JSON.stringify(
              nativeTools ? questionArgs : { id: "ask_user", args: questionArgs },
            );
            const item = {
              type: "function_call",
              id: "fc_durable_question",
              call_id: "call_durable_question",
              name: nativeTools ? "ask_user" : "tool_call",
              arguments: args,
            };
            const later = {
              type: "function_call",
              id: "fc_later_side_effect",
              call_id: "call_later_side_effect",
              name: "exec",
              arguments: JSON.stringify({
                command: "echo started > durable-question-side-effect-started",
              }),
            };
            writeOpenAiResponsesSse(response, [
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { ...item, arguments: "" },
              },
              {
                type: "response.function_call_arguments.delta",
                output_index: 0,
                item_id: item.id,
                delta: args,
              },
              { type: "response.output_item.done", output_index: 0, item },
              {
                type: "response.output_item.added",
                output_index: 1,
                item: { ...later, arguments: "" },
              },
              {
                type: "response.function_call_arguments.delta",
                output_index: 1,
                item_id: later.id,
                delta: later.arguments,
              },
              { type: "response.output_item.done", output_index: 1, item: later },
              {
                type: "response.completed",
                response: {
                  id: "resp_question",
                  status: "completed",
                  output: [item, later],
                  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                },
              },
            ]);
            asked.resolve();
            return;
          }
          const continuationPrefix =
            "The previously requested user question has resolved. Continue the original task using this result:\n";
          const continuationInput = Array.isArray(body.input)
            ? body.input
                .filter((item) => isRecord(item) && item.role === "user")
                .flatMap((item) =>
                  isRecord(item) && Array.isArray(item.content)
                    ? item.content.flatMap((part) =>
                        isRecord(part) && typeof part.text === "string" ? [part.text] : [],
                      )
                    : [],
                )
                .find((input) => input.includes(continuationPrefix))
            : undefined;
          const isContinuation = continuationInput !== undefined;
          if (text.includes("DURABLE_BUSY_PROOF") && !busyIssued && !isContinuation) {
            busyIssued = true;
            busyStarted.resolve();
            await busyRelease.promise;
            if (!response.destroyed) {
              writeOpenAiResponsesText(response, {
                text: "DURABLE_BUSY_TURN_COMPLETED",
                messageId: `msg_${ordinal}`,
                responseId: `resp_${ordinal}`,
              });
            }
            return;
          }
          const reply = isContinuation
            ? "DURABLE_CONTINUATION_USED_STAGING"
            : "Synthetic durable question session";
          if (isContinuation) {
            const resultText = continuationInput
              .slice(continuationInput.indexOf(continuationPrefix) + continuationPrefix.length)
              .split("\n")[0];
            if (!resultText) {
              throw new Error("Continuation result envelope missing");
            }
            const result: unknown = JSON.parse(resultText);
            if (
              !isRecord(result) ||
              result.status !== "answered" ||
              !isRecord(result.answers) ||
              !isRecord(result.answers.answers) ||
              JSON.stringify(result.answers.answers.choice) !== JSON.stringify(["Staging"])
            ) {
              throw new Error("Continuation lost committed answer context");
            }
            continuationCount++;
            continued.resolve(text);
            if (options?.continuationToolEffect && !continuationToolIssued) {
              continuationToolIssued = true;
              const item = {
                type: "function_call",
                id: "fc_continuation_effect",
                call_id: "call_continuation_effect",
                name: "exec",
                arguments: JSON.stringify({
                  command:
                    "echo completed > durable-question-continuation-effect && printf 'DURABLE_CONTINUATION_EXEC_OK'",
                  workdir: instance.state.workspaceDir,
                }),
              };
              writeOpenAiResponsesSse(response, [
                {
                  type: "response.output_item.added",
                  output_index: 0,
                  item: { ...item, arguments: "" },
                },
                {
                  type: "response.function_call_arguments.delta",
                  output_index: 0,
                  item_id: item.id,
                  delta: item.arguments,
                },
                { type: "response.output_item.done", output_index: 0, item },
                {
                  type: "response.completed",
                  response: {
                    id: "resp_continuation_effect",
                    status: "completed",
                    output: [item],
                    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                  },
                },
              ]);
              return;
            }
          }
          if (isContinuation && options?.continuationToolEffect) {
            const results = Array.isArray(body.input)
              ? body.input.filter(
                  (item) =>
                    isRecord(item) &&
                    item.type === "function_call_output" &&
                    item.call_id === "call_continuation_effect",
                )
              : [];
            if (
              results.length !== 1 ||
              !isRecord(results[0]) ||
              typeof results[0].output !== "string" ||
              results[0].output.trim() !== "DURABLE_CONTINUATION_EXEC_OK"
            ) {
              throw new Error(
                "Native continuation exec did not return its successful write receipt",
              );
            }
          }
          writeOpenAiResponsesText(response, {
            text: reply,
            messageId: `msg_${ordinal}`,
            responseId: `resp_${ordinal}`,
          });
        })().catch((error: unknown) => {
          failed.reject(error);
          response.destroy(error instanceof Error ? error : undefined);
        });
      }),
  });
  const model = buildMockOpenAiResponsesProvider(`http://127.0.0.1:${provider.claim.port}/v1`);
  const instance = await createOpenClawTestInstance({
    name: "durable-question",
    signal,
    startTimeoutMs: 120_000,
    config: {
      update: { checkOnStart: false },
      browser: { enabled: false },
      discovery: { mdns: { mode: "off" } },
      agents: {
        defaults: {
          heartbeat: { every: "0m" },
          model: { primary: model.modelRef },
          models: {
            [model.modelRef]: {
              agentRuntime: { id: "openclaw" },
              params: { transport: "sse", openaiWsWarmup: false },
            },
          },
        },
      },
      models: {
        mode: "merge",
        providers: {
          [model.providerId]: {
            ...model.config,
            agentRuntime: { id: "openclaw" },
            request: { allowPrivateNetwork: true },
          },
        },
      },
      tools: { codeMode: false, exec: { host: "gateway", security: "full", ask: "off" } },
      ...options?.config,
    },
    env: {
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      VITEST: undefined,
      NODE_ENV: undefined,
      NODE_OPTIONS: undefined,
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_SKIP_CHANNELS: undefined,
    },
  });
  const identity = loadOrCreateDeviceIdentity({
    path: instance.state.path("durable-device.sqlite"),
  });
  return {
    instance,
    model,
    asked: asked.promise,
    continued: continued.promise,
    busyStarted: busyStarted.promise,
    releaseBusy: () => busyRelease.resolve(),
    get continuationCount() {
      return continuationCount;
    },
    failed: failed.promise,
    diagnostics: () =>
      `Provider requests: ${ordinal}; question emitted: ${issued}; native durable guidance observed: ${observedDurableGuidance}; tool names: ${observedToolNames.join(", ")}`,
    connect: (onEvent?: GatewayClientOptions["onEvent"]) =>
      acquireGatewayTestClient(
        {
          url: instance.url,
          token: instance.gatewayToken,
          deviceIdentity: identity,
          // Persistent user ingress acquires its profile through the real handshake.
          clientName: GATEWAY_CLIENT_NAMES.TUI,
          mode: GATEWAY_CLIENT_MODES.UI,
          clientVersion: "test",
          platform: process.platform,
          role: "operator",
          scopes: ["operator.admin", "operator.read", "operator.write", "operator.questions"],
          onEvent,
        },
        {
          timeoutMs: 30_000,
          timeoutMessage: "durable question client did not connect",
          closeMessage: "durable question client closed",
          signal,
        },
      ),
    async cleanup() {
      busyRelease.resolve();
      try {
        await instance.cleanup();
      } finally {
        provider.listener.closeAllConnections();
        await provider.releaseListener();
        await provider.claim.release();
      }
    },
  };
}
