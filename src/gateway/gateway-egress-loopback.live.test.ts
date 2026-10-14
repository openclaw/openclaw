import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it } from "vitest";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../test/helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { isLiveTestEnabled, logLiveProgress } from "../agents/live-test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";

const describeLive = isLiveTestEnabled() ? describe : describe.skip;
const MODEL_REF = "egress-proof/egress-proof";
let instance: OpenClawTestInstance | undefined;
let fixture: Awaited<ReturnType<typeof startFixture>> | undefined;

afterEach(async () => {
  await runQaGatewayFixture(
    async () => {},
    () => instance?.cleanup(),
    () => fixture?.close(),
  );
  instance = undefined;
  fixture = undefined;
});

describeLive("Gateway exec loopback HTTP under the secret egress proxy", () => {
  it(
    "returns the local server body through the Gateway-owned proxy and real exec tool",
    { timeout: 180_000 },
    async () => {
      const activeFixture = await startFixture();
      fixture = activeFixture;
      const gateway = await createOpenClawTestInstance({
        name: "egress-loopback",
        entrypoint: ["scripts/run-node.mjs"],
        config: createConfig(activeFixture.url),
        env: {
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_AGENT_RUNTIME: undefined,
          NO_PROXY: "",
          no_proxy: "",
        },
      });
      instance = gateway;
      // The default fixture can reuse stamped dist; this wrapper checks candidate freshness.
      const prepared = await gateway.cli(["--help"], { timeoutMs: 120_000 });
      expect(prepared.code, prepared.stderr).toBe(0);
      await gateway.startGateway();
      const client = await connectGatewayClient({
        url: gateway.url,
        token: gateway.gatewayToken,
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });
      try {
        const result = await client.request(
          "agent",
          {
            sessionKey: "agent:main:egress-loopback-proof",
            message: "Run the local HTTP fixture probe.",
            deliver: false,
            idempotencyKey: randomUUID(),
          },
          { expectFinal: true, timeoutMs: 60_000 },
        );
        expect(result, gateway.logs()).toMatchObject({ status: "ok" });
        expect(activeFixture.failures).toEqual([]);
        expect(activeFixture.originRequests).toEqual(["/ok"]);
        expect(activeFixture.outputs).toHaveLength(1);
        expect(activeFixture.outputs[0]).toContain(activeFixture.marker);
        logLiveProgress(
          "Gateway exec curl returned the loopback HTTP body through its proxy grant",
        );
      } finally {
        await disconnectGatewayClient(client);
      }
    },
  );
});

function createConfig(url: string): OpenClawConfig {
  return {
    plugins: { enabled: false },
    secrets: { egressProxy: { enabled: true } },
    agents: {
      defaults: {
        heartbeat: { every: "0m" },
        model: { primary: MODEL_REF },
        models: { [MODEL_REF]: { agentRuntime: { id: "openclaw" } } },
        skipBootstrap: true,
        skills: [],
        sandbox: { mode: "off" },
      },
    },
    tools: {
      profile: "coding",
      codeMode: false,
      toolSearch: false,
      allow: ["exec"],
      exec: { host: "gateway", security: "full", ask: "off" },
    },
    models: {
      mode: "replace",
      providers: {
        "egress-proof": {
          baseUrl: `${url}/v1`,
          apiKey: "test-placeholder",
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "egress-proof",
              name: "egress-proof",
              api: "openai-responses",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 4096,
            },
          ],
        },
      },
    },
  };
}

async function startFixture() {
  const marker = `LOOPBACK_HTTP_${randomUUID()}`;
  const outputs: string[] = [];
  const originRequests: string[] = [];
  const failures: string[] = [];
  let modelRequests = 0;
  let url = "";
  const reserved = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        void handle(request, response).catch((error: unknown) => {
          failures.push(String(error));
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: String(error) } }));
        });
      }),
  });
  url = `http://127.0.0.1:${reserved.claim.port}`;

  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (request.method === "GET" && request.url === "/ok") {
      originRequests.push(request.url);
      response.writeHead(200, { "content-type": "text/plain" }).end(marker);
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    if (++modelRequests > 2) {
      throw new Error("Expected one exec call and one completed tool result");
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const body = asOptionalRecord(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const input = Array.isArray(body?.input) ? body.input.map(asOptionalRecord) : [];
    const output = input.findLast((item) => item?.type === "function_call_output");
    if (output) {
      outputs.push(String(output.output));
      writeOpenAiResponsesText(response, {
        text: "Local HTTP probe completed.",
        messageId: "msg_egress",
        responseId: "resp_egress_done",
      });
      return;
    }
    // curl deliberately ignores uppercase HTTP_PROXY; pass the injected grant explicitly.
    const command =
      'test -n "$HTTP_PROXY" && curl --proxy "$HTTP_PROXY" --noproxy "" --fail --silent --show-error ' +
      `${url}/ok`;
    const item = {
      type: "function_call",
      id: "fc_egress",
      call_id: "call_egress",
      name: "exec",
      arguments: JSON.stringify({ command }),
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
          id: "resp_egress_call",
          status: "completed",
          output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ]);
  }

  return {
    url,
    marker,
    outputs,
    originRequests,
    failures,
    close: () =>
      runQaGatewayFixture(
        async () => {
          reserved.listener.closeAllConnections();
          await reserved.releaseListener();
        },
        () => reserved.claim.release(),
      ),
  };
}
