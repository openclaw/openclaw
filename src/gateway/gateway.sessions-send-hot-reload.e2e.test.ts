import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFailed } from "vitest";
import { writeOpenAiResponsesSse } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { resetConfigOverrides } from "../config/runtime-overrides.js";
import { readSessionStoreSummaryReadOnly } from "../config/sessions/session-accessor.sqlite-summary.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { getActiveGatewayRootWorkHolders } from "../process/gateway-work-admission.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

const MODEL_A = "reload-proof/model-a";
const MODEL_B = "reload-proof/model-b";
const SENDER_SESSION = "agent:sender:main";
const INITIAL_PROMPT = "Start the reload proof.";
const TARGET_MESSAGE = "Hold this target turn across the runtime reload.";
const TARGET_REPLY = "TARGET_REPLY_AFTER_RELOAD";
const DISPATCH_COMPLETE = "SENDER_DISPATCH_COMPLETE";

type ModelCall = {
  kind: "dispatch" | "dispatch-complete" | "target" | "reply" | "announce";
  model: string;
  raw: string;
};

type AgentResult = {
  runId?: string;
  status?: string;
  terminalReply?: { disposition?: string; text?: string };
};

const cleanups: Array<() => Promise<void>> = [];

function resetGatewayState(): void {
  resetConfigOverrides();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest({ preserveListeners: true });
}

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
  resetGatewayState();
});

function textResponse(response: ServerResponse, text: string): void {
  const id = randomUUID();
  const item = {
    type: "message",
    id: `msg_${id}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  writeOpenAiResponsesSse(response, [
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${id}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      },
    },
  ]);
}

function toolResponse(response: ServerResponse): void {
  const id = randomUUID();
  const args = JSON.stringify({
    agentId: "target",
    message: TARGET_MESSAGE,
    timeoutSeconds: 0,
  });
  const item = {
    type: "function_call",
    id: `fc_${id}`,
    call_id: `call_${id}`,
    name: "sessions_send",
    arguments: args,
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
      arguments: args,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${id}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      },
    },
  ]);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
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
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            data: [
              { id: "model-a", object: "model" },
              { id: "model-b", object: "model" },
            ],
          }),
        );
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const raw = await readBody(request);
      const rawModel = (JSON.parse(raw) as { model?: unknown }).model;
      const modelId = typeof rawModel === "string" ? rawModel : "";
      if (raw.includes("Agent-to-agent announce step:")) {
        calls.push({ kind: "announce", model: modelId, raw });
        textResponse(response, "ANNOUNCE_SKIP");
      } else if (raw.includes(TARGET_REPLY) && raw.includes("Agent-to-agent reply step:")) {
        calls.push({ kind: "reply", model: modelId, raw });
        textResponse(response, "REPLY_SKIP");
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
        toolResponse(response);
      } else {
        throw new Error(`unexpected model request: ${raw.slice(0, 500)}`);
      }
    })().catch((error: unknown) => {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("reload proof provider did not bind a loopback port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    calls,
    releaseTarget: () => releaseTarget.resolve(),
    targetRunId: () => targetRunId,
    targetStarted: targetStarted.promise,
    close: async () => {
      releaseTarget.resolve();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function modelDefinition(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    api: "openai-responses" as const,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  };
}

describe("sessions_send across prepared runtime reload", () => {
  it(
    "finishes model-A work and re-admits the detached reply and announcement on model B",
    { timeout: 90_000 },
    async () => {
      const provider = await startProvider();
      cleanups.push(provider.close);
      let phase = "starting Gateway";
      onTestFailed(() => console.info({ phase, calls: provider.calls }));
      resetGatewayState();
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-reload-"));
      cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
      const stateDir = path.join(home, ".openclaw");
      const workspace = path.join(home, "workspace");
      const bundledPluginsDir = path.join(home, "empty-bundled-plugins");
      const env = captureEnv([
        "HOME",
        "OPENCLAW_STATE_DIR",
        "OPENCLAW_CONFIG_PATH",
        "OPENCLAW_GATEWAY_TOKEN",
        "OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN",
        "OPENCLAW_TEST_RUNTIME_OVERRIDE_TOKEN",
        "OPENCLAW_TEST_MINIMAL_GATEWAY",
        "OPENCLAW_SKIP_CHANNELS",
        "OPENCLAW_SKIP_CRON",
        "OPENCLAW_SKIP_GMAIL_WATCHER",
        "OPENCLAW_SKIP_CANVAS_HOST",
        "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
        "OPENCLAW_SKIP_PROVIDERS",
        "OPENCLAW_BUNDLED_PLUGINS_DIR",
        "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
      ]);
      cleanups.push(async () => env.restore());
      const token = `reload-proof-${randomUUID()}`;
      for (const [key, value] of Object.entries({
        HOME: home,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_GATEWAY_TOKEN: token,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      })) {
        setTestEnvValue(key, value);
      }
      deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
      deleteTestEnvValue("OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN");
      deleteTestEnvValue("OPENCLAW_TEST_RUNTIME_OVERRIDE_TOKEN");
      deleteTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY");
      await Promise.all([
        fs.mkdir(stateDir, { recursive: true }),
        fs.mkdir(workspace, { recursive: true }),
        fs.mkdir(bundledPluginsDir, { recursive: true }),
      ]);
      const providerConfig = {
        baseUrl: provider.baseUrl,
        apiKey: "test-token-placeholder",
        api: "openai-responses" as const,
        request: { allowPrivateNetwork: true },
        models: [modelDefinition("model-a"), modelDefinition("model-b")],
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
          sessions: { visibility: "all" },
          agentToAgent: { enabled: true, allow: ["*"] },
        },
      } satisfies OpenClawConfig;
      const gateway = await startGatewayWithClient({
        cfg,
        configPath: path.join(stateDir, "openclaw.json"),
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
          throw new Error(`target admission failed: ${JSON.stringify(provider.calls)}`, {
            cause: error,
          });
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
      expect(target?.entry.status, target?.entry.lastRunError).toBe("done");
      expect(target?.entry.lastRunError).toBeUndefined();
      expect(provider.calls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "dispatch", model: "model-a" }),
          expect.objectContaining({ kind: "target", model: "model-a" }),
          expect.objectContaining({ kind: "dispatch-complete", model: "model-a" }),
          expect.objectContaining({ kind: "reply", model: "model-b" }),
          expect.objectContaining({ kind: "announce", model: "model-b" }),
        ]),
      );
      const dispatchComplete = provider.calls.find((call) => call.kind === "dispatch-complete");
      expect(dispatchComplete).toBeDefined();
      expect(readTargetToolResult(dispatchComplete?.raw ?? "")).toMatchObject({
        targetDisposition: "queued",
      });
      expect(provider.calls.filter((call) => call.kind === "reply")).toHaveLength(1);
      expect(provider.calls.filter((call) => call.kind === "target")).toHaveLength(1);
      expect(provider.calls.filter((call) => call.kind === "announce")).toHaveLength(1);
    },
  );
});
