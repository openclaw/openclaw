// Real-Gateway proof for #144265: a parent spawns a visible child (persistent
// dashboard key) in one turn and later sends it a waited sessions_send. The
// reply must come back inline without the generic A2A announce flow.
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  createQaBusState,
  createQaChannelTransport,
  createQaGatewayChild,
  startQaBusServer,
} from "../../../../extensions/qa-lab/api.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const MODEL = "mock-openai/gpt-5.6-luna";
const CHILD_MODEL = "mock-openai/gpt-5.6-luna-alt";
const CONVERSATION = { id: "visible-child-send", kind: "direct" as const };
const PROMPT_SPAWN = "Visible child send QA check: spawn one visible worker now.";
const PROMPT_SEND = "Visible child send QA check: send the worker one waited message now.";
const CHILD_MARKER = "QA-VISIBLE-CHILD-OK";
const PARENT_READY = "QA-VISIBLE-CHILD-PARENT-READY";
const PARENT_DONE = "QA-VISIBLE-CHILD-PARENT-DONE";
const REPLY_STEP_MARKER = "Agent-to-agent reply step";
const CHILD_KEY_PATTERN = /agent:qa:dashboard:[A-Za-z0-9-]+/;

type SseEvent = {
  type: string;
  response?: Record<string, unknown>;
  [key: string]: unknown;
};

let responseSequence = 0;

function buildAssistantEvents(text: string): SseEvent[] {
  const sequence = ++responseSequence;
  const responseId = `resp_qa_visible_child_${sequence}`;
  const itemId = `msg_qa_visible_child_${sequence}`;
  const part = { type: "output_text", text, annotations: [] };
  const item = {
    type: "message",
    id: itemId,
    role: "assistant",
    status: "completed",
    content: [part],
  };
  const position = { item_id: itemId, output_index: 0, content_index: 0 };
  return [
    {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        status: "in_progress",
        output: [],
        created_at: Math.floor(Date.now() / 1_000),
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, content: [], status: "in_progress" },
    },
    { type: "response.content_part.added", ...position, part: { ...part, text: "" } },
    { type: "response.output_text.delta", ...position, delta: text },
    { type: "response.output_text.done", ...position, text },
    { type: "response.content_part.done", ...position, part },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 64, output_tokens: 24, total_tokens: 88 },
      },
    },
  ];
}

function buildToolCallEvents(name: string, args: Record<string, unknown>): SseEvent[] {
  const sequence = ++responseSequence;
  const responseId = `resp_qa_visible_child_tool_${sequence}`;
  const itemId = `fc_qa_visible_child_${sequence}`;
  const callId = `call_qa_visible_child_${sequence}`;
  const argumentsText = JSON.stringify(args);
  const item = {
    type: "function_call",
    id: itemId,
    call_id: callId,
    name,
    arguments: argumentsText,
  };
  return [
    {
      type: "response.created",
      response: {
        id: responseId,
        object: "response",
        status: "in_progress",
        output: [],
        created_at: Math.floor(Date.now() / 1_000),
      },
    },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      item_id: itemId,
      output_index: 0,
      delta: argumentsText,
    },
    {
      type: "response.function_call_arguments.done",
      item_id: itemId,
      output_index: 0,
      name,
      arguments: argumentsText,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 64, output_tokens: 24, total_tokens: 88 },
      },
    },
  ];
}

