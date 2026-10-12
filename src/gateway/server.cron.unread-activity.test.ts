// One Gateway proves cron reports, read acknowledgements, and silent/background siblings.
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { json } from "node:stream/consumers";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { getRuntimeConfig, writeConfigFile } from "../config/io.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { acquireTestPortBlock, type TestPortClaim } from "../test-utils/port-claims.js";
import type { GatewayRequestContext, GatewayRequestHandler } from "./server-methods/types.js";
import type { SessionsListResult } from "./session-utils.types.js";
import {
  connectOk,
  cronIsolatedRun,
  gatewayReplyMock,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
  rpcReq,
  startServerWithClient,
  testState,
} from "./test-helpers.js";

const observed = vi.hoisted(() => {
  const value: { context?: GatewayRequestContext } = {};
  return value;
});
vi.mock("./server-methods/cron.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-methods/cron.js")>();
  const original = expectDefined(actual.cronHandlers["cron.status"], "canonical cron status");
  const status: GatewayRequestHandler = async (options) => {
    observed.context = options.context;
    return await original(options);
  };
  return { ...actual, cronHandlers: { ...actual.cronHandlers, "cron.status": status } };
});

installGatewayTestHooks({ scope: "suite" });
let modelServer: Server | undefined;
let modelPort: TestPortClaim | undefined;
let gateway: Awaited<ReturnType<typeof startServerWithClient>> | undefined;
let ws: WebSocket;
let fixtureConfig: OpenClawConfig;
let storePath: string;
let modelBaseUrl: string;
let responseText = "";
const modelResponses: string[] = [];
const modelErrors: unknown[] = [];
const sessionKey = "agent:main:dashboard:cron-unread-report";
const visibleReport = "OWNED_CRON_REPORT: the scheduled check found three items.";
const failureReport =
  "AUTOMATION_FAILED\nOWNED_FAILURE_REPORT: the scheduled check could not finish.";

