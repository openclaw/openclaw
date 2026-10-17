import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { getRuntimeConfig, writeConfigFile } from "../config/io.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayRequestContext, GatewayRequestHandler } from "./server-methods/types.js";
import {
  connectOk,
  installGatewayTestHooks,
  startServerWithClient,
  rpcReq,
  testState,
  gatewayReplyMock,
} from "./test-helpers.js";
const fixture = vi.hoisted(() => {
  const value: { context?: GatewayRequestContext } = {};
  return value;
});
vi.mock("./server-methods/cron.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-methods/cron.js")>();
  const status = actual.cronHandlers["cron.status"];
  if (!status) {
    throw new Error("canonical cron.status handler unavailable");
  }
  const observe: GatewayRequestHandler = async (options) => {
    fixture.context = options.context;
    return await status(options);
  };
  return { ...actual, cronHandlers: { ...actual.cronHandlers, "cron.status": observe } };
});
installGatewayTestHooks({ scope: "suite" });
let modelServer: Server;
let gateway: Awaited<ReturnType<typeof startServerWithClient>>;
let ws: WebSocket;
let modelRequests = 0;
let storePath: string;
let fixtureConfig: OpenClawConfig;
let modelBaseUrl: string;
const marker = "OWNED_MANUAL_HEARTBEAT_TRANSCRIPT";