function writeSse(response: ServerResponse, events: SseEvent[]): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const event of events) {
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

type ChildRequest = { index: number; replyStep: boolean; atMs: number };

async function startProofProvider() {
  const childRequests: ChildRequest[] = [];
  let parentRequests = 0;
  let parentReplySteps = 0;
  let spawnIssued = false;
  let sendIssued = false;
  let doneIssued = false;
  let childKey: string | undefined;
  let sendDeliveryStatus: string | undefined;
  let sendInlineReply: string | undefined;
  let sendOutputExcerpt: string | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "gpt-5.6-luna", object: "model" }] }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const inputText = JSON.stringify(body.input ?? body);
      // The alternate configured model identifies child requests.
      if (body.model === CHILD_MODEL.split("/")[1]) {
        childRequests.push({
          index: childRequests.length + 1,
          replyStep: inputText.includes(REPLY_STEP_MARKER),
          atMs: Date.now(),
        });
        writeSse(response, buildAssistantEvents(CHILD_MARKER));
        return;
      }
      parentRequests += 1;
      if (inputText.includes(REPLY_STEP_MARKER)) {
        // Only reachable through the A2A flow; answer without new tool calls.
        parentReplySteps += 1;
        writeSse(response, buildAssistantEvents(PARENT_DONE));
        return;
      }
      if (!spawnIssued) {
        spawnIssued = true;
        writeSse(
          response,
          buildToolCallEvents("sessions_spawn", {
            task: `Visible child QA worker. Return exactly ${CHILD_MARKER}.`,
            label: "qa-visible-child",
            visible: true,
            mode: "run",
            model: CHILD_MODEL,
          }),
        );
        return;
      }
      if (!childKey) {
        childKey = CHILD_KEY_PATTERN.exec(inputText)?.[0];
      }
      // Turn 2 arrives as a fresh user message after the child finished its run.
      if (childKey && !sendIssued && inputText.includes(PROMPT_SEND)) {
        sendIssued = true;
        writeSse(
          response,
          buildToolCallEvents("sessions_send", {
            sessionKey: childKey,
            message: "Parent ping: reply with your marker.",
            timeoutSeconds: 60,
          }),
        );
        return;
      }
      if (sendIssued && !doneIssued) {
        doneIssued = true;
        // The tool result is JSON inside a function_call_output string.
        const flat = inputText.replaceAll("\\n", " ").replaceAll("\\", "");
        const outputAt = flat.lastIndexOf("function_call_output");
        sendOutputExcerpt = flat.slice(outputAt, outputAt + 900);
        sendDeliveryStatus = /"delivery":\s*\{\s*"status":\s*"([a-z_]+)"/.exec(
          sendOutputExcerpt,
        )?.[1];
        sendInlineReply = /"reply":\s*"([^"]*)"/.exec(sendOutputExcerpt)?.[1];
        writeSse(response, buildAssistantEvents(PARENT_DONE));
        return;
      }
      writeSse(response, buildAssistantEvents(PARENT_READY));
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("proof provider did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    proof: {
      childRequests,
      get parentRequests() {
        return parentRequests;
      },
      get parentReplySteps() {
        return parentReplySteps;
      },
      get childKey() {
        return childKey;
      },
      get sendDeliveryStatus() {
        return sendDeliveryStatus;
      },
      get sendInlineReply() {
        return sendInlineReply;
      },
      get sendOutputExcerpt() {
        return sendOutputExcerpt;
      },
    },
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function withModels(config: OpenClawConfig): OpenClawConfig {
  return {
    ...config,
    logging: { ...config.logging, level: "debug" },
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

describe.runIf(process.env.OPENCLAW_PROOF_VISIBLE_CHILD_SEND === "1")(
  "sessions_send to a visible spawn child",
  () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).toReversed()) {
        await cleanup();
      }
    });

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
        // Built Gateway: source-mode tsx startup alone exceeds the QA child's
        // 120 s listen deadline on this checkout.
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
      const outboundCount = () =>
        state.getSnapshot().messages.filter((message) => message.direction === "outbound").length;

      // Turn 1: spawn the visible child and let its run finish.
      const sinceSpawn = outboundCount();
      await transport.sendInbound({
        accountId: "default",
        conversation: CONVERSATION,
        senderId: CONVERSATION.id,
        text: PROMPT_SPAWN,
      });
      await transport.waitForOutbound({
        conversation: CONVERSATION,
        sinceIndex: sinceSpawn,
        textIncludes: PARENT_READY,
        timeoutMs: 120_000,
      });
      await expect
        .poll(() => provider.proof.childRequests.length, { timeout: 60_000 })
        .toBeGreaterThanOrEqual(1);
      // Let the child's own completion announcement settle before the send.
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      const childRequestsAfterSpawn = provider.proof.childRequests.length;

      // Turn 2: waited sessions_send to the persisted dashboard child.
      const sinceSend = outboundCount();
      await transport.sendInbound({
        accountId: "default",
        conversation: CONVERSATION,
        senderId: CONVERSATION.id,
        text: PROMPT_SEND,
      });
      await transport.waitForOutbound({
        conversation: CONVERSATION,
        sinceIndex: sinceSend,
        textIncludes: PARENT_DONE,
        timeoutMs: 120_000,
      });
      // Give a stray detached A2A flow time to show up before counting.
      await new Promise((resolve) => setTimeout(resolve, 8_000));

      const childKey = provider.proof.childKey;
      const listing = (await gateway.call("sessions.list", { agentId: "qa", limit: 100 })) as {
        sessions?: Array<Record<string, unknown>>;
      };
      const child = listing.sessions?.find((entry) => entry.key === childKey);
      const replySteps = provider.proof.childRequests.filter((entry) => entry.replyStep);
      const logs = gateway.logs();
      const announceLines = logs
        .split("\n")
        .filter((line) => line.includes("sessions_send announce")).length;
      console.log(
        JSON.stringify({
          phase: "sessions-send-visible-child",
          childKey,
          childSpawnedBy: child?.spawnedBy,
          childParentSessionKey: child?.parentSessionKey,
          childRequestsAfterSpawn,
          childRequestsTotal: provider.proof.childRequests.length,
          childReplyStepRequests: replySteps.length,
          parentRequests: provider.proof.parentRequests,
          parentReplyStepRequests: provider.proof.parentReplySteps,
          sendDeliveryStatus: provider.proof.sendDeliveryStatus,
          sendInlineReply: provider.proof.sendInlineReply,
          sendOutputExcerpt: provider.proof.sendOutputExcerpt,
          announceFlowLogLines: announceLines,
        }),
      );
      expect(childKey).toMatch(CHILD_KEY_PATTERN);
      // Persisted lineage names the requester; the dashboard key is not a subagent key.
      expect(child?.spawnedBy).toBeTypeOf("string");
      // The waited send returned the child's reply inline and skipped delivery.
      expect(provider.proof.sendInlineReply).toBe(CHILD_MARKER);
      expect(provider.proof.sendDeliveryStatus).toBe("skipped");
      // Exactly one child run for the send; no A2A reply-step or announce run.
      expect(provider.proof.childRequests.length).toBe(childRequestsAfterSpawn + 1);
      expect(replySteps).toHaveLength(0);
      expect(provider.proof.parentReplySteps).toBe(0);
      expect(announceLines).toBe(0);
    }, 400_000);
  },
);
