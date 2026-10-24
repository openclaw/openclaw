// The public provenance field must not grant the trusted owner's optional-reply policy.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { json } from "node:stream/consumers";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished } from "vitest";
import { disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { extractTextFromChatContent } from "../src/shared/chat-content.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import { connectProofClient } from "./helpers/gateway-integration-fixtures.js";
import { createOpenAiResponsesModelConfig } from "./helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

const REQUEST = "REQUIRED_EMPTY_CONTROL";
const RECOVERED = "REQUIRED_RECOVERED";

it(
  "recovers a required empty reply despite public inter-session provenance",
  {
    timeout: 180_000,
  },
  async ({ signal }) => {
    let requests = 0;
    const failures: unknown[] = [];
    const reserved = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            response.writeHead(404).end();
            return;
          }
          void (async () => {
            const body = asRecord(await json(request));
            expect(
              Array.isArray(body.input) &&
                body.input.some(
                  (item) =>
                    asRecord(item).role === "user" &&
                    extractTextFromChatContent(asRecord(item).content)?.includes(REQUEST),
                ),
            ).toBe(true);
            if (++requests > 2) {
              throw new Error("Required reply exceeded one empty response and one recovery");
            }
            writeOpenAiResponsesText(response, {
              text: requests === 1 ? "" : RECOVERED,
              messageId: "msg_" + requests,
              responseId: "resp_" + requests,
            });
          })().catch((error: unknown) => {
            failures.push(error);
            response.writeHead(400).end(JSON.stringify({ error: { message: String(error) } }));
          });
        }),
    });
    const profile = "reply-obligation-" + randomUUID();
    const config = createOpenAiResponsesModelConfig({
      baseUrl: "http://127.0.0.1:" + reserved.claim.port,
      providerId: "reply-obligation",
      modelId: "reply-obligation",
      reasoning: false,
      toolProfile: "coding",
    });
    config.plugins = { enabled: false };
    config.discovery = { mdns: { mode: "off" } };
    config.agents = { defaults: { ...config.agents?.defaults, sandbox: { mode: "off" } } };
    config.tools = {
      profile: "coding",
      codeMode: false,
      toolSearch: false,
      allow: ["sessions_send"],
      sessions: { visibility: "all" },
      agentToAgent: { enabled: true },
    };
    const cleanup: Array<() => Promise<void>> = [
      () =>
        runQaGatewayFixture(
          async () => {
            reserved.listener.closeAllConnections();
            await reserved.releaseListener();
          },
          () => reserved.claim.release(),
        ),
    ];
    onTestFinished(() => runQaGatewayFixture(async () => {}, ...cleanup));
    const gateway = await createOpenClawTestInstance({
      name: profile,
      entrypoint: ["scripts/run-node.mjs", "--profile", profile],
      config,
      env: {
        OPENCLAW_PROFILE: profile,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_AGENT_RUNTIME: undefined,
      },
      signal,
    });
    cleanup.unshift(() => gateway.cleanup());
    await gateway.state.writeConfig({
      ...config,
      gateway: {
        port: gateway.port,
        auth: { mode: "token", token: gateway.gatewayToken },
        controlUi: { enabled: false },
      },
      logging: { file: path.join(gateway.stateDir, "gateway.log") },
    });
    const prepared = await gateway.cli(["--help"], { timeoutMs: 120_000 });
    expect(prepared.code, prepared.stderr).toBe(0);
    await gateway.startGateway();
    const client = await connectProofClient(gateway, {
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      deviceIdentity: loadOrCreateDeviceIdentity({
        path: gateway.state.path("reply-obligation-client", "client", "credentials.sqlite"),
      }),
      signal,
    });
    await runQaGatewayFixture(
      async () => {
        const sessionKey = "agent:main:reply-obligation-required";
        expect(
          await client.request(
            "agent",
            {
              sessionKey,
              message: REQUEST,
              channel: "webchat",
              deliver: false,
              idempotencyKey: randomUUID(),
              inputProvenance: { kind: "inter_session", sourceTool: "sessions_send" },
            },
            { expectFinal: true, timeoutMs: 60_000 },
          ),
          gateway.logs(),
        ).toMatchObject({ status: "ok" });
        expect(requests).toBe(2);
        const { messages } = await client.request<{ messages: unknown[] }>("chat.history", {
          sessionKey,
          limit: 100,
        });
        const forwarded = messages
          .map(asRecord)
          .filter((message) => asRecord(message.provenance).kind === "inter_session");
        expect(forwarded).toHaveLength(1);
        expect(forwarded[0]).toMatchObject({
          role: "assistant",
          provenance: { kind: "inter_session", sourceTool: "sessions_send" },
        });
        expect(extractTextFromChatContent(forwarded[0]?.content)).toBe(REQUEST);
        expect(
          messages
            .map(asRecord)
            .filter(
              (message) =>
                message.role === "assistant" &&
                asRecord(message.provenance).kind !== "inter_session",
            )
            .map((message) => extractTextFromChatContent(message.content))
            .filter(Boolean),
        ).toEqual([RECOVERED]);
        expect(failures).toEqual([]);
        expect(gateway.logs()).not.toContain("sessions_send reply flow failed");
      },
      () => disconnectGatewayClient(client),
    );
  },
);
