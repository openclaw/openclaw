// Exercises slower TUI PTY paths against real local and Gateway backends.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as waitForProcessTick } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, type TestFunction } from "vitest";
import { writeOpenAiResponsesSse } from "../../test/helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../test/helpers/openclaw-test-instance.js";
import { isProcessAlive } from "../../test/helpers/process-wait.js";
import { createDeferred, withinTest, withTestTimeout } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { reloadSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import { loadAuthProfileStoreForRuntime } from "../agents/auth-profiles/store-runtime.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { connectGatewayClient } from "../gateway/test-helpers.e2e.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  isSessionCostUsageRefreshRunning,
  prepareSessionCostUsageRefreshLock,
} from "../infra/session-cost-usage-cache.sqlite.js";
import { listUsageCountedTranscriptStats } from "../infra/session-cost-usage-collection.test-support.js";
import { runExec } from "../process/exec.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { withEnv, withEnvAsync } from "../test-utils/env.js";
import { killPidIfAlive } from "../test-utils/process-tree.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { sleep } from "../utils/sleep.js";
import { GatewayChatClient } from "./gateway-chat.js";
import { extractTextFromMessage } from "./tui-formatters.js";
import { startGatewayRpcDelayProxy } from "./tui-gateway-delay-proxy-test-support.js";
import { buildTuiLastSessionScopeKey, writeTuiLastSessionKey } from "./tui-last-session.js";
import {
  synchronizedFrameRows,
  waitForSynchronizedFrameRows,
} from "./tui-pty-harness-assertion-test-support.js";
import {
  cleanupStartedFixture,
  createChatTerminalObserver,
  createIdempotentCleanup,
  createFreshSession,
  createLocalShellControlFloodPreload,
  lastOutputIndexAfter,
  readLocalShellControlFloodPids,
  registerIdempotentCleanup,
  startGatewayCaseControlClient,
  waitForOutputAfter,
} from "./tui-pty-local-test-support.js";
import { readRequestBody, writeTuiModelHttpJson } from "./tui-pty-model-http-test-support.js";
import { buildTuiProcessArgs } from "./tui-pty-process-test-support.js";
import { startRuntimePty, waitFor, type PtyRun } from "./tui-pty-test-support.js";

type MockModelServer = Awaited<ReturnType<typeof startRoutedMockModelServer>>;

type MockModelBehavior = {
  replyText: string;
  holdFirstResponse?: boolean;
  followupReplyText?: string;
  invalidEditLoop?: boolean;
};

type MockModelRequest = {
  path: string;
  authorization?: string;
  body: Record<string, unknown>;
};

type GatewayScenario = MockModelBehavior & {
  agentId: string;
  modelId: string;
  toolsProfile: "minimal" | "coding";
};

const SHARED_GATEWAY_AGENT_ID = "tui-pty-gateway";
// These cases spawn openclaw.mjs outside the source TUI runner. CI opts in only
// after the exact head has a complete build, so source-mode PTY smoke must skip them.
const itWithBuiltCli = process.env.OPENCLAW_TUI_PTY_USE_BUILT_CLI === "1" ? it : it.skip;

function gatewayScenario<const T extends Partial<GatewayScenario>>(name: string, overrides: T) {
  return {
    ...overrides,
    agentId: overrides.agentId ?? SHARED_GATEWAY_AGENT_ID,
    modelId: overrides.modelId ?? `tui-pty-${name}`,
    toolsProfile: overrides.toolsProfile ?? "minimal",
    replyText: overrides.replyText ?? "FIRST_RUN_ACTIVE",
  };
}

const GATEWAY_SCENARIOS = {
  validation: gatewayScenario("validation", {
    agentId: "tui-pty-validation",
    toolsProfile: "coding",
    holdFirstResponse: false,
    followupReplyText: "FOLLOWUP_RUN_COMPLETE",
    invalidEditLoop: true,
  }),
  crossClient: gatewayScenario("cross-client", {
    holdFirstResponse: false,
    followupReplyText: "FOLLOWUP_RUN_COMPLETE",
  }),
  command: gatewayScenario("command", {}),
  history: gatewayScenario("history", { replyText: "T02_HISTORY_ASSISTANT" }),
  resume: gatewayScenario("resume", {
    agentId: "tui-pty-validation",
    replyText: "T03_RESUME_ASSISTANT",
    followupReplyText: "T03_RESUME_FOLLOWUP",
  }),
  followup: gatewayScenario("followup", {
    holdFirstResponse: true,
    followupReplyText: "FOLLOWUP_RUN_COMPLETE",
  }),
  emptyReply: gatewayScenario("empty-reply", {
    // Nonempty output reaches late filtering without embedded empty-response retries.
    replyText: "HEARTBEAT_OK",
    holdFirstResponse: false,
    followupReplyText: "FOLLOWUP_RUN_COMPLETE",
  }),
  cancel: gatewayScenario("cancel", {
    holdFirstResponse: true,
    followupReplyText: "FOLLOWUP_RUN_COMPLETE",
  }),
  collect: gatewayScenario("collect", {
    holdFirstResponse: true,
    followupReplyText: "FOLLOWUP_RUN_COMPLETE",
  }),
  reconnect: gatewayScenario("reconnect", { replyText: "RECONNECTED_RUN_COMPLETE" }),
} as const satisfies Record<string, GatewayScenario>;

type GatewayScenarioId = keyof typeof GATEWAY_SCENARIOS;

const LOCAL_STARTUP_TIMEOUT_MS = 60_000;
const LOCAL_OUTPUT_TIMEOUT_MS = 120_000;
const LOCAL_EXIT_TIMEOUT_MS = 4_000;
const LOCAL_TEST_TIMEOUT_MS = 150_000;
const SUBMISSION_SETTLE_MS = 150;
type ModelFixture = {
  run: PtyRun;
  mockModel: Pick<MockModelServer, "requests">;
  gateway?: OpenClawTestInstance;
};

function modelInput(fixture: ModelFixture, index = 0) {
  return JSON.stringify(fixture.mockModel.requests()[index]?.body);
}

function startTuiPty(args: string[], env: NodeJS.ProcessEnv) {
  return startRuntimePty(process.execPath, buildTuiProcessArgs(args), {
    cwd: process.cwd(),
    env,
    exitTimeoutMs: LOCAL_EXIT_TIMEOUT_MS,
    outputTimeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
  });
}

function controlClientFor(gateway: OpenClawTestInstance) {
  return new GatewayChatClient({ url: gateway.url, token: gateway.gatewayToken });
}

async function startControlClient(client: GatewayChatClient) {
  client.start();
  await withTestTimeout(
    client.waitForReady(),
    LOCAL_STARTUP_TIMEOUT_MS,
    "Gateway control client did not connect",
  );
}

async function exitTui(run: PtyRun) {
  await run.write("/exit\r", { delay: false });
  expect((await run.waitForExit()).exitCode).toBe(0);
}

async function approveLocalShell(run: PtyRun) {
  await run.waitForOutput("Allow local shell commands for this session?");
  await run.write("\u001b[B\r", { delay: false });
  await run.waitForOutput("local shell: enabled for this session");
}

function writeJson(file: string, value: unknown) {
  return writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function waitForModelRequests(fixture: ModelFixture, count: number, atLeast = false) {
  await waitFor({
    timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
    read: () => {
      const actual = fixture.mockModel.requests().length;
      const reached = atLeast ? actual >= count : actual === count;
      return reached ? true : null;
    },
    onTimeout: () =>
      new Error(
        `expected ${atLeast ? "at least" : "exactly"} ${count} model requests\n${JSON.stringify(fixture.mockModel.requests())}\n${fixture.gateway?.logs() ?? ""}\n${fixture.run.output()}`,
      ),
  });
}

function isRetryableGatewayUnavailable(error: unknown): error is Error & {
  retryAfterMs?: number;
} {
  return (
    error instanceof Error &&
    (error as { gatewayCode?: unknown }).gatewayCode === "UNAVAILABLE" &&
    (error as { retryable?: unknown }).retryable === true
  );
}

async function requestWithUnavailableRetry<T>(request: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCAL_STARTUP_TIMEOUT_MS;
  while (true) {
    try {
      return await request();
    } catch (error) {
      if (!isRetryableGatewayUnavailable(error) || Date.now() >= deadline) {
        throw error;
      }
      await sleep(Math.max(25, Math.min(error.retryAfterMs ?? 25, 1_000)));
    }
  }
}

type CleanupRegistrar = (cleanup: () => Promise<void>) => void;

// Match nested finally blocks: every phase runs, and the last failure wins.
async function cleanupInOrder(...phases: Array<() => Promise<unknown>>): Promise<void> {
  const [first, ...rest] = phases;
  if (!first) {
    return;
  }
  try {
    await first();
  } finally {
    await cleanupInOrder(...rest);
  }
}

async function writeResponsesSse(
  res: ServerResponse,
  text: string,
  completionGate?: Promise<void>,
) {
  const id = "msg_tui_pty_local";
  const message = {
    type: "message",
    id,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const textEvent = { item_id: id, output_index: 0, content_index: 0, logprobs: [] };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 0,
      item: { ...message, content: [], status: "in_progress" },
    },
    { type: "response.output_text.delta", ...textEvent, sequence_number: 1, delta: text },
    { type: "response.output_text.done", ...textEvent, sequence_number: 2, text },
    { type: "response.output_item.done", output_index: 0, sequence_number: 3, item: message },
    {
      type: "response.completed",
      sequence_number: 4,
      response: {
        id: "resp_tui_pty_local",
        status: "completed",
        output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify(events[0])}\n\n`);
  if (completionGate) {
    await completionGate;
  }
  if (res.destroyed) {
    return;
  }
  const completionBody = `${events
    .slice(1)
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("")}data: [DONE]\n\n`;
  res.end(completionBody);
}

function writeInvalidEditCallSse(res: ServerResponse, requestIndex: number) {
  const item = {
    type: "function_call",
    id: `fc_tui_validation_${requestIndex}`,
    call_id: `call_tui_validation_${requestIndex}`,
    name: "edit",
    arguments: "{}",
    status: "completed",
  };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 0,
      item: { ...item, status: "in_progress" },
    },
    { type: "response.output_item.done", output_index: 0, sequence_number: 1, item },
    {
      type: "response.completed",
      sequence_number: 2,
      response: {
        id: `resp_tui_validation_${requestIndex}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  writeOpenAiResponsesSse(res, events);
}

async function startRoutedMockModelServer(behaviors: Readonly<Record<string, MockModelBehavior>>) {
  const requests: MockModelRequest[] = [];
  const requestsByModel = new Map<string, MockModelRequest[]>();
  const firstResponseGates = new Map(
    Object.entries(behaviors)
      .filter(([, behavior]) => behavior.holdFirstResponse)
      .map(([modelId]) => [modelId, createDeferred()] as const),
  );
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz")) {
        writeTuiModelHttpJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        writeTuiModelHttpJson(res, 200, {
          data: Object.keys(behaviors).map((id) => ({ id, object: "model" })),
        });
        return;
      }
      if (req.method === "POST") {
        const raw = await readRequestBody(req);
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        if (url.pathname === "/v1/responses" || url.pathname === "/responses") {
          const modelId = typeof body.model === "string" ? body.model : "";
          const request = {
            path: url.pathname,
            authorization: req.headers.authorization,
            body,
          };
          const behavior = behaviors[modelId];
          if (!behavior) {
            writeTuiModelHttpJson(res, 400, {
              error: `unknown mock model: ${modelId || "missing"}`,
            });
            return;
          }
          const modelRequests = requestsByModel.get(modelId) ?? [];
          if (!requestsByModel.has(modelId)) {
            requestsByModel.set(modelId, modelRequests);
          }
          const requestIndex = modelRequests.length;
          requests.push(request);
          modelRequests.push(request);
          if (behavior.invalidEditLoop) {
            writeInvalidEditCallSse(res, requestIndex);
            return;
          }
          await writeResponsesSse(
            res,
            requestIndex === 0
              ? behavior.replyText
              : (behavior.followupReplyText ?? behavior.replyText),
            requestIndex === 0 ? firstResponseGates.get(modelId)?.promise : undefined,
          );
          return;
        }
        writeTuiModelHttpJson(res, 404, { error: "not found" });
        return;
      }
      writeTuiModelHttpJson(res, 404, { error: "not found" });
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock model server did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests: (modelId?: string) => (modelId ? (requestsByModel.get(modelId) ?? []) : requests),
    allowValidResponses: (modelId: string) => {
      const behavior = behaviors[modelId];
      if (behavior) {
        behavior.invalidEditLoop = false;
      }
    },
    releaseFirstResponse: (modelId: string) => {
      firstResponseGates.get(modelId)?.resolve();
    },
    stop: async () => {
      // Never leave a held request owning the shared server during failure cleanup.
      for (const gate of firstResponseGates.values()) {
        gate.resolve();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // Aborted local runs can leave a provider keep-alive open. Force-close
        // test-owned connections so cleanup does not wait for idle expiry.
        server.closeAllConnections();
      });
    },
  };
}

