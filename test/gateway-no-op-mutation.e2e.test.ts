// E2E: a Gateway agent turn continues after a real no-op write tool call.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { json } from "node:stream/consumers";
import { afterEach, expect, it } from "vitest";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
  type OpenAiResponsesModelServer,
} from "./helpers/openai-responses-model-fixture.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "./helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const SESSION_KEY = "agent:main:no-op-proof";
const VISIBLE_MARKER = "NO_OP_WRITE_VISIBLE_ANSWER";

type CapturedRequest = { input?: unknown[] };

const instances: OpenClawTestInstance[] = [];
const modelServers: OpenAiResponsesModelServer[] = [];

afterEach(async () => {
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.allSettled(modelServers.splice(0).map((server) => server.close()));
});

it(
  "Gateway no-op mutation continuation returns a visible answer after the first tool call is a no-op write",
  { timeout: 180_000 },
  async () => {
    const modelServer = await startMockModelServer();
    modelServers.push(modelServer);
    const instance = await createOpenClawTestInstance({
      name: "gateway-no-op-mutation",
      config: createOpenAiResponsesModelConfig({
        baseUrl: modelServer.baseUrl,
        providerId: "no-op-proof",
        modelId: "no-op-proof",
        reasoning: false,
        toolProfile: "coding",
      }),
      env: {
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      },
    });
    instances.push(instance);
    const notePath = path.join(instance.homeDir, ".openclaw", "workspace", "note.txt");
    await fs.mkdir(path.dirname(notePath), { recursive: true });
    await fs.writeFile(notePath, "done\n", "utf8");
    await instance.startGateway();

    const client = await connectGatewayClient({
      url: instance.url,
      token: instance.gatewayToken,
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    try {
      const runId = randomUUID();
      const response = await client.request<{
        runId?: string;
        status?: string;
        result?: { payloads?: Array<{ text?: string }> };
      }>(
        "agent",
        {
          sessionKey: SESSION_KEY,
          message: "Write note.txt with exactly done, then report the result.",
          deliver: false,
          idempotencyKey: runId,
        },
        { expectFinal: true, timeoutMs: 120_000 },
      );

      expect(response).toMatchObject({
        status: "ok",
        runId,
        result: {
          payloads: expect.arrayContaining([expect.objectContaining({ text: VISIBLE_MARKER })]),
        },
      });
      expect(modelServer.requests).toHaveLength(2);
      expect(JSON.stringify(modelServer.requests[1]?.input)).toContain("function_call_output");
      expect(JSON.stringify(modelServer.requests[1]?.input)).toContain("No changes made");
      await expect(fs.readFile(notePath, "utf8")).resolves.toBe("done\n");
    } finally {
      await disconnectGatewayClient(client);
    }
  },
);

async function startMockModelServer() {
  const requests: CapturedRequest[] = [];
  const server = await startOpenAiResponsesModelServer({
    modelId: "no-op-proof",
    bindError: "no-op proof model server did not bind",
    onRequest: async (request, response) => {
      requests.push((await json(request)) as CapturedRequest);
      if (requests.length === 1) {
        writeToolResponse(response);
      } else {
        writeOpenAiResponsesText(response, {
          text: VISIBLE_MARKER,
          messageId: "msg_no_op_visible",
          responseId: "resp_no_op_visible",
        });
      }
    },
  });
  return { ...server, requests };
}

function writeToolResponse(response: ServerResponse): void {
  const item = {
    type: "function_call",
    id: "fc_no_op_write",
    call_id: "call_no_op_write",
    name: "write",
    arguments: JSON.stringify({ path: "note.txt", content: "done\n" }),
    status: "completed",
  };
  writeOpenAiResponsesSse(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_no_op_write",
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      },
    },
  ]);
}