beforeAll(async () => {
  // Gateway helpers normally replace cron execution and its active-run registry.
  // The execution, registry, and persistence paths retain their real owners; provider bytes are synthetic.
  for (const module of [
    "../cron/isolated-agent.js",
    "/src/cron/isolated-agent.js",
    "../agents/embedded-agent.js",
    "/src/agents/embedded-agent.js",
    "../agents/embedded-agent-runner/runs.js",
    "/src/agents/embedded-agent-runner/runs.js",
    "../agents/embedded-agent-runner/active-run-projections.js",
    "/src/agents/embedded-agent-runner/active-run-projections.js",
    "../plugins/loader.js",
    "/src/plugins/loader.js",
    "../agents/agent-model-discovery.js",
    "/src/agents/agent-model-discovery.js",
  ]) {
    vi.doUnmock(module);
  }
  await vi.importActual<typeof import("../cron/isolated-agent.js")>("../cron/isolated-agent.js");
  const root = expectDefined(process.env.OPENCLAW_STATE_DIR, "owned Gateway state");
  storePath = path.join(root, "cron-unread-sessions.json");
  modelPort = await acquireTestPortBlock({ offsets: [0] });
  modelServer = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST") {
        response.setHeader("content-type", "application/json");
        response.end('{"object":"list","data":[]}');
        return;
      }
      const body: unknown = await json(request);
      if (
        !body ||
        typeof body !== "object" ||
        !("model" in body) ||
        body.model !== "fixture-model"
      ) {
        throw new Error("Owned provider received an unexpected model request");
      }
      const text = responseText;
      modelResponses.push(text);
      const common = {
        id: `owned-cron-${modelResponses.length}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture-model",
      };
      response.setHeader("content-type", "text/event-stream");
      response.write(
        `data: ${JSON.stringify({
          ...common,
          choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          ...common,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: text ? 1 : 0, total_tokens: text ? 2 : 1 },
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    })().catch((error: unknown) => {
      modelErrors.push(error);
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    });
  });
  const server = modelServer;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(expectDefined(modelPort, "owned provider port").port, "127.0.0.1", resolve);
  });
  modelBaseUrl = `http://127.0.0.1:${modelPort.port}/v1`;
  fixtureConfig = {
    cron: { enabled: false },
    plugins: { enabled: false, slots: { memory: "none" } },
    skills: { load: { watch: false } },
    tools: { profile: "minimal" },
    agents: {
      entries: { main: { agentDir: path.join(root, "agents", "main", "agent") } },
      defaults: {
        workspace: path.join(root, "cron-unread-workspace"),
        skipBootstrap: true,
        model: { primary: "owned-fixture/fixture-model", fallbacks: [] },
        models: { "owned-fixture/fixture-model": { agentRuntime: { id: "openclaw" } } },
        heartbeat: { every: "0m", target: "none" },
      },
    },
    models: {
      providers: {
        "owned-fixture": {
          api: "openai-completions",
          baseUrl: modelBaseUrl,
          apiKey: "synthetic-cron-unread-key",
          models: [
            {
              id: "fixture-model",
              name: "Owned cron fixture",
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
      if (gateway) {
        await gateway.server.close({ reason: "owned cron unread proof complete" });
      }
    },
    async () => {
      if (ws) {
        await closeGatewayTestWebSocket(ws);
      }
    },
    async () => {
      const server = modelServer;
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
    async () => {
      if (modelPort && !modelServer?.listening) {
        await modelPort.release();
      }
    },
    () => vi.unstubAllEnvs(),
  );
});

beforeEach(async () => {
  testState.sessionStorePath = storePath;
  testState.cronStorePath = path.join(
    expectDefined(process.env.OPENCLAW_STATE_DIR, "owned state"),
    "cron-unread",
    "jobs.json",
  );
  testState.cronEnabled = false;
  testState.agentConfig = { ...expectDefined(fixtureConfig.agents?.defaults, "owned defaults") };
  const workspace = expectDefined(fixtureConfig.agents?.defaults?.workspace, "owned workspace");
  const agentDir = expectDefined(fixtureConfig.agents?.entries?.main?.agentDir, "owned agent dir");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } } }),
  );
  vi.stubEnv("OPENCLAW_SKIP_CRON", "0");
  vi.stubEnv("OPENCLAW_TEST_FAST", "0");
  await writeConfigFile(fixtureConfig);
  const cfg = getRuntimeConfig();
  expect(cfg.agents?.defaults?.model).toEqual({
    primary: "owned-fixture/fixture-model",
    fallbacks: [],
  });
  expect(cfg.models?.providers?.["owned-fixture"]?.baseUrl).toBe(modelBaseUrl);
  const actualReply = await vi.importActual<typeof import("../auto-reply/reply/get-reply.js")>(
    "../auto-reply/reply/get-reply.js",
  );
  gatewayReplyMock.mockImplementation(actualReply.getReplyFromConfig);
  const actualCron = await vi.importActual<typeof import("../cron/isolated-agent.js")>(
    "../cron/isolated-agent.js",
  );
  // A helper loaded during home setup can retain its facade; forward its exact input to the real run.
  cronIsolatedRun.mockImplementation(actualCron.runCronIsolatedAgentTurn);
  if (!gateway) {
    gateway = await startServerWithClient();
    ws = gateway.ws;
    await connectOk(ws);
  }
  const status = await rpcReq<{ enabled: boolean }>(ws, "cron.status", {});
  expect(status.ok, JSON.stringify(status.error)).toBe(true);
  expect(status.payload?.enabled).toBe(false);
  const context = expectDefined(observed.context, "actual owned Gateway context");
  expect(context.cronStorePath).toBe(testState.cronStorePath);
  expect(context.getRuntimeConfig().models?.providers?.["owned-fixture"]?.baseUrl).toBe(
    modelBaseUrl,
  );
  await context.cron.start();
  await prepareGatewayReplyRuntimeForTest({ force: true });
});

async function readRow() {
  const listed = await rpcReq<SessionsListResult>(ws, "sessions.list", {
    agentId: "main",
    includeGlobal: true,
    limit: 100,
  });
  expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
  return expectDefined(
    listed.payload?.sessions.find((row) => row.key === sessionKey),
    "public persistent session row",
  );
}

async function acknowledge() {
  const acknowledged = await rpcReq(ws, "sessions.patch", { key: sessionKey, unread: false });
  expect(acknowledged.ok, JSON.stringify(acknowledged.error)).toBe(true);
  expect((await readRow()).unread).toBe(false);
  return expectDefined(
    loadSessionEntry({ agentId: "main", sessionKey, storePath }),
    "acknowledged canonical row",
  );
}

async function runJob(jobId: string, text: string, target = `session:${sessionKey}`) {
  responseText = text;
  const updated = await rpcReq(ws, "cron.update", {
    id: jobId,
    patch: {
      sessionTarget: target,
      payload: { kind: "agentTurn", message: "Produce the owned scheduled report." },
    },
  });
  expect(updated.ok, JSON.stringify(updated.error)).toBe(true);
  const previousRequests = modelResponses.length;
  const started = await rpcReq<{ runId: string }>(
    ws,
    "cron.run",
    { id: jobId, mode: "force", waitTimeoutMs: 30_000 },
    35_000,
  );
  expect(started.ok, JSON.stringify(started.error)).toBe(true);
  const runId = expectDefined(started.payload?.runId, "actual manual run id");
  const runs = await rpcReq<{
    entries: Array<{ runId?: string; status?: string; sessionId?: string; sessionKey?: string }>;
  }>(ws, "cron.runs", { id: jobId, runId, limit: 1 });
  expect(runs.ok, JSON.stringify(runs.error)).toBe(true);
  const record = expectDefined(
    runs.payload?.entries.find((entry) => entry.runId === runId),
    "persisted completed cron run",
  );
  expect(modelResponses.length, JSON.stringify({ record, modelErrors })).toBeGreaterThan(
    previousRequests,
  );
  expect(modelErrors).toEqual([]);
  return { record, runId };
}