function buildMockModelProvider(baseUrl: string, modelIds: string[]): ModelProviderConfig {
  return {
    baseUrl: `${baseUrl}/v1`,
    apiKey: "test",
    api: "openai-responses",
    request: { allowPrivateNetwork: true },
    models: modelIds.map((id) => ({
      id,
      name: id,
      api: "openai-responses",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    })),
  };
}

function buildLocalModeConfig(params: {
  workspaceDir: string;
  providerBaseUrl: string;
  toolsProfile?: "minimal" | "coding";
}) {
  return {
    plugins: { enabled: false, slots: { memory: "none" } },
    agents: {
      defaults: {
        workspace: params.workspaceDir,
        model: { primary: "tui-pty-mock/gpt-5.5" },
        models: { "tui-pty-mock/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
        skills: [],
        skipBootstrap: true,
      },
      entries: { main: { skills: [], model: { primary: "tui-pty-mock/gpt-5.5" } } },
    },
    tools: { profile: params.toolsProfile ?? "minimal" },
    models: {
      mode: "replace",
      providers: { "tui-pty-mock": buildMockModelProvider(params.providerBaseUrl, ["gpt-5.5"]) },
    },
    gateway: { mode: "local", auth: { mode: "token", token: "tui-pty-local" } },
    discovery: { mdns: { mode: "off" } },
  } satisfies OpenClawConfig;
}

async function cleanupLocalModeResources(params: {
  run?: PtyRun;
  mockModel: MockModelServer;
  tempDir: string;
}) {
  const settled = await Promise.allSettled([
    ...(params.run ? [params.run.dispose()] : []),
    params.mockModel.stop(),
  ]);
  const failures = settled.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  try {
    await rm(params.tempDir, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "local TUI PTY fixture cleanup failed");
  }
}

async function startLocalModeTui(
  registerCleanup: CleanupRegistrar,
  opts: {
    cliArgs?: string[];
    invalidEditLoop?: boolean;
    holdFirstResponse?: boolean;
    followupReplyText?: string;
    replyText?: string;
    prepareConfig?: (params: {
      config: OpenClawConfig;
      tempDir: string;
      stateDir: string;
    }) => Promise<OpenClawConfig> | OpenClawConfig;
    prepareEnv?: (params: {
      env: NodeJS.ProcessEnv;
      tempDir: string;
      stateDir: string;
    }) => Promise<NodeJS.ProcessEnv> | NodeJS.ProcessEnv;
  } = {},
) {
  const replyText = opts.replyText ?? "LOCAL_PTY_RESPONSE";
  const tempDir = await mkdtemp(path.join(tmpdir(), "openclaw-tui-pty-local-"));
  const workspaceDir = path.join(tempDir, "workspace");
  const homeDir = path.join(tempDir, "home");
  const stateDir = path.join(tempDir, "state");
  const xdgConfigHome = path.join(tempDir, "xdg-config");
  const xdgDataHome = path.join(tempDir, "xdg-data");
  const xdgCacheHome = path.join(tempDir, "xdg-cache");
  const configPath = path.join(tempDir, "openclaw.json");
  let env: NodeJS.ProcessEnv = {
    HOME: homeDir,
    OPENCLAW_HOME: homeDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TUI_LOCAL_RUN_SHUTDOWN_GRACE_MS: "500",
    OPENCLAW_AGENT_DIR: undefined,
    OPENCLAW_SKIP_PROVIDERS: undefined,
    XDG_CONFIG_HOME: xdgConfigHome,
    XDG_DATA_HOME: xdgDataHome,
    XDG_CACHE_HOME: xdgCacheHome,
    OPENCLAW_THEME: "dark",
    OPENCLAW_CODEX_DISCOVERY_LIVE: "0",
    NO_COLOR: undefined,
  };
  const mockModel = await startRoutedMockModelServer({
    "gpt-5.5": {
      replyText,
      invalidEditLoop: opts.invalidEditLoop,
      holdFirstResponse: opts.holdFirstResponse,
      followupReplyText: opts.followupReplyText,
    },
  });
  let config: OpenClawConfig = buildLocalModeConfig({
    workspaceDir,
    providerBaseUrl: mockModel.baseUrl,
    toolsProfile: opts.invalidEditLoop ? "coding" : "minimal",
  });
  let run: PtyRun;
  try {
    config = (await opts.prepareConfig?.({ config, tempDir, stateDir })) ?? config;
    env = (await opts.prepareEnv?.({ env, tempDir, stateDir })) ?? env;
    await Promise.all([
      mkdir(workspaceDir, { recursive: true }),
      mkdir(homeDir, { recursive: true }),
      mkdir(stateDir, { recursive: true }),
      mkdir(xdgConfigHome, { recursive: true }),
      mkdir(xdgDataHome, { recursive: true }),
      mkdir(xdgCacheHome, { recursive: true }),
      writeJson(configPath, config),
    ]);

    run = await startTuiPty(opts.cliArgs ?? ["tui", "--local"], env);
  } catch (error) {
    let cleanupFailure: unknown;
    try {
      await cleanupLocalModeResources({ mockModel, tempDir });
    } catch (cleanupError) {
      cleanupFailure = cleanupError;
    }
    if (cleanupFailure !== undefined) {
      throw new Error(
        `local TUI PTY fixture cleanup failed: ${formatErrorMessage(cleanupFailure)}`,
        {
          cause: error,
        },
      );
    }
    throw error;
  }

  const cleanup = createIdempotentCleanup(async () => {
    await cleanupLocalModeResources({ run, mockModel, tempDir });
  });
  registerCleanup(cleanup);
  return {
    kind: "local" as const,
    run,
    mockModel,
    configPath,
    env,
    stateDir,
    cleanup,
  };
}

type SharedGatewayFixture = {
  gateway: OpenClawTestInstance;
  controlClient: GatewayChatClient;
  mockModel: MockModelServer;
  run: PtyRun;
  cleanup: () => Promise<void>;
};

let sharedGatewayFixtureStartup: Promise<SharedGatewayFixture> | undefined;
let gatewaySessionSequence = 0;

function buildGatewayModeConfig(params: { tempDir: string; providerBaseUrl: string }) {
  const scenarios: GatewayScenario[] = Object.values(GATEWAY_SCENARIOS);
  // One minimal agent keeps provider/runtime initialization warm; unique
  // sessions and per-session models retain each scenario's state boundary.
  const agentScenarios = scenarios.filter(
    ({ agentId }, index) => scenarios.findIndex((item) => item.agentId === agentId) === index,
  );
  const defaultScenario = GATEWAY_SCENARIOS.validation;
  const defaultModelRef = `tui-pty-mock/${defaultScenario.modelId}`;
  const modelRefs = scenarios.map((scenario) => `tui-pty-mock/${scenario.modelId}`);
  const base = buildLocalModeConfig({
    workspaceDir: path.join(params.tempDir, defaultScenario.agentId),
    providerBaseUrl: params.providerBaseUrl,
  });
  return {
    ...base,
    agents: {
      ownership: "explicit",
      defaults: {
        workspace: path.join(params.tempDir, defaultScenario.agentId),
        model: { primary: defaultModelRef },
        models: Object.fromEntries(
          modelRefs.map((modelRef) => [modelRef, { agentRuntime: { id: "openclaw" } }]),
        ),
        skills: [],
        skipBootstrap: true,
        heartbeat: { agentId: defaultScenario.agentId },
        systemAgent: { agentId: defaultScenario.agentId },
        authInheritance: { agentId: defaultScenario.agentId },
      },
      entries: Object.fromEntries(
        agentScenarios.map((scenario) => [
          scenario.agentId,
          {
            workspace: path.join(params.tempDir, scenario.agentId),
            skills: [],
            model: { primary: `tui-pty-mock/${scenario.modelId}` },
            tools: { profile: scenario.toolsProfile },
          },
        ]),
      ),
    },
    talk: { agentId: defaultScenario.agentId },
    models: {
      mode: "replace",
      providers: {
        "tui-pty-mock": buildMockModelProvider(
          params.providerBaseUrl,
          scenarios.map((scenario) => scenario.modelId),
        ),
      },
    },
    messages: { queue: { mode: "followup" } },
  } satisfies OpenClawConfig;
}

async function startSharedGatewayFixture(): Promise<SharedGatewayFixture> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "openclaw-tui-pty-gateway-"));
  let mockModel: MockModelServer | undefined;
  let gateway: OpenClawTestInstance | undefined;
  let controlClient: GatewayChatClient | undefined;
  let run: PtyRun | undefined;
  try {
    const scenarios: GatewayScenario[] = Object.values(GATEWAY_SCENARIOS);
    await Promise.all(
      [...new Set(scenarios.map((scenario) => scenario.agentId))].map((agentId) =>
        mkdir(path.join(tempDir, agentId), { recursive: true }),
      ),
    );
    mockModel = await startRoutedMockModelServer(
      Object.fromEntries(
        scenarios.map((scenario) => [
          scenario.modelId,
          {
            replyText: scenario.replyText,
            holdFirstResponse: scenario.holdFirstResponse,
            followupReplyText: scenario.followupReplyText,
            invalidEditLoop: scenario.invalidEditLoop,
          },
        ]),
      ),
    );
    gateway = await createOpenClawTestInstance({
      name: "tui-pty-shared-gateway",
      gatewayToken: "tui-pty-local",
      config: buildGatewayModeConfig({ tempDir, providerBaseUrl: mockModel.baseUrl }),
      env: { OPENCLAW_CODEX_DISCOVERY_LIVE: "0", OPENCLAW_SKIP_PROVIDERS: undefined },
    });
    await gateway.startGateway();

    controlClient = controlClientFor(gateway);
    await startControlClient(controlClient);

    const initialScenario = GATEWAY_SCENARIOS.validation;
    const initialSessionKey = `agent:${initialScenario.agentId}:tui-pty-shared`;
    await controlClient.createSession({ key: initialSessionKey, agentId: initialScenario.agentId });
    run = await startTuiPty(
      [
        "tui",
        "--url",
        gateway.url,
        "--token",
        gateway.gatewayToken,
        "--session",
        initialSessionKey,
      ],
      { ...gateway.env, OPENCLAW_THEME: "dark", NO_COLOR: undefined },
    );
    await run.waitForOutput("gateway connected", LOCAL_STARTUP_TIMEOUT_MS);

    const fixtureGateway = gateway;
    const fixtureMockModel = mockModel;
    const fixtureControlClient = controlClient;
    const fixtureRun = run;
    const cleanup = createIdempotentCleanup(() =>
      cleanupInOrder(
        () => fixtureRun.dispose(),
        () => fixtureControlClient.stop(),
        () => fixtureGateway.cleanup(),
        () => fixtureMockModel.stop(),
        () => rm(tempDir, { recursive: true, force: true }),
      ),
    );
    return {
      gateway: fixtureGateway,
      controlClient: fixtureControlClient,
      mockModel: fixtureMockModel,
      run: fixtureRun,
      cleanup,
    };
  } catch (error) {
    await cleanupInOrder(
      async () => run?.dispose(),
      async () => controlClient?.stop(),
      async () => gateway?.cleanup(),
      async () => mockModel?.stop(),
      () => rm(tempDir, { recursive: true, force: true }),
    );
    throw error;
  }
}