beforeAll(async () => {
  await vi.importActual<typeof import("../auto-reply/reply/get-reply.js")>(
    "../auto-reply/reply/get-reply.js",
  );
  const root = expectDefined(process.env.OPENCLAW_STATE_DIR, "Gateway fixture state");
  const workspace = path.join(root, "heartbeat-workspace");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(workspace, "HEARTBEAT.md"),
    `- Check ${marker} and respond HEARTBEAT_OK.\n`,
  );
  modelServer = createServer((req, res) => {
    if (req.method !== "POST") {
      res.setHeader("content-type", "application/json");
      res.end('{"object":"list","data":[]}');
      return;
    }
    modelRequests++;
    req.resume();
    res.setHeader("content-type", "text/event-stream");
    res.end(
      `data: ${JSON.stringify({ id: "owned-heartbeat", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", content: marker }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "owned-heartbeat", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve, reject) => {
    modelServer.once("error", reject);
    modelServer.listen(0, "127.0.0.1", resolve);
  });
  const address = modelServer.address();
  if (!address || typeof address === "string") {
    throw new Error("owned model fixture lacks a port");
  }
  storePath = path.join(root, "heartbeat-sessions.json");
  modelBaseUrl = `http://127.0.0.1:${address.port}/v1`;
  fixtureConfig = {
    plugins: { enabled: false },
    agents: {
      defaults: {
        workspace,
        skipBootstrap: true,
        model: { primary: "owned-fixture/fixture-model" },
        models: { "owned-fixture/fixture-model": { agentRuntime: { id: "openclaw" } } },
        heartbeat: { every: "1h", target: "none" },
      },
    },
    models: {
      providers: {
        "owned-fixture": {
          api: "openai-completions",
          baseUrl: modelBaseUrl,
          apiKey: "synthetic-heartbeat-key",
          models: [
            {
              id: "fixture-model",
              name: "Owned fixture",
              reasoning: false,
              input: ["text"],
              contextWindow: 128000,
              maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
  };
});

afterAll(async () => {
  await runQaGatewayFixture(
    async () => {},
    async () => {
      if (ws) {
        await closeGatewayTestWebSocket(ws);
      }
    },
    async () => {
      if (gateway) {
        await gateway.server.close({ reason: "owned heartbeat test finished" });
      }
    },
    async () => {
      if (modelServer) {
        modelServer.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          modelServer.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
    () => vi.unstubAllEnvs(),
  );
});

beforeEach(async () => {
  testState.sessionStorePath = storePath;
  testState.cronStorePath = path.join(
    expectDefined(process.env.OPENCLAW_STATE_DIR, "fixture state"),
    "heartbeat-cron",
    "jobs.json",
  );
  testState.cronEnabled = true;
  testState.agentConfig = {
    ...expectDefined(fixtureConfig.agents?.defaults, "fixture agent defaults"),
  };
  const workspace = expectDefined(fixtureConfig.agents?.defaults?.workspace, "fixture workspace");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "HEARTBEAT.md"), `- Check ${marker}.\n`);

  vi.stubEnv("OPENCLAW_SKIP_CRON", "0");
  vi.stubEnv("OPENCLAW_TEST_FAST", "0");
  await writeConfigFile(fixtureConfig);
  const cfg = getRuntimeConfig();
  expect(cfg.agents?.defaults?.model).toEqual({ primary: "owned-fixture/fixture-model" });
  expect(cfg.models?.providers?.["owned-fixture"]?.baseUrl).toBe(modelBaseUrl);
  vi.stubEnv("OPENCLAW_TEST_MINIMAL_GATEWAY", "0");
  const actualReply = await vi.importActual<typeof import("../auto-reply/reply/get-reply.js")>(
    "../auto-reply/reply/get-reply.js",
  );
  gatewayReplyMock.mockImplementation(actualReply.getReplyFromConfig);
  if (!gateway) {
    gateway = await startServerWithClient();
    ws = gateway.ws;
    await connectOk(ws);
  }
  const status = await rpcReq(ws, "cron.status", {});
  expect(status.ok, JSON.stringify(status.error)).toBe(true);
  const context = expectDefined(fixture.context, "owned Gateway cron context");
  expect(context.cronStorePath).toBe(testState.cronStorePath);
  expect(context.getRuntimeConfig().models?.providers?.["owned-fixture"]?.baseUrl).toBe(
    modelBaseUrl,
  );
  await context.cron.start();
});

test("manual heartbeat records the initialized session for the public run transcript", async () => {
  const listed = await rpcReq<{
    jobs: Array<{ id: string; payload: { kind: string }; agentId?: string }>;
  }>(ws, "cron.list", { includeDisabled: true });
  expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
  const monitor = expectDefined(
    listed.payload?.jobs.find((job) => job.payload.kind === "heartbeat" && job.agentId === "main"),
    "configured built-in heartbeat monitor",
  );
  const id = monitor.id;
  const run = await rpcReq<{ runId: string }>(
    ws,
    "cron.run",
    { id, mode: "force", waitTimeoutMs: 30_000 },
    35_000,
  );
  expect(run.ok, JSON.stringify(run.error)).toBe(true);
  const runId = expectDefined(run.payload?.runId, "actual manual run id");
  const runs = await rpcReq<{
    entries: Array<{ runId?: string; status?: string; sessionKey?: string; sessionId?: string }>;
  }>(ws, "cron.runs", { id, limit: 20 });
  expect(runs.ok, JSON.stringify(runs.error)).toBe(true);
  const record = expectDefined(
    runs.payload?.entries.find((entry) => entry.runId === runId),
    "persisted completed run",
  );
  expect(record.status).toBe("ok");
  expect(modelRequests).toBeGreaterThan(0);
  const sessionKey = "agent:main:main";
  const entry = expectDefined(
    loadSessionEntry({ agentId: "main", sessionKey, storePath }),
    "actual initialized heartbeat session",
  );
  const sessionHistory = await rpcReq<{ messages: unknown[] }>(ws, "chat.history", {
    sessionKey,
    limit: 20,
  });
  expect(sessionHistory.ok, JSON.stringify(sessionHistory.error)).toBe(true);
  expect(JSON.stringify(sessionHistory.payload?.messages)).toContain(marker);
  const history = await rpcReq<{ messages: unknown[] }>(ws, "cron.history", { id, runId });
  expect(history.ok, JSON.stringify(history.error)).toBe(true);
  expect(record).toMatchObject({ sessionKey, sessionId: entry.sessionId });
  expect(history.payload?.messages).toEqual(sessionHistory.payload?.messages);
});
