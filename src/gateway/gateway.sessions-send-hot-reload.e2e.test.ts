import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, onTestFailed } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { readSessionStoreSummaryReadOnly } from "../config/sessions/session-accessor.sqlite-summary.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getActiveGatewayRootWorkHolders } from "../process/gateway-work-admission.js";
import { deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { writeToolCall } from "./gateway-provider-fixture.test-support.js";
import {
  createGatewayConfigPath,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { createTrackedProvider } from "./test-helpers.tracked-provider.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const MODEL_A = "reload-proof/model-a";
const MODEL_B = "reload-proof/model-b";
const SENDER_SESSION = "agent:sender:main";
const INITIAL_PROMPT = "Start the reload proof.";
const TARGET_MESSAGE = "Hold this target turn across the runtime reload.";
const TARGET_REPLY = "TARGET_REPLY_AFTER_RELOAD";
const DISPATCH_COMPLETE = "SENDER_DISPATCH_COMPLETE";

type ModelCall = {
  kind: "dispatch" | "dispatch-complete" | "target" | "reply";
  model: string;
  raw: string;
};

type AgentResult = {
  runId?: string;
  status?: string;
  terminalReply?: { disposition?: string; text?: string };
};

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
  if (errors.length > 0) {
    throw new AggregateError(errors, "sessions_send reload proof cleanup failed");
  }
  resetGatewayTestState();
});

function textResponse(response: ServerResponse, text: string): void {
  writeOpenAiResponsesText(response, {
    text,
    messageId: `msg_${randomUUID()}`,
    responseId: `resp_${randomUUID()}`,
  });
}

function readTargetToolResult(raw: string): Record<string, unknown> | undefined {
  const body = JSON.parse(raw) as {
    input?: Array<{ type?: string; output?: string | Record<string, unknown> }>;
  };
  const output = body.input?.find((item) => item.type === "function_call_output")?.output;
  const parsed =
    typeof output === "string" ? (JSON.parse(output) as Record<string, unknown>) : output;
  return parsed && typeof parsed === "object" ? parsed : undefined;
}

async function startProvider() {
  const targetStarted = createDeferred();
  const releaseTarget = createDeferred();
  const calls: ModelCall[] = [];
  let targetRunId: string | undefined;
  const server = createTrackedProvider(async (raw, response, request) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: ["model-a", "model-b"].map((id) => ({ id, object: "model" })),
        }),
      );
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.parse(raw) as {
      model?: unknown;
      tools?: Array<{ type?: string; name?: string }>;
    };
    const rawModel = body.model;
    const modelId = typeof rawModel === "string" ? rawModel : "";
    if (raw.includes(TARGET_REPLY)) {
      calls.push({ kind: "reply", model: modelId, raw });
      textResponse(response, "Requester received the target result.");
    } else if (raw.includes(INITIAL_PROMPT) && raw.includes("function_call_output")) {
      calls.push({ kind: "dispatch-complete", model: modelId, raw });
      const result = readTargetToolResult(raw);
      targetRunId = typeof result?.runId === "string" ? result.runId : undefined;
      textResponse(response, DISPATCH_COMPLETE);
    } else if (raw.includes(TARGET_MESSAGE)) {
      calls.push({ kind: "target", model: modelId, raw });
      targetStarted.resolve();
      await releaseTarget.promise;
      textResponse(response, TARGET_REPLY);
    } else if (raw.includes(INITIAL_PROMPT)) {
      calls.push({ kind: "dispatch", model: modelId, raw });
      expect(body.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "function", name: "sessions_send" }),
        ]),
      );
      writeToolCall(response, "sessions_send", {
        agentId: "target",
        message: TARGET_MESSAGE,
        timeoutSeconds: 0,
      });
    } else {
      throw new Error(`unexpected model request for ${modelId || "<missing model>"}`);
    }
  });
  const baseUrl = await server.listen();
  return {
    baseUrl,
    calls,
    releaseTarget: () => releaseTarget.resolve(),
    targetRunId: () => targetRunId,
    targetStarted: targetStarted.promise,
    close: async () => {
      releaseTarget.resolve();
      await server.close();
    },
  };
}