async function requireSharedGatewayFixture(): Promise<SharedGatewayFixture> {
  if (!sharedGatewayFixtureStartup) {
    throw new Error("shared Gateway fixture startup was not initialized");
  }
  return await sharedGatewayFixtureStartup;
}

async function startGatewayModeTui(
  scenarioId: GatewayScenarioId,
  registerCleanup: CleanupRegistrar,
) {
  const shared = await requireSharedGatewayFixture();
  const scenario = GATEWAY_SCENARIOS[scenarioId];
  const requestOffset = shared.mockModel.requests(scenario.modelId).length;
  const sessionKey = `agent:${scenario.agentId}:tui-pty-${++gatewaySessionSequence}`;
  const sessionKeys = new Set([sessionKey]);
  const controlClient = controlClientFor(shared.gateway);
  const cleanup = await startGatewayCaseControlClient({
    client: controlClient,
    sessionKeys,
    registerCleanup,
    releaseResponse: () => shared.mockModel.releaseFirstResponse(scenario.modelId),
    timeoutMs: LOCAL_STARTUP_TIMEOUT_MS,
  });
  await controlClient.createSession({ key: sessionKey, agentId: scenario.agentId });
  await controlClient.patchSession({
    key: sessionKey,
    agentId: scenario.agentId,
    model: `tui-pty-mock/${scenario.modelId}`,
  });
  const run = shared.run;
  const adoptionOffset = run.visibleOutput().length;
  await run.write(`/session ${sessionKey}\r`, { delay: false });
  const sessionAcknowledgement = `session ${sessionKey.split(":").at(-1)}`;
  await waitForOutputAfter(run, sessionAcknowledgement, adoptionOffset);
  await waitFor({
    timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
    read: () => {
      const screen = synchronizedFrameRows(run.output(), run)[0]?.join("\n") ?? "";
      return screen.includes(sessionAcknowledgement) &&
        screen.includes(scenario.modelId) &&
        screen.includes("| idle")
        ? true
        : null;
    },
    onTimeout: () => new Error("adopted Gateway session did not reach an idle final screen"),
  });
  const outputOffset = run.visibleOutput().length;
  return {
    kind: "gateway" as const,
    controlClient,
    run,
    gateway: shared.gateway,
    mockModel: {
      requests: () => shared.mockModel.requests(scenario.modelId).slice(requestOffset),
      releaseFirstResponse: () => shared.mockModel.releaseFirstResponse(scenario.modelId),
    },
    sessionKey,
    waitForOutput: async (needle: string, timeoutMs = LOCAL_OUTPUT_TIMEOUT_MS) =>
      await waitForOutputAfter(run, needle, outputOffset, timeoutMs),
    visibleOutput: () => run.visibleOutput().slice(outputOffset),
    lastOutputIndex: (needle: string) => lastOutputIndexAfter(run, needle, outputOffset),
    trackSessionKey: (key: string) => sessionKeys.add(key),
    cleanup,
  };
}

