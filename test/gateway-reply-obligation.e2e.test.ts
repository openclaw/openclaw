// Real Gateway admission, in-process sessions_send callback, and HTTP provider completion.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { json } from "node:stream/consumers";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it } from "vitest";
import { isInternalRuntimeContextCarrierText } from "../extensions/qa-lab/api.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import { createOpenAiResponsesModelConfig } from "./helpers/openai-responses-model-fixture.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "./helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";
import { createDeferred, withinTest } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

const REQUIRED_REQUEST = "REQUIRED_EMPTY_CONTROL";
const REQUIRED_RECOVERED = "REQUIRED_RECOVERED";
const variants = ["empty", "no-reply"] as const;
type Variant = (typeof variants)[number];
let instance: OpenClawTestInstance | undefined;
let fixture: Awaited<ReturnType<typeof startFixture>> | undefined;

function createScenario(variant: Variant) {
  return {
    variant,
    parentKey: "agent:main:reply-obligation-" + variant,
    peerKey: "agent:main:reply-obligation-peer-" + variant,
    parentRunId: randomUUID(),
    parentPrompt: "START_PARENT_" + variant,
    parentFinal: "PARENT_FINAL_" + variant,
    peerPrompt: "PEER_WORK_" + variant,
    peerResult: "PEER_RESULT_" + variant,
    peerStarted: createDeferred(),
    releasePeer: createDeferred(),
    callbackTerminal: createDeferred<Record<string, unknown>>(),
    parentRequests: 0,
    peerRequests: 0,
    callbackRequests: 0,
  };
}
type Scenario = ReturnType<typeof createScenario>;

afterEach(async () => {
  fixture?.releaseAll();
  await runQaGatewayFixture(
    async () => {},
    () => instance?.cleanup(),
    () => fixture?.close(),
  );
  instance = undefined;
  fixture = undefined;
});