test("cron reports mark their session unread while quiet runs and detached source sessions stay read", async () => {
  const created = await rpcReq<{ sessionId: string }>(ws, "sessions.create", {
    agentId: "main",
    key: sessionKey,
  });
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  const sessionId = expectDefined(created.payload?.sessionId, "actual created persistent session");
  const added = await rpcReq<{ id: string }>(ws, "cron.add", {
    name: "Owned unread report",
    enabled: false,
    schedule: { kind: "every", everyMs: 3_600_000 },
    sessionTarget: `session:${sessionKey}`,
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Produce the owned scheduled report." },
    delivery: { mode: "none" },
  });
  expect(added.ok, JSON.stringify(added.error)).toBe(true);
  const jobId = expectDefined(added.payload?.id, "actual created cron job");
  const baseline = await acknowledge();
  const first = await runJob(jobId, visibleReport);
  expect(first.record).toMatchObject({ status: "ok", sessionKey, sessionId });
  const transcript = await rpcReq<{ messages: unknown[] }>(ws, "chat.history", {
    sessionKey,
    limit: 100,
  });
  expect(transcript.ok, JSON.stringify(transcript.error)).toBe(true);
  expect(JSON.stringify(transcript.payload?.messages)).toContain(visibleReport);
  const history = await rpcReq<{ messages: unknown[] }>(ws, "cron.history", {
    id: jobId,
    runId: first.runId,
  });
  expect(history.ok, JSON.stringify(history.error)).toBe(true);
  expect(history.payload?.messages).toEqual(transcript.payload?.messages);
  const reported = expectDefined(
    loadSessionEntry({ agentId: "main", sessionKey, storePath }),
    "canonical reported row",
  );
  // Model I/O and both histories must succeed before the public unread regression is checked.
  const reportedRow = await readRow();
  expect(
    reportedRow.unread,
    JSON.stringify({ lastActivityAt: reported.lastActivityAt, lastReadAt: baseline.lastReadAt }),
  ).toBe(true);
  expect(reported.lastActivityAt).toBeGreaterThan(baseline.lastReadAt ?? 0);

  const beforeFailure = await acknowledge();
  const failed = await runJob(jobId, failureReport);
  expect(failed.record.status).toBe("error");
  const failureHistory = await rpcReq<{ messages: unknown[] }>(ws, "cron.history", {
    id: jobId,
    runId: failed.runId,
  });
  expect(failureHistory.ok, JSON.stringify(failureHistory.error)).toBe(true);
  expect(JSON.stringify(failureHistory.payload?.messages)).toContain("OWNED_FAILURE_REPORT");
  const failedEntry = expectDefined(
    loadSessionEntry({ agentId: "main", sessionKey, storePath }),
    "canonical failure-report row",
  );
  expect(failedEntry.lastActivityAt).toBeGreaterThan(beforeFailure.lastReadAt ?? 0);
  expect((await readRow()).unread).toBe(true);

  for (const silent of ["NO_REPLY", "", "HEARTBEAT_OK"]) {
    const read = await acknowledge();
    const quiet = await runJob(jobId, silent);
    expect(quiet.record.status).toBe("ok");
    const current = expectDefined(
      loadSessionEntry({ agentId: "main", sessionKey, storePath }),
      "canonical silent-run row",
    );
    expect(current.sessionId).toBe(sessionId);
    expect(current.lastActivityAt).toBe(read.lastActivityAt);
    expect((await readRow()).unread).toBe(false);
  }
  const beforeDetached = await acknowledge();
  const detached = await runJob(jobId, "OWNED_DETACHED_REPORT", "isolated");
  expect(detached.record.status).toBe("ok");
  expect(detached.record.sessionKey).toEqual(expect.any(String));
  expect(detached.record.sessionKey).not.toBe(sessionKey);
  expect(detached.record.sessionId).toEqual(expect.any(String));
  expect(detached.record.sessionId).not.toBe(sessionId);
  const detachedHistory = await rpcReq<{ messages: unknown[] }>(ws, "cron.history", {
    id: jobId,
    runId: detached.runId,
  });
  expect(detachedHistory.ok, JSON.stringify(detachedHistory.error)).toBe(true);
  expect(JSON.stringify(detachedHistory.payload?.messages)).toContain("OWNED_DETACHED_REPORT");
  expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })?.lastActivityAt).toBe(
    beforeDetached.lastActivityAt,
  );
  expect((await readRow()).unread).toBe(false);
});
