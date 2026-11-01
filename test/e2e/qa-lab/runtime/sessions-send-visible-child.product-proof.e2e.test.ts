// Real-Gateway proof for #144265: a parent spawns a visible child in one
// direct-message turn and sends it a waited message in the next turn.
import type { ServerResponse } from "node:http";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, expect, it } from "vitest";
import {
  createQaBusState,
  createQaChannelTransport,
  createQaGatewayChild,
  isInternalRuntimeContextCarrierText,
  startQaBusServer,
} from "../../../../extensions/qa-lab/api.js";
import type { SessionsListResult } from "../../../../src/gateway/session-utils.types.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../helpers/openai-responses-sse.js";
import { runQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { listenLoopback } from "./gateway-recovery.test-support.js";
import { closeNativeProvider, createNativeProvider } from "./native-provider-proof-fixture.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const MODEL = "mock-openai/qa-parent";
const CHILD_MODEL = "mock-openai/qa-child";
const PARENT_KEY = "agent:qa:main";
const CONVERSATION = { id: "visible-child-send", kind: "direct" as const };
const PROMPT_SPAWN = "Visible child send QA check: spawn one visible worker now.";
const PROMPT_SEND = "Visible child send QA check: send the worker one waited message now.";
const CHILD_MARKER = "QA-VISIBLE-CHILD-OK";
const PARENT_READY = "QA-VISIBLE-CHILD-PARENT-READY";
const PARENT_DONE = "QA-VISIBLE-CHILD-PARENT-DONE";
const REPLY_STEP_MARKER = "Agent-to-agent reply step";
const ANNOUNCE_STEP_MARKER = "Agent-to-agent announce step";

type ProviderRequest = {
  model: string;
  input: Array<{
    type?: string;
    role?: string;
    call_id?: string;
    output?: string;
    content?: unknown;
  }>;
  [key: string]: unknown;
};
type ToolReceipt = {
  status: string;
  runId: string;
  childSessionKey?: string;
  reply?: string;
  delivery?: { status: string };
};
type RequestEvidence = {
  kind: "title" | "parent" | "child";
  replyStep: boolean;
  announceStep: boolean;
};

function inputText(content: unknown): string {
  return Array.isArray(content)
    ? content
        .map((part: { text?: unknown }) => (typeof part?.text === "string" ? part.text : ""))
        .join("\n")
    : typeof content === "string"
      ? content
      : "";
}

function toolOutput(body: ProviderRequest, callId: string): ToolReceipt | undefined {
  const output = body.input.find(
    (item) => item.type === "function_call_output" && item.call_id === callId,
  )?.output;
  return output === undefined ? undefined : (JSON.parse(output) as ToolReceipt);
}

async function startProofProvider() {
  const requests: RequestEvidence[] = [];
  const errors: unknown[] = [];
  let spawn: ToolReceipt | undefined;
  let send: ToolReceipt | undefined;
  const server = createNativeProvider(
    async (request, response, rawBody) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            data: ["qa-parent", "qa-child"].map((id) => ({ id, object: "model" })),
          }),
        );
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const body = JSON.parse(rawBody) as ProviderRequest;
      const developerText = JSON.stringify(
        body.input.filter((item) => item.role === "developer" || item.role === "system"),
      );
      // Compatible Responses endpoints keep runtime context in user-role carriers
      // after the user turn; select the latest user-authored message instead.
      const userTexts = body.input
        .filter((item) => item.role === "user")
        .map((item) => inputText(item.content));
      const userText =
        userTexts.findLast((text) => !isInternalRuntimeContextCarrierText(text)) ?? "";
      const kind = developerText.includes("Generate a concise session title")
        ? "title"
        : body.model === "qa-child"
          ? "child"
          : "parent";
      const evidence: RequestEvidence = {
        kind,
        replyStep: developerText.includes(REPLY_STEP_MARKER),
        announceStep: userText.includes(ANNOUNCE_STEP_MARKER),
      };
      requests.push(evidence);
      const sequence = requests.length;
      const reply = (text: string) =>
        writeOpenAiResponsesText(response, {
          text,
          messageId: `msg_qa_${sequence}`,
          responseId: `resp_qa_${sequence}`,
        });
      if (kind === "title") {
        reply("Visible child send proof");
      } else if (evidence.replyStep || evidence.announceStep) {
        reply(evidence.replyStep ? "REPLY_SKIP" : "ANNOUNCE_SKIP");
      } else if (kind === "child") {
        reply(CHILD_MARKER);
      } else {
        spawn = toolOutput(body, "call_qa_spawn") ?? spawn;
        send = toolOutput(body, "call_qa_send") ?? send;
        if (send) {
          reply(PARENT_DONE);
        } else if (spawn && userText.includes(PROMPT_SEND)) {
          writeToolCall(response, "sessions_send", "call_qa_send", {
            sessionKey: spawn.childSessionKey,
            message: "Parent ping: reply with your marker.",
            timeoutSeconds: 60,
          });
        } else if (spawn) {
          reply(PARENT_READY);
        } else {
          writeToolCall(response, "sessions_spawn", "call_qa_spawn", {
            task: `Visible child QA worker. Return exactly ${CHILD_MARKER}.`,
            label: "qa-visible-child",
            visible: true,
            mode: "run",
            model: CHILD_MODEL,
            // Isolate waited-send delivery from the initial spawn handoff.
            expectsCompletionMessage: false,
          });
        }
      }
    },
    (error, response) => {
      errors.push(error);
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    },
  );
  const baseUrl = await listenLoopback(server, "proof provider did not bind");
  return {
    baseUrl,
    requests,
    errors,
    get spawn() {
      return spawn;
    },
    get send() {
      return send;
    },
    stop: () => closeNativeProvider(server),
  };
}

