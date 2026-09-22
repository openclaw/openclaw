// Real-Gateway proof for #144265: a parent spawns a visible child in one
// direct-message turn and sends it a waited message in the next turn.
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
import type { SessionsListResult } from "../../../../src/gateway/session-utils.types.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../helpers/openai-responses-sse.js";

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
const CHILD_KEY_PATTERN = /^agent:qa:dashboard:[A-Za-z0-9-]+$/;

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
  body: ProviderRequest;
  kind: "title" | "parent" | "child";
  replyStep: boolean;
  announceStep: boolean;
};

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
  const server = createServer((request, response) => {
    void (async () => {
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
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ProviderRequest;
      const developerText = JSON.stringify(
        body.input.filter((item) => item.role === "developer" || item.role === "system"),
      );
      const userText = JSON.stringify(
        body.input.findLast(
          (item) =>
            item.role === "user" &&
            !JSON.stringify(item.content).includes("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>"),
        ),
      );
      const kind = developerText.includes("Generate a concise session title")
        ? "title"
        : body.model === "qa-child"
          ? "child"
          : "parent";
      const evidence: RequestEvidence = {
        body,
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
    })().catch((error: unknown) => {
      errors.push(error);
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
    requests,
    errors,
    get spawn() {
      return spawn;
    },
    get send() {
      return send;
    },
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
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
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: 0,
      delta: item.arguments,
    },
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
      const errors: unknown[] = [];
      for (const cleanup of cleanups.splice(0).toReversed()) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        throw new AggregateError(errors, "visible child proof cleanup failed");
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
      const announceLines = gateway
        .logs()
        .split("\n")
        .filter((line) => line.includes("sessions_send announce"));
      console.log(
        JSON.stringify({
          phase: "sessions-send-visible-child",
          requests: provider.requests,
          spawn: provider.spawn,
          send: provider.send,
          child,
          announceLines,
        }),
      );
      expect(provider.errors).toEqual([]);
      expect(childKey).toMatch(CHILD_KEY_PATTERN);
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
      expect(announceLines).toHaveLength(0);
    }, 400_000);
  },
);