async function startIsolatedGatewayPty(params: {
  gateway: OpenClawTestInstance;
  registerCleanup: CleanupRegistrar;
  sessionKey?: string;
  token?: string;
  clientStateDir?: string;
  url?: string;
}) {
  const {
    gateway,
    registerCleanup,
    sessionKey,
    token = gateway.gatewayToken,
    url = gateway.url,
  } = params;
  const ownsClientStateDir = !params.clientStateDir;
  const tempDir =
    params.clientStateDir ??
    (await mkdtemp(path.join(tmpdir(), "openclaw-tui-pty-gateway-client-")));
  let run: PtyRun;
  try {
    await writeFile(path.join(tempDir, "openclaw.json"), "{}\n", "utf8");
    const cliArgs = ["tui", "--url", url, "--token", token];
    if (sessionKey) {
      cliArgs.push("--session", sessionKey);
    }
    run = await startTuiPty(cliArgs, {
      ...gateway.env,
      HOME: tempDir,
      OPENCLAW_HOME: tempDir,
      OPENCLAW_CONFIG_PATH: path.join(tempDir, "openclaw.json"),
      OPENCLAW_STATE_DIR: tempDir,
      OPENCLAW_AGENT_DIR: undefined,
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      OPENCLAW_THEME: "dark",
      NO_COLOR: undefined,
    });
  } catch (error) {
    if (ownsClientStateDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
    throw error;
  }
  const cleanup = createIdempotentCleanup(async () => {
    try {
      await run.dispose();
    } finally {
      if (ownsClientStateDir) {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  });
  registerCleanup(cleanup);
  return { run, cleanup };
}

type GatewayHistory = { messages: unknown[]; sessionInfo?: Record<string, unknown> };
function findOrderedTurn(messages: unknown[], userText: string, assistantText: string, after = -1) {
  const exact = (message: unknown, role: "assistant" | "user", text: string) =>
    (message as { role?: unknown } | null)?.role === role &&
    extractTextFromMessage(message).trim() === text;
  const user = messages.findIndex((m, i) => i > after && exact(m, "user", userText));
  return user < 0
    ? -1
    : messages.findIndex((m, i) => i > user && exact(m, "assistant", assistantText));
}
async function waitForHistoryMessages(
  client: GatewayChatClient,
  key: string,
  accept: (history: GatewayHistory) => boolean,
) {
  const deadline = Date.now() + LOCAL_OUTPUT_TIMEOUT_MS;
  for (; Date.now() < deadline; await sleep(25)) {
    const history = (await client.loadHistory({ sessionKey: key, limit: 100 })) as GatewayHistory;
    if (Array.isArray(history.messages) && accept(history)) {
      return history;
    }
  }
  throw new Error(`history ${key} did not reach the expected authoritative state`);
}
// Gateway cases share one real server and PTY but keep isolated models and sessions.
// Per-case abort cleanup and serial order prevent active-run or queue state leaks.
describe("TUI PTY real backends", () => {
  for (const alias of ["chat", "terminal"] as const) {
    it(
      `launches openclaw ${alias} as local mode through a real PTY`,
      async ({ onTestFinished }) => {
        const replyText = `${alias.toUpperCase()}_ALIAS_RESPONSE`;
        const prompt = `message through ${alias} alias`;
        const cliModelId = "claude-sonnet-5";
        const cliModelRef = `claude-cli/${cliModelId}`;
        const canonicalModelRef = `anthropic/${cliModelId}`;
        const fixture = await startLocalModeTui(onTestFinished, {
          cliArgs: [alias],
          replyText,
          ...(alias === "chat"
            ? {
                prepareConfig: ({ config }: { config: OpenClawConfig }) => {
                  const mockProvider = config.models?.providers?.["tui-pty-mock"];
                  if (!mockProvider) {
                    throw new Error("local PTY fixture model provider is missing");
                  }
                  const cliProvider = structuredClone(mockProvider);
                  for (const model of cliProvider.models) {
                    model.id = cliModelId;
                    model.name = cliModelId;
                  }
                  return {
                    ...config,
                    plugins: {
                      enabled: true,
                      allow: ["anthropic"],
                      entries: { anthropic: { enabled: true } },
                      slots: { memory: "none" },
                    },
                    agents: {
                      ...config.agents,
                      defaults: {
                        ...config.agents?.defaults,
                        models: { ...config.agents?.defaults?.models, [cliModelRef]: {} },
                      },
                    },
                    models: {
                      ...config.models,
                      providers: { ...config.models?.providers, "claude-cli": cliProvider },
                    },
                  } satisfies OpenClawConfig;
                },
              }
            : {}),
        });

        await fixture.run.waitForOutput("local ready", LOCAL_STARTUP_TIMEOUT_MS);
        if (alias === "chat") {
          const modelOffset = fixture.run.visibleOutput().length;
          await fixture.run.write(`/model ${cliModelRef}\r`, { delay: false });
          const confirmation = await waitFor({
            timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
            read: () => {
              const output = fixture.run.visibleOutput().slice(modelOffset);
              return output.includes(`model set to ${canonicalModelRef}`) ||
                output.includes(`model set to ${cliModelRef}`)
                ? output
                : null;
            },
            onTimeout: () => new Error(`model selection did not finish\n${fixture.run.output()}`),
          });
          expect.soft(confirmation).toContain(`model set to ${canonicalModelRef}`);
          expect(fixture.mockModel.requests()).toHaveLength(0);

          const restoreOffset = fixture.run.visibleOutput().length;
          await fixture.run.write("/model tui-pty-mock/gpt-5.5\r", { delay: false });
          await waitForOutputAfter(fixture.run, "model set to tui-pty-mock/gpt-5.5", restoreOffset);
        }
        await fixture.run.write(`${prompt}\r`);
        await waitForModelRequests(fixture, 1);
        expect(modelInput(fixture)).toContain(prompt);
        await fixture.run.waitForOutput(replyText, LOCAL_OUTPUT_TIMEOUT_MS);
        await fixture.run.write("/exit\r", { delay: false });
        const exitCode = (await fixture.run.waitForExit()).exitCode;
        expect(exitCode).toBe(0);
      },
      LOCAL_TEST_TIMEOUT_MS,
    );
  }

  it(
    "sends the initial message supplied to openclaw tui through a real local PTY",
    async ({ onTestFinished }) => {
      const initialMessage = "initial message from CLI launch";
      const replyText = "INITIAL_MESSAGE_RESPONSE";
      const fixture = await startLocalModeTui(onTestFinished, {
        cliArgs: ["tui", "--local", "--message", initialMessage],
        replyText,
      });

      await fixture.run.waitForOutput("local ready", LOCAL_STARTUP_TIMEOUT_MS);
      await waitForModelRequests(fixture, 1);
      expect(modelInput(fixture)).toContain(initialMessage);
      await fixture.run.waitForOutput(replyText, LOCAL_OUTPUT_TIMEOUT_MS);
      await exitTui(fixture.run);
    },
    LOCAL_TEST_TIMEOUT_MS,
  );

  it(
    "rejects Gateway options on a local TUI alias through a real PTY",
    async ({ onTestFinished }) => {
      const run = await startTuiPty(["chat", "--url", "ws://127.0.0.1:1"], {
        OPENCLAW_THEME: "dark",
        NO_COLOR: undefined,
      });
      onTestFinished(async () => {
        await run.dispose();
      });

      await run.waitForOutput(
        "--local cannot be combined with --url, --token, --password, or --tls-fingerprint",
        LOCAL_STARTUP_TIMEOUT_MS,
      );
      expect((await run.waitForExit()).exitCode).toBe(1);
    },
    LOCAL_TEST_TIMEOUT_MS,
  );

  for (const cacheState of ["fresh", "refreshing"] as const) {
    it(
      `prints ${cacheState} local usage costs without submitting a model request`,
      async ({ onTestFinished }) => {
        const agentId = "main";
        const sessionKey = `agent:${agentId}:usage-cost-${cacheState}-unpersisted`;
        const cleanupState: { run?: () => Promise<void> } = {};
        const finish = (dispose: () => Promise<void>) =>
          runQaGatewayFixture(async () => await cleanupState.run?.(), dispose);
        const fixture = await startLocalModeTui(
          (dispose) => onTestFinished(() => finish(dispose)),
          { cliArgs: ["tui", "--local", "--session", sessionKey] },
        );
        const databasePath = resolveOpenClawAgentSqlitePath({ agentId, env: fixture.env });
        const selectedSession = { agentId, sessionKey, storePath: databasePath };
        let refreshOwner: ReturnType<typeof prepareSessionCostUsageRefreshLock> | undefined;
        // Repeated teardown must not reopen the removed root through release().
        cleanupState.run = createIdempotentCleanup(() =>
          runQaGatewayFixture(
            async () => withEnvAsync(fixture.env, async () => await refreshOwner?.release()),
            () => fixture.run.dispose(),
            () =>
              withEnvAsync(fixture.env, () =>
                cleanupSessionStateForTest({ stateDir: fixture.stateDir }),
              ),
          ),
        );

        await runQaGatewayFixture(
          async () => {
            await fixture.run.waitForOutput("local ready", LOCAL_STARTUP_TIMEOUT_MS);
            await withEnvAsync(fixture.env, async () => {
              // An empty existing row still makes the direct Session reader wait.
              expect(loadSessionEntry(selectedSession)).toBeUndefined();
              if (cacheState === "refreshing") {
                refreshOwner = prepareSessionCostUsageRefreshLock(agentId, databasePath);
                expect(await refreshOwner.acquire()).toBe(true);
              }
              expect(await isSessionCostUsageRefreshRunning(agentId, databasePath)).toBe(
                cacheState === "refreshing",
              );
            });
            expect(
              await withEnvAsync(fixture.env, () =>
                listUsageCountedTranscriptStats(agentId, {
                  storePath: databasePath,
                  sessionsDir: path.join(fixture.stateDir, "agents", agentId, "sessions"),
                }),
              ),
            ).toEqual([]);

            await fixture.run.write("/usage cost\r", { delay: false });
            const rows = await waitForSynchronizedFrameRows(
              fixture.run,
              (frame) => frame.some((row) => row.includes("Last 30d")),
              LOCAL_OUTPUT_TIMEOUT_MS,
            );
            const text = rows.join(" ").replace(/\s+/gu, " ");
            const expected = [
              "Session n/a",
              ...(cacheState === "refreshing"
                ? ["Usage totals may be incomplete (refreshing). Run this command again later."]
                : []),
              "Today $0.0000",
              "Last 30d $0.0000",
            ].join(" ");
            expect(text).toContain(expected);
            expect(fixture.mockModel.requests()).toHaveLength(0);
            await withEnvAsync(fixture.env, async () => {
              expect(loadSessionEntry(selectedSession)).toBeUndefined();
              expect(await isSessionCostUsageRefreshRunning(agentId, databasePath)).toBe(
                cacheState === "refreshing",
              );
            });
          },
          () => finish(fixture.cleanup),
        );
      },
      LOCAL_TEST_TIMEOUT_MS,
    );
  }

  it(
    "drives and steers the real local backend with a mocked model endpoint",
    async ({ onTestFinished }) => {
      const fixture = await startLocalModeTui(onTestFinished, {
        holdFirstResponse: true,
        followupReplyText: "LOCAL_STEER_COMPLETE",
      });

      await fixture.run.waitForOutput("local ready", LOCAL_STARTUP_TIMEOUT_MS);
      for (const command of ["/status", "/compact", "/commands", "/context"]) {
        await fixture.run.write(`${command}\r`);
        await fixture.run.waitForOutput(
          `${command} is not available in local embedded mode; message not sent`,
        );
      }
      await fixture.run.write("/side\r");
      await fixture.run.waitForOutput("Usage: /btw <side question>");
      expect(fixture.mockModel.requests()).toHaveLength(0);

      await fixture.run.write("slow local parent\r");
      await waitForModelRequests(fixture, 1);
      const request = fixture.mockModel.requests()[0];
      expect(request).toMatchObject({ path: "/v1/responses", body: { model: "gpt-5.5" } });

      const steerOffset = fixture.run.visibleOutput().length;
      await fixture.run.write("steer the active local turn\r");
      await waitForOutputAfter(fixture.run, "steer the active local turn", steerOffset);
      await sleep(SUBMISSION_SETTLE_MS);
      fixture.mockModel.releaseFirstResponse("gpt-5.5");

      await waitForModelRequests(fixture, 2);
      expect(modelInput(fixture, 1)).toContain("steer the active local turn");
      await fixture.run.waitForOutput("LOCAL_STEER_COMPLETE");

      const steerResponseOffset = fixture.run.visibleOutput().lastIndexOf("LOCAL_STEER_COMPLETE");
      await waitForOutputAfter(fixture.run, "| idle", steerResponseOffset);
      const newOffset = fixture.run.visibleOutput().length;
      await createFreshSession(fixture.run, "new session: agent:main:tui-");
      const createdKey = fixture.run
        .visibleOutput()
        .slice(newOffset)
        .match(/new session: (agent:main:tui-\S+)/)?.[1];
      expect(createdKey).toBeDefined();
      await waitForSynchronizedFrameRows(
        fixture.run,
        (rows) => rows.some((row) => row.includes(`session ${createdKey!.split(":").at(-1)}`)),
        LOCAL_OUTPUT_TIMEOUT_MS,
      );
      const freshResponseStart = fixture.run.visibleOutput().length;
      await fixture.run.write("send after local new\r");
      await waitForModelRequests(fixture, 3);
      const freshRequest = modelInput(fixture, 2);
      expect(freshRequest).toContain("send after local new");
      expect(freshRequest).not.toContain("slow local parent");
      expect(freshRequest).not.toContain("steer the active local turn");
      await waitForOutputAfter(fixture.run, "LOCAL_STEER_COMPLETE", freshResponseStart);
      const freshResponseOffset = fixture.run.visibleOutput().lastIndexOf("LOCAL_STEER_COMPLETE");
      await waitForOutputAfter(fixture.run, "| idle", freshResponseOffset);

      await exitTui(fixture.run);
    },
    LOCAL_TEST_TIMEOUT_MS,
  );

  it(
    "lists local session history through a real PTY",
    async ({ onTestFinished }) => {
      const [first, second] = ["T03_HISTORY_FIRST_REPLY", "T03_HISTORY_SECOND_REPLY"];
      const pickerClosed = (rows: string[]) =>
        !rows.some((row) => row.includes("Filter:")) &&
        rows.some((row) => row.includes("local ready") && row.includes("| idle"));
      const fixture = await startLocalModeTui(onTestFinished, {
        replyText: first,
        followupReplyText: second,
      });

      await fixture.run.waitForOutput("local ready", LOCAL_STARTUP_TIMEOUT_MS);
      await fixture.run.write("T03_HISTORY_FIRST_PROMPT\r");
      await fixture.run.waitForOutput(first, LOCAL_OUTPUT_TIMEOUT_MS);
      const firstReplyOffset = fixture.run.visibleOutput().lastIndexOf(first);
      await waitForOutputAfter(fixture.run, "| idle", firstReplyOffset);
      await createFreshSession(fixture.run, "new session: agent:main:tui-");
      await fixture.run.write("T03_HISTORY_SECOND_PROMPT\r");
      await fixture.run.waitForOutput(second, LOCAL_OUTPUT_TIMEOUT_MS);
      const secondReplyOffset = fixture.run.visibleOutput().lastIndexOf(second);
      await waitForOutputAfter(fixture.run, "| idle", secondReplyOffset);
      await fixture.run.write("/sessions\r", { delay: false });
      const pickerRows = await waitForSynchronizedFrameRows(
        fixture.run,
        (rows) => [first, second].every((reply) => rows.some((row) => row.includes(reply))),
        LOCAL_OUTPUT_TIMEOUT_MS,
      );
      const picker = pickerRows.join("\n");
      expect(picker.indexOf(second)).toBeLessThan(picker.indexOf(first));
      expect(fixture.mockModel.requests()).toHaveLength(2);
      await fixture.run.write("\u001b", { delay: false });
      await waitForSynchronizedFrameRows(fixture.run, pickerClosed, LOCAL_EXIT_TIMEOUT_MS);
      await exitTui(fixture.run);
    },
    LOCAL_TEST_TIMEOUT_MS,
  );

  it(
    "keeps whitespace-prefixed bang input in chat after local shell approval",
    async ({ onTestFinished }) => {
      const fixture = await startLocalModeTui(onTestFinished, { replyText: "T06_CHAT_RESPONSE" });

      await fixture.run.waitForOutput("local ready", LOCAL_STARTUP_TIMEOUT_MS);
      await fixture.run.write("!node -e \"console.log('T06_APPROVAL_PRIMER')\"\r");
      await approveLocalShell(fixture.run);
      await fixture.run.waitForOutput("[local] T06_APPROVAL_PRIMER");
      await fixture.run.waitForOutput("[local] exit 0");

      const chatOffset = fixture.run.visibleOutput().length;
      const command = " !node -e \"console.log('T06_UNEXPECTED_EXECUTION')\"";
      await fixture.run.write(`${command}\r`);
      await waitForModelRequests(fixture, 1);
      expect(modelInput(fixture)).toContain("T06_UNEXPECTED_EXECUTION");
      await waitForOutputAfter(fixture.run, "T06_CHAT_RESPONSE", chatOffset);
      expect(fixture.run.visibleOutput().slice(chatOffset)).not.toContain(
        "[local] T06_UNEXPECTED_EXECUTION",
      );

      await exitTui(fixture.run);
    },
    LOCAL_TEST_TIMEOUT_MS,
  );

  it(
    "confirms and renders local shell output, then extinguishes descendants before TUI exit",
    async ({ onTestFinished }) => {
      const fixture = await startLocalModeTui(onTestFinished);
      const rootPath = path.join(fixture.stateDir, "tui-local-owned-root.cjs");
      const pidPath = path.join(fixture.stateDir, "tui-local-owned-descendant.pid");
      let descendantPid: number | undefined;
      try {
        await writeFile(
          rootPath,
          `
            const { spawn } = require("node:child_process");
            const { writeFileSync } = require("node:fs");
            const stdio = process.platform === "win32"
              ? ["ignore", "ignore", "ignore"]
              : ["ignore", "ignore", "ignore", 3];
            const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
              stdio,
              detached: process.platform === "win32",
            });
            child.unref();
            writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
          `,
          "utf8",
        );
        await fixture.run.waitForOutput("local ready", LOCAL_STARTUP_TIMEOUT_MS);
        await fixture.run.write(
          "!node -e \"console.log('T06_STDOUT'); console.error('T06_STDERR'); console.log('T06_ENV='+process.env.OPENCLAW_SHELL); process.exitCode=7\"\r",
        );
        await fixture.run.waitForOutput("Allow local shell commands for this session?");
        await fixture.run.waitForOutput("Select Yes/No (arrows + Enter), Esc to cancel.");
        expect(fixture.run.visibleOutput()).toContain("No");
        expect(fixture.run.visibleOutput()).toContain("Yes");

        await fixture.run.write("\u001b[B\r", { delay: false });
        await fixture.run.waitForOutput("local shell: enabled for this session");
        await fixture.run.waitForOutput("[local] T06_STDOUT");
        await fixture.run.waitForOutput("[local] T06_STDERR");
        await fixture.run.waitForOutput("[local] T06_ENV=tui-local");
        await fixture.run.waitForOutput("[local] exit 7");

        const descendantCommandOffset = fixture.run.visibleOutput().length;
        await fixture.run.write(`!node ${JSON.stringify(rootPath)}\r`);
        await waitForOutputAfter(fixture.run, "[local] exit 0", descendantCommandOffset);
        // The fixture writes its descendant PID synchronously before the completed command exits.
        descendantPid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
        expect(Number.isSafeInteger(descendantPid) && descendantPid > 0).toBe(true);
        expect(isProcessAlive(descendantPid)).toBe(true);

        await exitTui(fixture.run);
        expect(isProcessAlive(descendantPid)).toBe(false);
      } finally {
        killPidIfAlive(descendantPid);
        await fixture.cleanup();
      }
    },
    LOCAL_TEST_TIMEOUT_MS,
  );

  it.skipIf(process.platform === "win32")(
    "reports a flooded local-shell control pipe and reclaims its command group",
    async ({ onTestFinished, signal }) => {
      let rolePidPath = "";
      const trackedPids: number[] = [];
      const fixture = await startLocalModeTui(onTestFinished, {
        prepareEnv: async ({ env, tempDir }) => {
          const preloadPath = path.join(tempDir, "control-flood.cjs");
          rolePidPath = path.join(tempDir, "control-flood-pids.txt");
          await writeFile(preloadPath, createLocalShellControlFloodPreload(), "utf8");
          return {
            ...env,
            NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require=${preloadPath}`.trim(),
            OPENCLAW_CONTROL_PROBE_PATH: rolePidPath,
          };
        },
      });
      const commandPath = path.join(fixture.stateDir, "control-flood-command.cjs");
      const commandPidPath = path.join(fixture.stateDir, "control-flood-command-pids.txt");
      try {
        await writeFile(
          commandPath,
          `
            const fs = require("node:fs");
            const { spawn } = require("node:child_process");
            const descendant = spawn(process.execPath, [
              "-e", "setInterval(() => {}, 1000); process.send('ready');",
            ], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
            descendant.once("message", (message) => {
              if (message !== "ready") throw new Error("unexpected descendant readiness");
              fs.writeFileSync(
                ${JSON.stringify(commandPidPath)},
                "command " + process.pid + "\\ndescendant " + descendant.pid + "\\n",
              );
              descendant.disconnect();
            });
            setInterval(() => {}, 1000);
          `,
          "utf8",
        );
        await fixture.run.waitForOutput("local ready", LOCAL_STARTUP_TIMEOUT_MS);
        await fixture.run.write(
          `!${JSON.stringify(process.execPath)} ${JSON.stringify(commandPath)}\r`,
        );
        await approveLocalShell(fixture.run);
        const pidEntries = await waitFor({
          timeoutMs: LOCAL_EXIT_TIMEOUT_MS,
          read: () => readLocalShellControlFloodPids(rolePidPath, commandPidPath),
          onTimeout: () => new Error("local shell did not report its complete process group"),
        });
        trackedPids.push(...pidEntries.values());
        expect(trackedPids.every(isProcessAlive)).toBe(true);
        await writeFile(`${rolePidPath}.release`, "release", "utf8");
        await fixture.run.waitForOutput(
          "[local] error: service child cleanup identity lost: control pipe pending line exceeded cap",
          LOCAL_EXIT_TIMEOUT_MS,
        );
        // The TUI owns these processes and reports the pipe failure before reclamation settles.
        // No descendant handles cross the PTY boundary; only the test signal bounds observation.
        await withinTest(
          (async () => {
            while (trackedPids.some(isProcessAlive)) {
              await waitForProcessTick(10, undefined, { signal });
            }
          })(),
          signal,
        ).catch((cause: unknown) => {
          throw new Error("local shell control-pipe failure left its group alive", { cause });
        });

        await exitTui(fixture.run);
      } finally {
        trackedPids.forEach(killPidIfAlive);
        await fixture.cleanup();
      }
    },
    LOCAL_TEST_TIMEOUT_MS,
  );

  itWithBuiltCli(
    "repairs isolated config through the approved built CLI and resumes local chat",
    async ({ onTestFinished }) => {
      const fixture = await startLocalModeTui(onTestFinished, {
        prepareConfig: ({ config }) => ({
          ...config,
          tools: { ...config.tools, profile: "coding" },
        }),
      });

      await fixture.run.waitForOutput("local ready", LOCAL_STARTUP_TIMEOUT_MS);
      const cliPath = path.join(process.cwd(), "openclaw.mjs");
      const cli = `${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)}`;
      await fixture.run.write(`!${cli} config set tools.profile minimal\r`);
      await approveLocalShell(fixture.run);
      await fixture.run.waitForOutput("[local] exit 0");

      const repaired = JSON.parse(await readFile(fixture.configPath, "utf8")) as OpenClawConfig;
      expect(repaired.tools?.profile).toBe("minimal");

      const { stdout } = await runExec(
        process.execPath,
        [cliPath, "config", "validate", "--json"],
        {
          cwd: process.cwd(),
          env: { ...fixture.env, OPENCLAW_TEST_RUNTIME_LOG: "1" },
          logOutput: false,
          timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
        },
      );
      expect(JSON.parse(stdout)).toMatchObject({ valid: true });

      await fixture.run.write("prompt after config repair\r");
      await waitForModelRequests(fixture, 1);
      expect(modelInput(fixture)).toContain("prompt after config repair");
      await fixture.run.waitForOutput("LOCAL_PTY_RESPONSE", LOCAL_OUTPUT_TIMEOUT_MS);

      await exitTui(fixture.run);
    },
    LOCAL_TEST_TIMEOUT_MS,
  );

  itWithBuiltCli(
    "authenticates a manifest-discovered provider and resumes the unchanged local model",
    async ({ onTestFinished }) => {
      const pluginId = "t05-local-auth-fixture";
      const providerId = "tui-pty-mock";
      const profileId = `${providerId}:default`;
      const sentinel = `t05-${randomUUID()}`;
      const expectedDigest = createHash("sha256").update(sentinel).digest("hex");
      const fixture = await startLocalModeTui(onTestFinished, {
        replyText: "LOCAL_AUTH_RESPONSE",
        prepareConfig: async ({ config, tempDir }) => {
          const pluginDir = path.join(tempDir, "auth-plugin");
          await mkdir(pluginDir, { recursive: true });
          await Promise.all([
            writeJson(path.join(pluginDir, "package.json"), {
              name: "@openclaw/t05-local-auth-fixture",
              version: "0.0.0",
              type: "module",
              openclaw: { extensions: ["./index.js"] },
            }),
            writeJson(path.join(pluginDir, "openclaw.plugin.json"), {
              id: pluginId,
              name: "T05 Local Auth Fixture",
              providers: [providerId],
              setup: { providers: [{ id: providerId, envVars: ["T05_LOCAL_AUTH_API_KEY"] }] },
              providerAuthChoices: [
                {
                  provider: providerId,
                  method: "api-key",
                  choiceId: `${providerId}-api-key`,
                  choiceLabel: "T05 local auth API key",
                  groupId: providerId,
                  groupLabel: "T05 local auth",
                  optionKey: "t05LocalAuthApiKey",
                  cliFlag: "--t05-local-auth-api-key",
                  cliOption: "--t05-local-auth-api-key <key>",
                  onboardingScopes: ["text-inference"],
                },
              ],
              configSchema: { type: "object", additionalProperties: false, properties: {} },
            }),
            writeFile(
              path.join(pluginDir, "index.js"),
              `const providerId = ${JSON.stringify(providerId)};
export default {
  id: ${JSON.stringify(pluginId)},
  name: "T05 Local Auth Fixture",
  register(api) {
    api.registerProvider({
      id: providerId,
      label: "T05 local auth",
      envVars: ["T05_LOCAL_AUTH_API_KEY"],
      auth: [{
        id: "api-key",
        kind: "api_key",
        label: "T05 local auth API key",
        run: async (ctx) => {
          const key = await ctx.prompter.text({
            message: "Enter T05 local auth API key",
            sensitive: true,
          });
          return {
            profiles: [{
              profileId: providerId + ":default",
              credential: { type: "api_key", provider: providerId, key },
            }],
          };
        },
      }],
    });
  },
};
`,
              "utf8",
            ),
          ]);
          return {
            ...config,
            plugins: {
              enabled: true,
              slots: { memory: "none" },
              load: { paths: [pluginDir] },
              allow: [pluginId],
              entries: { [pluginId]: { enabled: true } },
            },
          };
        },
      });

      await fixture.run.waitForOutput("local ready", LOCAL_STARTUP_TIMEOUT_MS);
      await fixture.run.write(`/auth ${providerId}\r`, { delay: false });
      await fixture.run.waitForOutput(`opening auth flow for ${providerId}`);
      await fixture.run.waitForOutput("Enter T05 local auth API key");
      await fixture.run.write(`${sentinel}\r`, { delay: false });
      await fixture.run.waitForOutput("Keep current restrictions");
      await fixture.run.write("\r", { delay: false });
      await fixture.run.waitForOutput(`auth flow finished for ${providerId}`);
      expect(fixture.run.output().includes(sentinel)).toBe(false);

      const agentDir = path.join(fixture.stateDir, "agents", "main", "agent");
      const sqlitePath = path.join(agentDir, "openclaw-agent.sqlite");
      expect(await stat(sqlitePath).then((entry) => entry.isFile())).toBe(true);
      await reloadSharedAuthStoreOwnership({
        ...process.env,
        OPENCLAW_STATE_DIR: fixture.stateDir,
      });
      const store = withEnv({ OPENCLAW_STATE_DIR: fixture.stateDir }, () => {
        return loadAuthProfileStoreForRuntime(agentDir, { readOnly: true, syncExternalCli: false });
      });
      const profile = store?.profiles[profileId];
      expect(profile).toMatchObject({ type: "api_key", provider: providerId });
      const persistedDigest =
        profile?.type === "api_key" && profile.key
          ? createHash("sha256").update(profile.key).digest("hex")
          : "";
      expect(persistedDigest).toBe(expectedDigest);

      const config = JSON.parse(await readFile(fixture.configPath, "utf8")) as OpenClawConfig;
      expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe(
        "tui-pty-mock/gpt-5.5",
      );
      await fixture.run.write("prompt after local auth\r");
      await waitForModelRequests(fixture, 1);
      expect(fixture.mockModel.requests()[0]?.body.model).toBe("gpt-5.5");
      expect(fixture.mockModel.requests()[0]?.authorization).toBe(`Bearer ${sentinel}`);
      await fixture.run.waitForOutput("LOCAL_AUTH_RESPONSE", LOCAL_OUTPUT_TIMEOUT_MS);

      await exitTui(fixture.run);
    },
    LOCAL_TEST_TIMEOUT_MS,
  );

  function registerValidationLoopTest(mode: "gateway" | "local") {
    it(
      `renders safe validation-loop abort diagnostics through the real ${mode} backend`,
      async ({ onTestFinished }) => {
        const fixture =
          mode === "gateway"
            ? await startGatewayModeTui("validation", onTestFinished)
            : await startLocalModeTui(onTestFinished, { invalidEditLoop: true });
        const expectedGatewaySessionKey =
          fixture.kind === "gateway" ? fixture.sessionKey : undefined;
        let eventProbe: GatewayChatClient | undefined;
        const probedEvents: Array<{ event: string; payload: unknown }> = [];
        try {
          if (fixture.kind === "gateway") {
            eventProbe = controlClientFor(fixture.gateway);
            eventProbe.onEvent = ({ event, payload }) => {
              probedEvents.push({ event, payload });
            };
            await startControlClient(eventProbe);
            await eventProbe.subscribeSessionEvents();
          }
          if (fixture.kind === "local") {
            await fixture.run.waitForOutput("local ready", LOCAL_STARTUP_TIMEOUT_MS);
          }
          await fixture.run.write("trigger malformed edit calls\r");
          await waitForModelRequests(fixture, 2, true);
          if (eventProbe) {
            await waitFor({
              timeoutMs: 30_000,
              read: () => {
                const observed = probedEvents.some((event) => {
                  if (event.event !== "session.tool" || !event.payload) {
                    return false;
                  }
                  const payload = event.payload as {
                    sessionKey?: unknown;
                    data?: Record<string, unknown>;
                  };
                  return (
                    payload.sessionKey === expectedGatewaySessionKey &&
                    typeof payload.data?.toolErrorSummary === "string"
                  );
                });
                return observed ? true : null;
              },
              onTimeout: () =>
                new Error(
                  `Gateway did not project a safe tool diagnostic (${probedEvents.length})`,
                ),
            });
          }
          await fixture.run.write("\u001b", { delay: false });
          if (fixture.kind === "gateway") {
            await fixture.waitForOutput("run aborted: edit tool validation failed:");
          } else {
            await fixture.run.waitForOutput(
              "run aborted: edit tool validation failed:",
              LOCAL_OUTPUT_TIMEOUT_MS,
            );
          }

          expect(fixture.mockModel.requests().length).toBeGreaterThanOrEqual(2);
          const caseOutput =
            fixture.kind === "gateway" ? fixture.visibleOutput() : fixture.run.visibleOutput();
          expect(caseOutput).not.toContain("Received arguments");

          if (fixture.kind === "local") {
            fixture.mockModel.allowValidResponses("gpt-5.5");
            const abortedRequestCount = fixture.mockModel.requests().length;
            await fixture.run.write("prompt after local validation abort\r");
            await waitForModelRequests(fixture, abortedRequestCount + 1, true);
            expect(JSON.stringify(fixture.mockModel.requests().at(-1)?.body)).toContain(
              "prompt after local validation abort",
            );
            await fixture.run.waitForOutput("LOCAL_PTY_RESPONSE", LOCAL_OUTPUT_TIMEOUT_MS);
            await exitTui(fixture.run);
          }
        } finally {
          await eventProbe?.stop();
          await fixture.cleanup();
        }
      },
      LOCAL_TEST_TIMEOUT_MS,
    );
  }

  registerValidationLoopTest("local");

  // Register every Gateway case inside the nested suite so targeted runs retain
  // the fixture's separate startup timeout.
  const gatewayTestRegistrations: Array<() => void> = [];
  function registerGatewayTest(name: string, run: TestFunction) {
    gatewayTestRegistrations.push(() => {
      it(name, run, LOCAL_TEST_TIMEOUT_MS);
    });
  }

  registerGatewayTest(
    "routes usage cost through Gateway chat.send without patching or invoking the model",
    async ({ onTestFinished }) => {
      const shared = await requireSharedGatewayFixture();
      const scenario = GATEWAY_SCENARIOS.command;
      const sessionKey = `agent:${scenario.agentId}:tui-pty-usage-cost`;
      await shared.controlClient.createSession({ key: sessionKey, agentId: scenario.agentId });
      const initialModelRequests = shared.mockModel.requests().length;
      const proxy = await startGatewayRpcDelayProxy(shared.gateway.url, []);
      const cleanupProxy = registerIdempotentCleanup(
        onTestFinished,
        async () => await proxy.stop(),
      );
      const fixture = await startIsolatedGatewayPty({
        gateway: shared.gateway,
        registerCleanup: onTestFinished,
        sessionKey,
        url: proxy.url,
      });
      try {
        await fixture.run.waitForOutput("gateway connected", LOCAL_STARTUP_TIMEOUT_MS);
        const requestOffset = proxy.requests.length;
        await fixture.run.write("/usage cost\r", { delay: false });
        await fixture.run.waitForOutput("Last 30d", LOCAL_OUTPUT_TIMEOUT_MS);

        const requests = proxy.requests.slice(requestOffset);
        expect(requests.filter((request) => request.method === "chat.send")).toEqual([
          expect.objectContaining({
            params: expect.objectContaining({ sessionKey, message: "/usage cost" }),
          }),
        ]);
        expect(requests.some((request) => request.method === "sessions.patch")).toBe(false);
        expect(shared.mockModel.requests()).toHaveLength(initialModelRequests);
      } finally {
        await fixture.cleanup();
        await cleanupProxy();
      }
    },
  );

  registerGatewayTest(
    "authenticates valid tokens and rejects invalid tokens through a real Gateway PTY",
    async ({ onTestFinished }) => {
      const shared = await requireSharedGatewayFixture();
      const agentId = SHARED_GATEWAY_AGENT_ID;
      const sessionKey = `agent:${agentId}:tui-pty-auth`;
      const invalidToken = "T02_INVALID_TOKEN_MUST_NOT_LEAK";
      await shared.controlClient.createSession({ key: sessionKey, agentId });
      const valid = await startIsolatedGatewayPty({
        gateway: shared.gateway,
        registerCleanup: onTestFinished,
        sessionKey,
      });
      const invalid = await startIsolatedGatewayPty({
        gateway: shared.gateway,
        registerCleanup: onTestFinished,
        sessionKey,
        token: invalidToken,
      });
      try {
        await valid.run.waitForOutput("gateway connected", LOCAL_STARTUP_TIMEOUT_MS);
        await invalid.run.waitForOutput("gateway token mismatch", LOCAL_STARTUP_TIMEOUT_MS);
        const output = `${valid.run.output()}\n${invalid.run.output()}\n${shared.gateway.logs()}`;
        for (const token of [shared.gateway.gatewayToken, invalidToken]) {
          expect(output.includes(token), "Gateway token leaked into captured output").toBe(false);
        }
      } finally {
        await Promise.all([valid.cleanup(), invalid.cleanup()]);
      }
    },
  );
  registerGatewayTest(
    "loads completed Gateway history on a fresh TUI attach before user input",
    async ({ onTestFinished }) => {
      const shared = await requireSharedGatewayFixture();
      const agentId = SHARED_GATEWAY_AGENT_ID;
      const sessionKey = `agent:${agentId}:tui-pty-history`;
      const runId = randomUUID();
      const userMarker = "T02_HISTORY_USER";
      const assistantMarker = GATEWAY_SCENARIOS.history.replyText;
      const model = `tui-pty-mock/${GATEWAY_SCENARIOS.history.modelId}`;
      const terminalObserver = createChatTerminalObserver();
      const historyClient = controlClientFor(shared.gateway);
      let historyClientConnected = false;
      historyClient.onConnected = () => {
        historyClientConnected = true;
      };
      historyClient.onEvent = terminalObserver.onEvent;
      const cleanup = registerIdempotentCleanup(onTestFinished, async () => {
        try {
          if (historyClientConnected) {
            await historyClient.abortChat({ sessionKey, runId });
          }
        } finally {
          await historyClient.stop();
        }
      });
      let attached: Awaited<ReturnType<typeof startIsolatedGatewayPty>> | undefined;
      try {
        await startControlClient(historyClient);
        await historyClient.subscribeSessionEvents();
        await historyClient.createSession({ key: sessionKey, agentId });
        await historyClient.patchSession({ key: sessionKey, agentId, model });
        await historyClient.sendChat({ sessionKey, message: userMarker, runId });
        await terminalObserver.waitForFinal({
          runId,
          sessionKey,
          timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
        });
        await waitForHistoryMessages(
          historyClient,
          sessionKey,
          ({ messages }) => findOrderedTurn(messages, userMarker, assistantMarker) >= 0,
        );
        attached = await startIsolatedGatewayPty({
          gateway: shared.gateway,
          registerCleanup: onTestFinished,
          sessionKey,
        });
        const attachedRun = attached.run;
        await attachedRun.waitForOutput(assistantMarker, LOCAL_STARTUP_TIMEOUT_MS);
        const output = await waitFor({
          timeoutMs: LOCAL_STARTUP_TIMEOUT_MS,
          read: () => {
            const screen =
              synchronizedFrameRows(attachedRun.output(), attachedRun)[0]?.join("\n") ?? "";
            return screen.includes(userMarker) && screen.includes(assistantMarker) ? screen : null;
          },
          onTimeout: () => new Error("history did not reach a final synchronized TUI screen"),
        });
        expect(output.split(userMarker)).toHaveLength(2);
        expect(output.split(assistantMarker)).toHaveLength(2);
        expect(output.indexOf(userMarker)).toBeLessThan(output.indexOf(assistantMarker));
      } finally {
        try {
          await attached?.cleanup();
        } finally {
          await cleanup();
        }
      }
    },
  );
  registerGatewayTest(
    "gates input while a real Gateway restores the remembered session and history",
    async ({ onTestFinished }) => {
      const shared = await requireSharedGatewayFixture();
      const scenario = GATEWAY_SCENARIOS.resume;
      const { agentId } = scenario;
      const sessionKey = `agent:${agentId}:tui-pty-resume-${++gatewaySessionSequence}`;
      const sessionLabel = sessionKey.split(":").at(-1)!;
      const initial: [string, string] = ["T03_RESUME_FIRST_PROMPT", scenario.replyText];
      const next: [string, string] = ["T03_RESUME_FOLLOWUP_PROMPT", scenario.followupReplyText!];
      const restoredMarkers = [`session ${sessionLabel}`, initial[0], scenario.replyText];
      const requestOffset = shared.mockModel.requests(scenario.modelId).length;
      const clientStateDir = await mkdtemp(path.join(tmpdir(), "openclaw-tui-pty-resume-client-"));
      onTestFinished(() => rm(clientStateDir, { recursive: true, force: true }));
      const controlClient = controlClientFor(shared.gateway);
      let controlClientConnected = false;
      controlClient.onConnected = () => {
        controlClientConnected = true;
      };
      controlClient.onDisconnected = () => {
        controlClientConnected = false;
      };
      const cleanup = registerIdempotentCleanup(onTestFinished, async () => {
        try {
          if (controlClientConnected) {
            await controlClient.abortChat({ sessionKey });
          }
        } finally {
          await controlClient.stop();
        }
      });
      await startControlClient(controlClient);
      await controlClient.createSession({ key: sessionKey, agentId });
      const model = `tui-pty-mock/${scenario.modelId}`;
      let terminalUpdatedAt = (
        await controlClient.patchSession({ key: sessionKey, agentId, model })
      ).entry.updatedAt as number;
      expect(terminalUpdatedAt).toEqual(expect.any(Number));
      const listParams = { agentId, search: sessionKey, limit: 5, activeMinutes: 60 };
      const historyParams = { sessionKey, limit: 100 };
      const waitForCheckpoint = async (after: number, turns: Array<[string, string]>) => {
        const deadline = Date.now() + LOCAL_OUTPUT_TIMEOUT_MS;
        for (; Date.now() < deadline; await sleep(250)) {
          const row = (await controlClient.listSessions(listParams)).sessions.find(
            ({ key }) => key === sessionKey,
          ) as { status?: unknown; hasActiveRun?: unknown; updatedAt?: unknown } | undefined;
          const updatedAt = row?.updatedAt;
          if (
            row?.status !== "done" ||
            row.hasActiveRun !== false ||
            typeof updatedAt !== "number" ||
            updatedAt <= after
          ) {
            continue;
          }
          const history = (await controlClient.loadHistory(historyParams)) as GatewayHistory;
          const { messages, sessionInfo } = history;
          expect(sessionInfo).toMatchObject({ status: "done", hasActiveRun: false });
          expect(typeof sessionInfo?.updatedAt).toBe("number");
          expect(sessionInfo?.updatedAt as number).toBeGreaterThanOrEqual(updatedAt);
          let cursor = -1;
          for (const [u, a] of turns) {
            expect((cursor = findOrderedTurn(messages, u, a, cursor))).toBeGreaterThanOrEqual(0);
          }
          return updatedAt;
        }
        throw new Error(`session ${sessionKey} did not reach a newer terminal state`);
      };
      const registerCleanup = onTestFinished;
      const ptyParams = { gateway: shared.gateway, registerCleanup, clientStateDir };
      const first = await startIsolatedGatewayPty({ ...ptyParams, sessionKey });
      try {
        await first.run.waitForOutput("gateway connected", LOCAL_STARTUP_TIMEOUT_MS);
        await first.run.waitForOutput(`session ${sessionLabel}`, LOCAL_STARTUP_TIMEOUT_MS);
        await first.run.write(`${initial[0]}\r`);
        await first.run.waitForOutput(scenario.replyText, LOCAL_OUTPUT_TIMEOUT_MS);
        terminalUpdatedAt = await waitForCheckpoint(terminalUpdatedAt, [initial]);
        await exitTui(first.run);
      } catch (error) {
        await cleanup();
        throw error;
      } finally {
        await first.cleanup();
      }
      const proxy = await startGatewayRpcDelayProxy(shared.gateway.url, [
        "sessions.list",
        "chat.history",
      ]);
      const cleanupProxy = registerIdempotentCleanup(onTestFinished, proxy.stop);
      await writeTuiLastSessionKey({
        scopeKey: buildTuiLastSessionScopeKey({
          connectionUrl: proxy.url,
          agentId,
          sessionScope: "per-sender",
        }),
        sessionKey,
        stateDir: clientStateDir,
      });
      const resumed = await startIsolatedGatewayPty({ ...ptyParams, url: proxy.url });
      try {
        await proxy.waitForRequest("sessions.list");
        const outputOffset = resumed.run.visibleOutput().length;
        await resumed.run.write(`${next[0]}\r`, { delay: false });
        const decision = await waitFor({
          timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
          read: () => {
            const sends = proxy.requests.filter(
              (request) => request.method === "chat.send" && request.params?.message === next[0],
            );
            const output = resumed.run.visibleOutput().slice(outputOffset);
            return sends.length > 0 ||
              output.includes("not connected to gateway — message not sent")
              ? { sends, output }
              : null;
          },
          onTimeout: () => new Error("startup followup was neither blocked nor sent"),
        });
        expect(decision.sends.map((request) => request.params)).toEqual([]);
        expect(decision.output).toContain("not connected to gateway — message not sent");

        proxy.release("sessions.list");
        await proxy.waitForRequest("chat.history");
        proxy.release("chat.history");
        await resumed.run.waitForOutput("gateway connected", LOCAL_STARTUP_TIMEOUT_MS);
        const restoredFrame = await waitForSynchronizedFrameRows(
          resumed.run,
          (rows) =>
            [...restoredMarkers, next[0]].every((marker) =>
              rows.some((row) => row.includes(marker)),
            ),
          LOCAL_OUTPUT_TIMEOUT_MS,
        );
        expect(restoredFrame.join("\n")).toContain(next[0]);
        await resumed.run.write("\r", { delay: false });
        await resumed.run.waitForOutput(scenario.followupReplyText, LOCAL_OUTPUT_TIMEOUT_MS);
        await waitForCheckpoint(terminalUpdatedAt, [initial, next]);
        const sends = proxy.requests.filter(
          (request) => request.method === "chat.send" && request.params?.message === next[0],
        );
        expect(sends.map((request) => request.params?.sessionKey)).toEqual([sessionKey]);
        const db = new DatabaseSync(
          path.join(shared.gateway.stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite"),
          { readOnly: true },
        );
        const sqliteRows = db
          .prepare(
            `SELECT node.session_key AS sessionKey, COUNT(*) AS eventCount
             FROM session_nodes AS node
             JOIN transcript_events AS event ON event.session_id = node.current_session_id
             WHERE event.event_json LIKE ?
             GROUP BY node.session_key
             ORDER BY node.session_key`,
          )
          .all(`%${next[0]}%`);
        db.close();
        expect(sqliteRows).toEqual([{ sessionKey, eventCount: 1 }]);
        const requests = shared.mockModel.requests(scenario.modelId).slice(requestOffset);
        expect(requests).toHaveLength(2);
        const secondRequestBody = JSON.stringify(requests[1]?.body);
        expect(secondRequestBody).toContain(initial[0]);
        expect(secondRequestBody).toContain(scenario.replyText);
        expect(secondRequestBody).toContain(next[0]);

        await exitTui(resumed.run);
      } finally {
        await cleanup();
        await resumed.cleanup();
        await cleanupProxy();
      }
    },
  );
  registerGatewayTest(
    "executes Gateway status model new and reset RPCs through a real TUI PTY",
    async ({ onTestFinished }) => {
      const fixture = await startGatewayModeTui("command", onTestFinished);
      const { controlClient, mockModel } = await requireSharedGatewayFixture();

      await fixture.run.write("/gateway-status\r", { delay: false });
      await fixture.waitForOutput("Default model: tui-pty-validation (128k ctx)");
      const newOffset = fixture.run.visibleOutput().length;
      await fixture.run.write("/new\r", { delay: false });
      await waitForOutputAfter(fixture.run, "new session: agent:", newOffset);
      const createdOutput = fixture.run.visibleOutput().slice(newOffset);
      const createdKey = createdOutput.match(/new session: (agent:\S+)/)?.[1];
      expect(createdKey).toBeDefined();
      expect(createdKey).not.toBe(fixture.sessionKey);
      fixture.trackSessionKey(createdKey!);
      const created = await waitForHistoryMessages(controlClient, createdKey!, ({ sessionInfo }) =>
        Boolean(sessionInfo?.sessionId),
      );
      const commandModel = `tui-pty-mock/${GATEWAY_SCENARIOS.command.modelId}`;
      const commandModelOffset = fixture.run.visibleOutput().length;
      await fixture.run.write(`/model ${commandModel}\r`, { delay: false });
      await waitForOutputAfter(fixture.run, `model set to ${commandModel}`, commandModelOffset);
      await waitForHistoryMessages(
        controlClient,
        createdKey!,
        ({ sessionInfo }) =>
          sessionInfo?.sessionId === created.sessionInfo?.sessionId &&
          [sessionInfo?.modelProvider, sessionInfo?.model].join("/") === commandModel,
      );
      const resetMarker = "T02_RESET_HISTORY";
      const seedReply = GATEWAY_SCENARIOS.command.replyText;
      await fixture.run.write(`${resetMarker}\r`, { delay: false });
      await fixture.waitForOutput(seedReply);
      const seeded = await waitForHistoryMessages(
        controlClient,
        createdKey!,
        ({ messages, sessionInfo }) =>
          Boolean(
            sessionInfo?.activeLeafEntryId &&
            sessionInfo?.sessionId === created.sessionInfo?.sessionId &&
            typeof sessionInfo?.updatedAt === "number" &&
            [sessionInfo?.modelProvider, sessionInfo?.model].join("/") === commandModel &&
            findOrderedTurn(messages, resetMarker, seedReply) >= 0,
          ),
      );
      const seededInfo = seeded.sessionInfo!;
      const alternateModel = `tui-pty-mock/${GATEWAY_SCENARIOS.reconnect.modelId}`;
      const modelOffset = fixture.run.visibleOutput().length;
      await fixture.run.write(`/model ${alternateModel}\r`, { delay: false });
      await waitForOutputAfter(fixture.run, `model set to ${alternateModel}`, modelOffset);
      const selected = await waitForHistoryMessages(
        controlClient,
        createdKey!,
        ({ sessionInfo }) =>
          sessionInfo?.sessionId === seededInfo.sessionId &&
          typeof sessionInfo?.updatedAt === "number" &&
          (sessionInfo?.updatedAt as number) >= (seededInfo.updatedAt as number) &&
          Boolean(sessionInfo?.activeLeafEntryId) &&
          [sessionInfo?.modelProvider, sessionInfo?.model].join("/") === alternateModel,
      );
      const selectedInfo = selected.sessionInfo!;
      await fixture.run.write("/reset\r", { delay: false });
      await fixture.waitForOutput(`session ${createdKey} reset`);
      const reset = await waitForHistoryMessages(
        controlClient,
        createdKey!,
        ({ messages, sessionInfo }) =>
          sessionInfo?.sessionId === selectedInfo.sessionId &&
          typeof sessionInfo?.updatedAt === "number" &&
          (sessionInfo?.updatedAt as number) >= (selectedInfo.updatedAt as number) &&
          Boolean(sessionInfo?.activeLeafEntryId) &&
          sessionInfo?.activeLeafEntryId !== selectedInfo.activeLeafEntryId &&
          [sessionInfo?.modelProvider, sessionInfo?.model].join("/") === alternateModel &&
          messages.every(
            (message) => ![resetMarker, seedReply].includes(extractTextFromMessage(message).trim()),
          ),
      );
      const postMarker = "T02_POST_RESET";
      const postOffset = fixture.run.visibleOutput().length;
      await fixture.run.write(`${postMarker}\r`, { delay: false });
      await waitForOutputAfter(fixture.run, GATEWAY_SCENARIOS.reconnect.replyText, postOffset);
      await waitForHistoryMessages(controlClient, createdKey!, ({ messages, sessionInfo }) => {
        return (
          Boolean(sessionInfo?.activeLeafEntryId) &&
          sessionInfo?.sessionId === selectedInfo.sessionId &&
          typeof sessionInfo?.updatedAt === "number" &&
          (sessionInfo?.updatedAt as number) >= (reset.sessionInfo?.updatedAt as number) &&
          sessionInfo?.activeLeafEntryId !== reset.sessionInfo?.activeLeafEntryId &&
          [sessionInfo?.modelProvider, sessionInfo?.model].join("/") === alternateModel &&
          messages.every(
            (message) => ![resetMarker, seedReply].includes(extractTextFromMessage(message).trim()),
          ) &&
          findOrderedTurn(messages, postMarker, GATEWAY_SCENARIOS.reconnect.replyText) >= 0
        );
      });
      const postRequest = JSON.stringify(
        mockModel.requests(GATEWAY_SCENARIOS.reconnect.modelId).at(-1)?.body,
      );
      expect(postRequest).toContain(postMarker);
      expect(postRequest).not.toContain(resetMarker);
      expect(postRequest).not.toContain(seedReply);
    },
  );
  registerGatewayTest(
    "preserves a disconnected draft across a real Gateway restart",
    async ({ onTestFinished }) => {
      const fixture = await startGatewayModeTui("reconnect", onTestFinished);
      let gatewayStopped = false;
      try {
        const disconnectOffset = fixture.run.visibleOutput().length;
        await fixture.gateway.stopGateway();
        gatewayStopped = true;
        await waitForOutputAfter(fixture.run, "gateway disconnected", disconnectOffset);

        await fixture.run.write("send preserved draft after restart\r");
        await fixture.waitForOutput("not connected to gateway — message not sent");
        expect(fixture.mockModel.requests()).toHaveLength(0);

        const reconnectOffset = fixture.run.visibleOutput().length;
        await fixture.gateway.startGateway();
        gatewayStopped = false;
        await waitForOutputAfter(fixture.run, "gateway reconnected", reconnectOffset);
        await waitForOutputAfter(
          fixture.run,
          "gateway reconnected after transport loss",
          reconnectOffset,
        );
        await fixture.run.write("\r", { delay: false });
        await waitForModelRequests(fixture, 1);
        expect(JSON.stringify(fixture.mockModel.requests()[0]?.body)).toContain(
          "send preserved draft after restart",
        );
        await fixture.waitForOutput("RECONNECTED_RUN_COMPLETE");
      } finally {
        if (gatewayStopped) {
          await fixture.gateway.startGateway();
        }
        await fixture.cleanup();
      }
    },
  );

  registerGatewayTest(
    "renders messages sent by another real Gateway client without restarting",
    async ({ onTestFinished }) => {
      const fixture = await startGatewayModeTui("crossClient", onTestFinished);
      let externalClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
      try {
        await fixture.run.write("seed cross-client session\r");
        await fixture.waitForOutput("FIRST_RUN_ACTIVE");
        const firstReplyOffset = fixture.lastOutputIndex("FIRST_RUN_ACTIVE");
        await waitForOutputAfter(fixture.run, "| idle", firstReplyOffset);
        const connectedExternalClient = await connectGatewayClient({
          url: fixture.gateway.url,
          token: fixture.gateway.gatewayToken,
          scopes: ["operator.read", "operator.write"],
          clientDisplayName: "tui-external-session-writer",
        });
        externalClient = connectedExternalClient;

        const marker = "EXTERNAL_GATEWAY_SESSION_MESSAGE";
        await requestWithUnavailableRetry(
          async () =>
            await connectedExternalClient.request("sessions.send", {
              key: fixture.sessionKey,
              message: marker,
              idempotencyKey: `${fixture.sessionKey}:external-message`,
              timeoutMs: 30_000,
            }),
        );

        await fixture.waitForOutput(marker);
        await fixture.waitForOutput("FOLLOWUP_RUN_COMPLETE");
        const followupOffset = fixture.lastOutputIndex("FOLLOWUP_RUN_COMPLETE");
        await waitForOutputAfter(fixture.run, "| idle", followupOffset);
      } finally {
        await externalClient?.stopAndWait({ timeoutMs: 1_000 });
      }
    },
  );

  registerGatewayTest(
    "forwards an active-run prompt through the real Gateway followup queue",
    async ({ onTestFinished }) => {
      const fixture = await startGatewayModeTui("followup", onTestFinished);

      await fixture.run.write("slow first turn\r");
      await waitForModelRequests(fixture, 1);

      const followupOffset = fixture.run.visibleOutput().length;
      await fixture.run.write("queued followup turn\r");
      await waitForOutputAfter(fixture.run, "queued followup turn", followupOffset);
      // Keep the provider held while the echoed input crosses TUI submission.
      await sleep(SUBMISSION_SETTLE_MS);
      fixture.mockModel.releaseFirstResponse();
      await waitForModelRequests(fixture, 2);
      await fixture.waitForOutput("FOLLOWUP_RUN_COMPLETE");
      const completedOffset = fixture.lastOutputIndex("FOLLOWUP_RUN_COMPLETE");

      await fixture.run.write("turn after queued followup\r");
      await waitForModelRequests(fixture, 3);
      expect(JSON.stringify(fixture.mockModel.requests()[2]?.body)).toContain(
        "turn after queued followup",
      );
      const nextResponseOffset = completedOffset + "FOLLOWUP_RUN_COMPLETE".length;
      await waitForOutputAfter(fixture.run, "FOLLOWUP_RUN_COMPLETE", nextResponseOffset);
      const finalResponseOffset = lastOutputIndexAfter(
        fixture.run,
        "FOLLOWUP_RUN_COMPLETE",
        nextResponseOffset,
      );
      await waitForOutputAfter(fixture.run, "| idle", finalResponseOffset);
    },
  );

  registerGatewayTest(
    "renders a non-deliverable direct reply failure through the real Gateway and TUI",
    async ({ onTestFinished }) => {
      const fixture = await startGatewayModeTui("emptyReply", onTestFinished);
      const failureText = "No answer was returned. Ask again if you still need one.";
      const chatEvents: unknown[] = [];
      fixture.controlClient.onEvent = ({ event, payload }) => {
        if (event === "chat") {
          chatEvents.push(payload);
        }
      };

      await fixture.run.write("non-deliverable first turn\r");
      await waitForModelRequests(fixture, 1);

      await waitFor({
        timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
        read: () => (fixture.visibleOutput().includes(failureText) ? true : null),
        onTimeout: () =>
          new Error(
            `empty-reply fallback was not rendered\nchatEvents=${JSON.stringify(chatEvents)}\nrequests=${JSON.stringify(
              fixture.mockModel.requests(),
              null,
              2,
            )}\n${fixture.gateway.logs()}\n${fixture.run.output()}`,
          ),
      });
      expect(fixture.mockModel.requests()).toHaveLength(1);
      // Final filtering does not erase text already streamed into the PTY history.
      expect(chatEvents).toContainEqual(
        expect.objectContaining({
          sessionKey: fixture.sessionKey,
          state: "error",
          errorMessage: failureText,
        }),
      );

      await fixture.run.write("turn after empty reply\r");
      await waitForModelRequests(fixture, 2);
      await fixture.waitForOutput("FOLLOWUP_RUN_COMPLETE");
      expect(fixture.mockModel.requests()).toHaveLength(2);
      expect(JSON.stringify(fixture.mockModel.requests()[1]?.body)).toContain(
        "turn after empty reply",
      );
    },
  );

  registerGatewayTest(
    "cancels an admitted followup with Esc before it reaches the model",
    async ({ onTestFinished }) => {
      const fixture = await startGatewayModeTui("cancel", onTestFinished);

      await fixture.run.write("slow turn to abort\r");
      await waitForModelRequests(fixture, 1);
      const followupOffset = fixture.run.visibleOutput().length;
      await fixture.run.write("must never reach model\r");
      await waitForOutputAfter(fixture.run, "must never reach model", followupOffset);
      await sleep(SUBMISSION_SETTLE_MS);
      await fixture.run.write("\u001b", { delay: false });
      await fixture.waitForOutput("aborted");
      fixture.mockModel.releaseFirstResponse();
      // Abort has cleared the queue; keep only a short window for a stray provider request.
      await sleep(250);

      expect(fixture.mockModel.requests()).toHaveLength(1);
      expect(fixture.run.visibleOutput().slice(followupOffset)).not.toContain(
        "FOLLOWUP_RUN_COMPLETE",
      );
    },
  );

  registerGatewayTest(
    "preserves separate authorized TUI-client turns in FIFO order under collect mode",
    async ({ onTestFinished }) => {
      const fixture = await startGatewayModeTui("collect", onTestFinished);
      const queueClient = controlClientFor(fixture.gateway);
      try {
        const terminalObserver = createChatTerminalObserver();
        queueClient.onEvent = terminalObserver.onEvent;
        await startControlClient(queueClient);
        await queueClient.subscribeSessionEvents();
        await fixture.run.write("/queue collect debounce:250ms\r", { delay: false });
        await fixture.waitForOutput("Queue mode set to collect.");
        await fixture.run.write("slow collect parent\r");
        await waitForModelRequests(fixture, 1);
        // Each authenticated turn retains its own skill-authoring capability.
        // Admit alpha before submitting beta so the test observes a defined FIFO order.
        for (const message of ["collect prompt alpha", "collect prompt beta"]) {
          const result = await queueClient.sendChat({ sessionKey: fixture.sessionKey, message });
          expect(result.status).toBe("started");
          await terminalObserver.waitForFinal({
            runId: result.runId,
            sessionKey: fixture.sessionKey,
            timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
            onTimeout: () =>
              new Error(
                `queued prompt was not admitted: expected ${result.runId}; ` +
                  `observed ${JSON.stringify(terminalObserver.readFinals(fixture.sessionKey))}\n${fixture.gateway.logs()}\n` +
                  fixture.run.output(),
              ),
          });
        }
        fixture.mockModel.releaseFirstResponse();
        await waitFor({
          timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
          read: () =>
            fixture.mockModel.requests().length === 3 &&
            terminalObserver
              .readFinals(fixture.sessionKey)
              .filter((terminal) =>
                extractTextFromMessage(terminal.message).includes("FOLLOWUP_RUN_COMPLETE"),
              ).length === 2
              ? true
              : null,
          onTimeout: () =>
            new Error(
              `queued prompts did not both complete\n${fixture.gateway.logs()}\n${fixture.run.output()}`,
            ),
        });
        await fixture.waitForOutput("FOLLOWUP_RUN_COMPLETE");
        const completedOffset = fixture.lastOutputIndex("FOLLOWUP_RUN_COMPLETE");
        await waitForOutputAfter(fixture.run, "| idle", completedOffset);

        const requests = fixture.mockModel.requests();
        expect(
          requests,
          `collect emitted ${requests.length} model requests\n${JSON.stringify(
            requests.map((request) => request.body.input),
            null,
            2,
          )}\n${fixture.gateway.logs()}`,
        ).toHaveLength(3);
        const alphaBody = JSON.stringify(requests[1]?.body);
        expect(alphaBody).toContain("collect prompt alpha");
        expect(alphaBody).not.toContain("collect prompt beta");
        expect(JSON.stringify(requests[2]?.body)).toContain("collect prompt beta");
      } finally {
        await queueClient.stop();
        await fixture.cleanup();
      }
    },
  );

  describe("with shared Gateway fixture", () => {
    beforeAll(async () => {
      const startup = startSharedGatewayFixture();
      sharedGatewayFixtureStartup = startup;
      await startup;
    }, LOCAL_TEST_TIMEOUT_MS);

    afterAll(async () => {
      const startup = sharedGatewayFixtureStartup;
      sharedGatewayFixtureStartup = undefined;
      await cleanupStartedFixture(startup);
    }, LOCAL_TEST_TIMEOUT_MS);

    it("launches openclaw tui against a real Gateway through a real PTY", async () => {
      const fixture = await requireSharedGatewayFixture();
      expect(fixture.run.visibleOutput()).toContain("gateway connected");
    });

    for (const register of gatewayTestRegistrations) {
      register();
    }
    // Validation abort can terminalize the TUI before the embedded command lanes
    // finish unwinding. Keep it last so shared-Gateway teardown owns that tail.
    registerValidationLoopTest("gateway");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