describe("sessions_send across prepared runtime reload", () => {
  it(
    "finishes model-A work and re-admits one detached requester reply on model B",
    { timeout: 90_000 },
    async () => {
      const provider = await startProvider();
      cleanups.push(provider.close);
      let phase = "starting Gateway";
      onTestFailed(() => {
        process.stderr.write(
          `sessions_send reload failure: ${JSON.stringify({
            phase,
            calls: provider.calls.map(({ kind, model }) => ({ kind, model })),
          })}\n`,
        );
      });
      resetGatewayTestState();
      const {
        tempHome: home,
        workspaceDir: workspace,
        envSnapshot,
      } = await setupGatewayTempHome({
        prefix: "openclaw-sessions-reload-",
      });
      cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
      cleanups.push(async () => envSnapshot.restore());
      const configPath = await createGatewayConfigPath(home);
      const token = `reload-proof-${randomUUID()}`;
      setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
      deleteTestEnvValue("OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN");
      deleteTestEnvValue("OPENCLAW_TEST_RUNTIME_OVERRIDE_TOKEN");
      const providerConfig = {
        baseUrl: provider.baseUrl,
        apiKey: "test-token-placeholder",
        api: "openai-responses" as const,
        request: { allowPrivateNetwork: true },
        models: ["model-a", "model-b"].map(
          (id) => buildMockOpenAiResponsesProvider(provider.baseUrl, id).config.models[0],
        ),
      };
      const cfg = {
        agents: {
          ownership: "explicit",
          defaults: {
            workspace,
            skipBootstrap: true,
            skills: [],
            model: { primary: MODEL_A },
            models: { [MODEL_A]: {}, [MODEL_B]: {} },
          },
          entries: { sender: {}, target: {} },
        },
        gateway: { auth: { mode: "token", token } },
        hooks: { enabled: false },
        models: { mode: "replace", providers: { "reload-proof": providerConfig } },
        plugins: { slots: { memory: "none" } },
        tools: {
          profile: "full",
          // This synthetic provider exercises reload, not Tool Search or Code Mode.
          codeMode: false,
          toolSearch: false,
          sessions: { visibility: "all" },
          agentToAgent: { enabled: true, allow: ["*"] },
        },
      } satisfies OpenClawConfig;
      const gateway = await startGatewayWithClient({
        cfg,
        configPath,
        token,
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });
      cleanups.push(async () => {
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close({ reason: "sessions_send reload proof complete" });
      });

      const senderRunId = randomUUID();
      phase = "starting sender";
      await expect(
        withTestTimeout(
          gateway.client.request<AgentResult>(
            "agent",
            {
              sessionKey: SENDER_SESSION,
              message: INITIAL_PROMPT,
              deliver: false,
              idempotencyKey: senderRunId,
            },
            { expectFinal: false },
          ),
          15_000,
          "sender admission timed out",
        ),
      ).resolves.toMatchObject({ runId: senderRunId, status: "accepted" });
      phase = "waiting for target admission";
      await withTestTimeout(provider.targetStarted, 15_000, "target admission timed out").catch(
        (error: unknown) => {
          throw new Error("target admission failed", { cause: error });
        },
      );
      phase = "waiting for sender completion";
      await expect(
        gateway.client.request<AgentResult>("agent.wait", {
          runId: senderRunId,
          timeoutMs: 20_000,
        }),
      ).resolves.toMatchObject({
        runId: senderRunId,
        status: "ok",
      });
      const targetRunId = provider.targetRunId();
      expect(targetRunId).toBeTypeOf("string");

      const before = await withTestTimeout(
        gateway.client.request<{ hash: string }>("config.get", {}),
        10_000,
        "config.get timed out",
      );
      phase = "patching model B";
      await expect(
        withTestTimeout(
          gateway.client.request("config.patch", {
            baseHash: before.hash,
            raw: JSON.stringify({ agents: { defaults: { model: { primary: MODEL_B } } } }),
          }),
          20_000,
          "model-B config.patch timed out",
        ),
      ).resolves.toMatchObject({ hash: expect.any(String) });
      phase = "releasing target";
      provider.releaseTarget();
      phase = "waiting for target completion";
      const targetWait = await gateway.client.request<AgentResult>("agent.wait", {
        runId: targetRunId,
        timeoutMs: 20_000,
      });
      expect(targetWait).toMatchObject({
        runId: targetRunId,
        status: "ok",
        terminalReply: { disposition: "visible", text: TARGET_REPLY },
      });

      phase = "waiting for detached reply";
      await expect
        .poll(() => provider.calls.filter((call) => call.kind === "reply").length, {
          timeout: 20_000,
          interval: 50,
        })
        .toBe(1);
      await expect
        .poll(
          () =>
            getActiveGatewayRootWorkHolders().filter((origin) => origin === "session:a2a-send")
              .length,
          { timeout: 20_000, interval: 50 },
        )
        .toBe(0);

      const target = readSessionStoreSummaryReadOnly(
        { agentId: "target", env: process.env },
        { recentLimit: 10, agentIds: ["target"] },
      ).recent.find(({ sessionKey }) => sessionKey === "agent:target:main");
      expect(target?.entry.status).toBe("done");
      expect(target?.entry.lastRunError).toBeUndefined();
      expect(provider.calls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "dispatch", model: "model-a" }),
          expect.objectContaining({ kind: "target", model: "model-a" }),
          expect.objectContaining({ kind: "dispatch-complete", model: "model-a" }),
          expect.objectContaining({ kind: "reply", model: "model-b" }),
        ]),
      );
      const dispatchComplete = provider.calls.find((call) => call.kind === "dispatch-complete");
      expect(dispatchComplete).toBeDefined();
      expect(readTargetToolResult(dispatchComplete?.raw ?? "")).toMatchObject({
        targetDisposition: "queued",
      });
      expect(provider.calls.filter((call) => call.kind === "reply")).toHaveLength(1);
      expect(provider.calls.filter((call) => call.kind === "target")).toHaveLength(1);
      expect(provider.calls).toHaveLength(4);
    },
  );
});