function writeToolCall(
  response: ServerResponse,
  name: string,
  callId: string,
  args: Record<string, unknown>,
): void {
  const item = {
    type: "function_call",
    id: `fc_${callId}`,
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
  };
  writeOpenAiResponsesSse(response, [
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${callId}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

function withModels(config: OpenClawConfig): OpenClawConfig {
  return {
    ...config,
    logging: { ...config.logging, level: "debug" },
    // The synthetic provider emits these two controlled tool calls directly.
    tools: { ...config.tools, toolSearch: { enabled: false } },
    agents: {
      ...config.agents,
      defaults: { ...config.agents?.defaults, model: { primary: MODEL } },
      entries: {
        ...config.agents?.entries,
        qa: { ...config.agents?.entries?.qa, model: { primary: MODEL } },
      },
    },
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(() => runQaGatewayFixture(async () => {}, ...cleanups.splice(0).toReversed()));

it("returns the waited reply inline without an announce run against the child", async () => {
  const provider = await startProofProvider();
  cleanups.push(() => provider.stop());
  const state = createQaBusState();
  const transport = createQaChannelTransport(state);
  const bus = await startQaBusServer({ state });
  cleanups.push(() => bus.stop());
  const owner = createQaGatewayChild();
  cleanups.push(async () => expect((await owner.stop()).errors).toEqual([]));
  const gateway = await owner.start({
    repoRoot: REPO_ROOT,
    initializeCurrentRuntimeState: true,
    // Source-mode startup exceeds the child Gateway's listen deadline.
    command: {
      executablePath: process.execPath,
      argsPrefix: ["dist/index.js"],
      cwd: REPO_ROOT,
      usePackagedPlugins: true,
    },
    providerBaseUrl: `${provider.baseUrl}/v1`,
    providerMode: "mock-openai",
    primaryModel: MODEL,
    alternateModel: CHILD_MODEL,
    transport,
    transportBaseUrl: bus.baseUrl,
    controlUiEnabled: false,
    mutateConfig: withModels,
  });
  await transport.waitReady({ gateway });
  const listSessions = async () =>
    (await gateway.call("sessions.list", { agentId: "qa", limit: 100 })) as SessionsListResult;
  const waitUntilIdle = () =>
    expect
      .poll(
        async () => {
          const { sessions } = await listSessions();
          return [PARENT_KEY, provider.spawn?.childSessionKey].map(
            (key) => sessions.find((entry) => entry.key === key)?.hasActiveRun,
          );
        },
        { timeout: 60_000 },
      )
      .toEqual([false, false]);
  const sendTurn = async (text: string, expectedReply: string) => {
    const sinceIndex = state
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound").length;
    await transport.sendInbound({
      accountId: "default",
      conversation: CONVERSATION,
      senderId: CONVERSATION.id,
      text,
    });
    await transport.waitForOutbound({
      conversation: CONVERSATION,
      sinceIndex,
      textIncludes: expectedReply,
      timeoutMs: 120_000,
    });
  };
  const waitForRun = async (receipt: ToolReceipt | undefined) => {
    expect(receipt?.runId).toBeTypeOf("string");
    expect(
      await gateway.call(
        "agent.wait",
        { runId: receipt?.runId, timeoutMs: 60_000 },
        { timeoutMs: 65_000 },
      ),
    ).toMatchObject({ status: "ok" });
  };

  await sendTurn(PROMPT_SPAWN, PARENT_READY);
  await waitForRun(provider.spawn);
  await waitUntilIdle();
  expect(provider.requests.filter((request) => request.kind === "child")).toHaveLength(1);

  await sendTurn(PROMPT_SEND, PARENT_DONE);
  await waitForRun(provider.send);
  await waitUntilIdle();
  const childKey = provider.spawn?.childSessionKey;
  const child = (await listSessions()).sessions.find((entry) => entry.key === childKey);
  // Close the owned Gateway before freezing evidence; provider and bus stay live
  // while its admitted work drains and its process exits.
  await gateway.stop();
  expect(provider.errors).toEqual([]);
  expect(child).toMatchObject({ spawnedBy: PARENT_KEY, parentSessionKey: PARENT_KEY });
  expect(provider.send).toMatchObject({
    status: "ok",
    reply: CHILD_MARKER,
    delivery: { status: "skipped" },
  });
  expect(provider.requests.filter((request) => request.kind === "child")).toHaveLength(2);
  expect(provider.requests.filter((request) => request.kind === "parent")).toHaveLength(4);
  expect(
    provider.requests.filter((request) => request.replyStep || request.announceStep),
  ).toHaveLength(0);
}, 400_000);