it(
  "Gateway trusted reply obligations silently settles late peer results without retrying, but recovers a required empty reply",
  { timeout: 180_000 },
  async ({ signal }) => {
    const scenarios = variants.map(createScenario);
    const activeFixture = await startFixture(scenarios);
    fixture = activeFixture;
    const profile = "reply-obligation-" + randomUUID();
    const gateway = await createOpenClawTestInstance({
      name: profile,
      entrypoint: ["scripts/run-node.mjs", "--profile", profile],
      config: createConfig(activeFixture.url),
      env: {
        OPENCLAW_PROFILE: profile,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_AGENT_RUNTIME: undefined,
      },
      signal,
    });
    instance = gateway;
    // Keep the named service identity and logging inside the same disposable state.
    await gateway.state.writeConfig({
      ...createConfig(activeFixture.url),
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
    const errorSessions: unknown[] = [];
    const client = await connectGatewayClient({
      url: gateway.url,
      token: gateway.gatewayToken,
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      deviceIdentity: loadOrCreateDeviceIdentity({
        path: gateway.state.path("reply-obligation-client", "client", "credentials.sqlite"),
      }),
      signal,
      onEvent: (event) => {
        const payload = asOptionalRecord(event.payload);
        const data = asOptionalRecord(payload?.data);
        if (
          (event.event === "chat" && payload?.state === "error") ||
          (event.event === "agent" && data?.phase === "error")
        ) {
          errorSessions.push(payload?.sessionKey);
        }
        if (
          event.event !== "agent" ||
          payload?.stream !== "lifecycle" ||
          (data?.phase !== "end" && data?.phase !== "error")
        ) {
          return;
        }
        const scenario = scenarios.find(
          (candidate) =>
            payload.sessionKey === candidate.parentKey && payload.runId !== candidate.parentRunId,
        );
        scenario?.callbackTerminal.resolve(payload);
      },
    });
    const history = async (sessionKey: string) =>
      (await client.request<{ messages: unknown[] }>("chat.history", { sessionKey, limit: 100 }))
        .messages;
    const requestReply = (
      sessionKey: string,
      message: string,
      idempotencyKey = randomUUID(),
      inputProvenance?: { kind: "inter_session"; sourceTool: "sessions_send" },
    ) =>
      client.request(
        "agent",
        {
          sessionKey,
          message,
          channel: "webchat",
          deliver: false,
          idempotencyKey,
          inputProvenance,
        },
        { expectFinal: true, timeoutMs: 60_000 },
      );
    try {
      await client.request("sessions.subscribe", {});
      for (const scenario of scenarios) {
        for (const key of [scenario.peerKey, scenario.parentKey]) {
          await client.request("sessions.create", { key, agentId: "main" });
        }
        await client.request("sessions.messages.subscribe", {
          key: scenario.parentKey,
          subscriptionId: "reply-obligation-" + scenario.variant,
        });
        const parent = await requestReply(
          scenario.parentKey,
          scenario.parentPrompt,
          scenario.parentRunId,
        );
        expect(parent, gateway.logs()).toMatchObject({ status: "ok" });
        await withinTest(scenario.peerStarted.promise, signal);
        expect(scenario.callbackRequests).toBe(0);
        expect(modelReplyTexts(await history(scenario.parentKey))).toEqual([scenario.parentFinal]);

        // Release only after the original final is committed and publicly readable.
        scenario.releasePeer.resolve();
        const terminal = await withinTest(scenario.callbackTerminal.promise, signal);
        expect(terminal.data, gateway.logs()).toMatchObject({ phase: "end" });
        expect(asOptionalRecord(terminal.data)?.error).toBeUndefined();
        const settled = await client.request(
          "agent.wait",
          { runId: terminal.runId, timeoutMs: 10_000 },
          { timeoutMs: 15_000 },
        );
        expect(settled, gateway.logs()).toMatchObject({ status: "ok" });
        expect(asOptionalRecord(settled)?.error).toBeUndefined();
        const after = await history(scenario.parentKey);
        expect(modelReplyTexts(after)).toEqual([scenario.parentFinal]);
        expectForwardedInput(after, scenario.peerResult, {
          provenance: { sourceSessionKey: scenario.peerKey },
          senderSession: { agentId: "main", sessionKey: scenario.peerKey },
          senderLabel: "Forwarded from main",
        });
        expect(scenario).toMatchObject({
          parentRequests: 2,
          peerRequests: 1,
          callbackRequests: 1,
        });
        expect(errorSessions.filter((key) => key === scenario.parentKey)).toEqual([]);
      }

      const requiredKey = "agent:main:reply-obligation-required";
      // Public provenance is not the trusted owner's optional-reply decision.
      const required = await requestReply(requiredKey, REQUIRED_REQUEST, randomUUID(), {
        kind: "inter_session",
        sourceTool: "sessions_send",
      });
      expect(required, gateway.logs()).toMatchObject({ status: "ok" });
      expect(activeFixture.requiredRequests()).toBe(2);
      const requiredHistory = await history(requiredKey);
      expect(modelReplyTexts(requiredHistory)).toEqual([REQUIRED_RECOVERED]);
      expectForwardedInput(requiredHistory, REQUIRED_REQUEST);
      expect(activeFixture.failures).toEqual([]);
      expect(gateway.logs()).not.toContain("sessions_send reply flow failed");
    } finally {
      activeFixture.releaseAll();
      await disconnectGatewayClient(client);
    }
  },
);

function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  return Array.isArray(content)
    ? content
        .map((part) => asOptionalRecord(part)?.text)
        .filter((text) => typeof text === "string")
        .join("\n")
    : "";
}

function expectForwardedInput(
  messages: unknown[],
  text: string,
  details: Record<string, unknown> = {},
): void {
  const inputs = messages.flatMap((message) => {
    const record = asOptionalRecord(message);
    return record && asOptionalRecord(record.provenance)?.kind === "inter_session" ? [record] : [];
  });
  expect(inputs).toHaveLength(1);
  expect(contentText(inputs[0]?.content).trim()).toBe(text);
  expect(inputs[0]).toMatchObject({
    role: "assistant",
    provenance: { kind: "inter_session", sourceTool: "sessions_send" },
  });
  expect(inputs[0]).toMatchObject(details);
}

function modelReplyTexts(messages: unknown[]): string[] {
  return messages.flatMap((message) => {
    const record = asOptionalRecord(message);
    const text = contentText(record?.content).trim();
    // History presents forwarded peer input as an attributed assistant message.
    return record?.role === "assistant" &&
      asOptionalRecord(record.provenance)?.kind !== "inter_session" &&
      text
      ? [text]
      : [];
  });
}

function createConfig(url: string): OpenClawConfig {
  const config = createOpenAiResponsesModelConfig({
    baseUrl: url,
    providerId: "reply-obligation",
    modelId: "reply-obligation",
    reasoning: false,
    toolProfile: "coding",
  });
  config.plugins = { enabled: false };
  config.discovery = { mdns: { mode: "off" } };
  config.agents = {
    defaults: { ...config.agents?.defaults, sandbox: { mode: "off" } },
  };
  config.tools = {
    profile: "coding",
    codeMode: false,
    toolSearch: false,
    allow: ["sessions_send"],
    sessions: { visibility: "all" },
    agentToAgent: { enabled: true },
  };
  return config;
}

async function startFixture(scenarios: Scenario[]) {
  const failures: string[] = [];
  let sequence = 0;
  let requiredRequests = 0;
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
  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    const body = asOptionalRecord(await json(request));
    const input = Array.isArray(body?.input) ? body.input.map(asOptionalRecord) : [];
    const userTexts = input
      .filter((item) => item?.role === "user")
      .map((item) => contentText(item?.content))
      .filter((text) => !isInternalRuntimeContextCarrierText(text));
    const userText = userTexts.at(-1) ?? "";
    const id = String(++sequence);
    const final = (text: string) =>
      writeOpenAiResponsesText(response, {
        text,
        messageId: "msg_" + id,
        responseId: "resp_" + id,
      });
    // Search retained user turns too: an erroneous finalizer must count as a retry,
    // not become an unrelated fixture error merely because it appended a prompt.
    if (userTexts.some((text) => text.includes(REQUIRED_REQUEST))) {
      if (++requiredRequests > 2) {
        throw new Error("Required reply exceeded one empty response and one recovery");
      }
      return final(requiredRequests === 1 ? "" : REQUIRED_RECOVERED);
    }
    const scenario = scenarios.find((candidate) =>
      userTexts.some((text) => text.includes(candidate.peerResult)),
    );
    if (scenario) {
      scenario.callbackRequests += 1;
      return final(scenario.variant === "empty" ? "" : "NO_REPLY");
    }
    const peer = scenarios.find((candidate) => userText.includes(candidate.peerPrompt));
    if (peer) {
      if (++peer.peerRequests !== 1) {
        throw new Error("Peer work was repeated");
      }
      peer.peerStarted.resolve();
      await peer.releasePeer.promise;
      return final(peer.peerResult);
    }
    const parent = scenarios.find((candidate) => userText.includes(candidate.parentPrompt));
    if (!parent || ++parent.parentRequests > 2) {
      throw new Error("Unexpected provider turn outside the finite reply-obligation scenario");
    }
    if (parent.parentRequests === 2) {
      const output = input.findLast((item) => item?.type === "function_call_output");
      const serialized = JSON.stringify(output?.output);
      if (!serialized?.includes("accepted") || !serialized.includes("pending")) {
        throw new Error("Real sessions_send did not accept delayed peer delivery");
      }
      return final(parent.parentFinal);
    }
    const item = {
      type: "function_call",
      id: "fc_" + id,
      call_id: "call_" + id,
      name: "sessions_send",
      arguments: JSON.stringify({
        sessionKey: parent.peerKey,
        message: parent.peerPrompt,
        timeoutSeconds: 0,
      }),
      status: "completed",
    };
    const event = (type: string, fields: Record<string, unknown>) => ({
      type: `response.${type}`,
      output_index: 0,
      ...fields,
    });
    writeOpenAiResponsesSse(response, [
      event("output_item.added", {
        item: { ...item, status: "in_progress", arguments: "" },
      }),
      event("function_call_arguments.done", {
        item_id: item.id,
        arguments: item.arguments,
      }),
      event("output_item.done", { item }),
      {
        type: "response.completed",
        response: {
          id: "resp_" + id,
          status: "completed",
          output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ]);
  }
  return {
    url: "http://127.0.0.1:" + reserved.claim.port,
    failures,
    requiredRequests: () => requiredRequests,
    releaseAll: () => {
      for (const scenario of scenarios) {
        scenario.releasePeer.resolve();
      }
    },
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
