// Exercises slower TUI PTY paths against real local and Gateway backends.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as waitForProcessTick } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, type TestFunction } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../test/helpers/openclaw-test-instance.js";
import { isProcessAlive } from "../../test/helpers/process-wait.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { reloadSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import { loadAuthProfileStoreForRuntime } from "../agents/auth-profiles/store-runtime.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildOpenAiResponsesTestModel } from "../gateway/test-openai-responses-model.js";
import { listUsageCountedTranscriptStats } from "../infra/session-cost-usage-collection.test-support.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { withEnv, withEnvAsync } from "../test-utils/env.js";
import { killPidIfAlive } from "../test-utils/process-tree.js";
import { sleep } from "../utils/sleep.js";
import { GatewayChatClient } from "./gateway-chat.js";
import { extractTextFromMessage } from "./tui-formatters.js";
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

type MockModelServer = {
  baseUrl: string;
  requests: (modelId?: string) => MockModelRequest[];
  releaseFirstResponse: (modelId: string) => void;
  stop: () => Promise<void>;
};

type MockModelBehavior = {
  replyText: string;
  holdFirstResponse?: boolean;
  followupReplyText?: string;
};

type MockModelRequest = {
  authorization?: string;
  body: Record<string, unknown>;
};

type GatewayScenario = MockModelBehavior & {
  agentId: string;
  modelId: string;
};

const SHARED_GATEWAY_AGENT_ID = "tui-pty-gateway";
// These cases spawn openclaw.mjs outside the source TUI runner. CI opts in only
// after the exact head has a complete build, so source-mode PTY smoke must skip them.
const itWithBuiltCli = process.env.OPENCLAW_TUI_PTY_USE_BUILT_CLI === "1" ? it : it.skip;

function gatewayScenario(id: string): GatewayScenario;
function gatewayScenario<T extends Partial<GatewayScenario>>(
  id: string,
  overrides: T,
): GatewayScenario & T;
function gatewayScenario(id: string, overrides: Partial<GatewayScenario> = {}): GatewayScenario {
  return {
    agentId: SHARED_GATEWAY_AGENT_ID,
    modelId: `tui-pty-${id}`,
    replyText: "FIRST_RUN_ACTIVE",
    ...overrides,
  };
}
const followup = { holdFirstResponse: true, followupReplyText: "FOLLOWUP_RUN_COMPLETE" };
const GATEWAY_SCENARIOS = {
  history: gatewayScenario("history", { replyText: "T02_HISTORY_ASSISTANT" }),
  followup: gatewayScenario("followup", followup),
  reconnect: gatewayScenario("reconnect", { replyText: "RECONNECTED_RUN_COMPLETE" }),
};

type GatewayScenarioId = keyof typeof GATEWAY_SCENARIOS;

const LOCAL_STARTUP_TIMEOUT_MS = 60_000;
const LOCAL_OUTPUT_TIMEOUT_MS = 120_000;
const LOCAL_EXIT_TIMEOUT_MS = 4_000;
const LOCAL_TEST_TIMEOUT_MS = 150_000;
const SUBMISSION_SETTLE_MS = 150;

async function waitForModelRequests(
  fixture: {
    run: PtyRun;
    mockModel: { requests: () => MockModelRequest[] };
    gateway?: { logs: () => string };
  },
  count: number,
) {
  await waitFor({
    timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
    read: () => (fixture.mockModel.requests().length === count ? true : null),
    onTimeout: () =>
      new Error(
        `expected ${count} model requests\nrequests=${JSON.stringify(fixture.mockModel.requests())}\n${fixture.gateway?.logs() ?? ""}\n${fixture.run.output()}`,
      ),
  });
}

type CleanupRegistrar = (cleanup: () => Promise<void>) => void;
const writeJsonFixture = (file: string, value: unknown) =>
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");

async function writeResponsesSse(
  res: ServerResponse,
  text: string,
  completionGate?: Promise<void>,
) {
  await completionGate;
  if (!res.destroyed) {
    writeOpenAiResponsesText(res, {
      text,
      messageId: "msg_tui_pty_local",
      responseId: "resp_tui_pty_local",
    });
  }
}

async function readJsonRequest(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRequestBody(req);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function startRoutedMockModelServer(
  behaviors: Readonly<Record<string, MockModelBehavior>>,
): Promise<MockModelServer> {
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
          data: Object.keys(behaviors).map((id) => ({
            id,
            object: "model",
          })),
        });
        return;
      }
      if (req.method === "POST") {
        const body = await readJsonRequest(req);
        if (url.pathname === "/v1/responses" || url.pathname === "/responses") {
          const modelId = typeof body.model === "string" ? body.model : "";
          const request = {
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
    requests: (modelId) => (modelId ? (requestsByModel.get(modelId) ?? []) : requests),
    releaseFirstResponse: (modelId) => {
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
    models: modelIds.map((id) => buildOpenAiResponsesTestModel(id)),
  };
}

function buildLocalModeConfig(params: { workspaceDir: string; providerBaseUrl: string }) {
  return {
    plugins: {
      enabled: false,
      slots: {
        memory: "none",
      },
    },
    agents: {
      defaults: {
        workspace: params.workspaceDir,
        model: { primary: "tui-pty-mock/gpt-5.5" },
        models: {
          "tui-pty-mock/gpt-5.5": { agentRuntime: { id: "openclaw" } },
        },
        skills: [],
        skipBootstrap: true,
      },
      entries: {
        main: {
          skills: [],
          model: { primary: "tui-pty-mock/gpt-5.5" },
        },
      },
    },
    tools: {
      profile: "minimal",
    },
    models: {
      mode: "replace",
      providers: {
        "tui-pty-mock": buildMockModelProvider(params.providerBaseUrl, ["gpt-5.5"]),
      },
    },
    gateway: {
      mode: "local",
      auth: { mode: "token", token: "tui-pty-local" },
    },
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
    "gpt-5.5": { replyText, followupReplyText: opts.followupReplyText },
  });
  let config: OpenClawConfig = buildLocalModeConfig({
    workspaceDir,
    providerBaseUrl: mockModel.baseUrl,
  });
  let run: PtyRun;
  try {
    config =
      (await opts.prepareConfig?.({
        config,
        tempDir,
        stateDir,
      })) ?? config;
    env = (await opts.prepareEnv?.({ env, tempDir, stateDir })) ?? env;
    await Promise.all([
      mkdir(workspaceDir, { recursive: true }),
      mkdir(homeDir, { recursive: true }),
      mkdir(stateDir, { recursive: true }),
      mkdir(xdgConfigHome, { recursive: true }),
      mkdir(xdgDataHome, { recursive: true }),
      mkdir(xdgCacheHome, { recursive: true }),
      writeJsonFixture(configPath, config),
    ]);

    run = await startRuntimePty(
      process.execPath,
      await buildTuiProcessArgs(opts.cliArgs ?? ["tui", "--local"]),
      {
        cwd: process.cwd(),
        env,
        exitTimeoutMs: LOCAL_EXIT_TIMEOUT_MS,
        outputTimeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
      },
    );
  } catch (error) {
    return await runQaGatewayFixture(
      async (): Promise<never> => {
        throw error;
      },
      () => cleanupLocalModeResources({ mockModel, tempDir }),
    );
  }

  const cleanup = createIdempotentCleanup(async () => {
    await cleanupLocalModeResources({ run, mockModel, tempDir });
  });
  registerCleanup(cleanup);
  return {
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
  const defaultScenario = GATEWAY_SCENARIOS.history;
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
        systemAgent: { agentId: defaultScenario.agentId },
        authInheritance: { agentId: defaultScenario.agentId },
      },
      entries: {
        [defaultScenario.agentId]: {
          workspace: path.join(params.tempDir, defaultScenario.agentId),
          skills: [],
          model: { primary: defaultModelRef },
          tools: { profile: "minimal" },
        },
      },
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
    messages: {
      queue: {
        mode: "followup",
      },
    },
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
    await mkdir(path.join(tempDir, SHARED_GATEWAY_AGENT_ID), { recursive: true });
    mockModel = await startRoutedMockModelServer(
      Object.fromEntries(scenarios.map((scenario) => [scenario.modelId, scenario])),
    );
    gateway = await createOpenClawTestInstance({
      name: "tui-pty-shared-gateway",
      gatewayToken: "tui-pty-local",
      config: buildGatewayModeConfig({ tempDir, providerBaseUrl: mockModel.baseUrl }),
      env: {
        OPENCLAW_CODEX_DISCOVERY_LIVE: "0",
        OPENCLAW_SKIP_PROVIDERS: undefined,
      },
    });
    await gateway.startGateway();

    let controlClientConnected = false;
    controlClient = new GatewayChatClient({
      url: gateway.url,
      token: gateway.gatewayToken,
    });
    controlClient.onConnected = () => {
      controlClientConnected = true;
    };
    controlClient.start();
    await waitFor({
      timeoutMs: LOCAL_STARTUP_TIMEOUT_MS,
      read: () => (controlClientConnected ? true : null),
      onTimeout: () => new Error("shared Gateway control client did not connect"),
    });

    const initialScenario = GATEWAY_SCENARIOS.history;
    const initialSessionKey = `agent:${initialScenario.agentId}:tui-pty-shared`;
    await controlClient.createSession({
      key: initialSessionKey,
      agentId: initialScenario.agentId,
    });
    run = await startRuntimePty(
      process.execPath,
      await buildTuiProcessArgs([
        "tui",
        "--url",
        gateway.url,
        "--token",
        gateway.gatewayToken,
        "--session",
        initialSessionKey,
      ]),
      {
        cwd: process.cwd(),
        env: {
          ...gateway.env,
          OPENCLAW_THEME: "dark",
          NO_COLOR: undefined,
        },
        exitTimeoutMs: LOCAL_EXIT_TIMEOUT_MS,
        outputTimeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
      },
    );
    await run.waitForOutput("gateway connected", LOCAL_STARTUP_TIMEOUT_MS);

    const fixtureGateway = gateway;
    const fixtureMockModel = mockModel;
    const fixtureControlClient = controlClient;
    const fixtureRun = run;
    const cleanup = createIdempotentCleanup(() =>
      runQaGatewayFixture(
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
    return await runQaGatewayFixture(
      async (): Promise<never> => {
        throw error;
      },
      () => run?.dispose(),
      () => controlClient?.stop(),
      () => gateway?.cleanup(),
      () => mockModel?.stop(),
      () => rm(tempDir, { recursive: true, force: true }),
    );
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
  const controlClient = new GatewayChatClient({
    url: shared.gateway.url,
    token: shared.gateway.gatewayToken,
  });
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
    agentId: scenario.agentId,
    sessionKey,
    outputOffset,
    waitForOutput: async (needle: string, timeoutMs = LOCAL_OUTPUT_TIMEOUT_MS) =>
      await waitForOutputAfter(run, needle, outputOffset, timeoutMs),
    visibleOutput: () => run.visibleOutput().slice(outputOffset),
    lastOutputIndex: (needle: string) => lastOutputIndexAfter(run, needle, outputOffset),
    cleanup,
  };
}

async function startIsolatedGatewayPty(params: {
  gateway: OpenClawTestInstance;
  registerCleanup: CleanupRegistrar;
  sessionKey?: string;
  token?: string;
}) {
  const { gateway, registerCleanup, sessionKey, token = gateway.gatewayToken } = params;
  const tempDir = await mkdtemp(path.join(tmpdir(), "openclaw-tui-pty-gateway-client-"));
  let run: PtyRun;
  try {
    await writeFile(path.join(tempDir, "openclaw.json"), "{}\n", "utf8");
    const cliArgs = ["tui", "--url", gateway.url, "--token", token];
    if (sessionKey) {
      cliArgs.push("--session", sessionKey);
    }
    run = await startRuntimePty(process.execPath, await buildTuiProcessArgs(cliArgs), {
      cwd: process.cwd(),
      env: {
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
      },
      exitTimeoutMs: LOCAL_EXIT_TIMEOUT_MS,
      outputTimeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
    });
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
  const cleanup = createIdempotentCleanup(async () => {
    try {
      await run.dispose();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
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
        const prompt =
          alias === "terminal" ? "!literal initial message" : "message through chat alias";
        const cliModelId = "claude-sonnet-5";
        const cliModelRef = `claude-cli/${cliModelId}`;
        const canonicalModelRef = `anthropic/${cliModelId}`;
        const fixture = await startLocalModeTui(onTestFinished, {
          cliArgs: alias === "terminal" ? [alias, "--message", prompt] : [alias],
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
                        models: {
                          ...config.agents?.defaults?.models,
                          [cliModelRef]: {},
                        },
                      },
                    },
                    models: {
                      ...config.models,
                      providers: {
                        ...config.models?.providers,
                        "claude-cli": cliProvider,
                      },
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
          await fixture.run.write(`${prompt}\r`);
        }
        await waitForModelRequests(fixture, 1);
        expect(JSON.stringify(fixture.mockModel.requests()[0]?.body)).toContain(prompt);
        await fixture.run.waitForOutput(replyText, LOCAL_OUTPUT_TIMEOUT_MS);
        await fixture.run.write("/exit\r", { delay: false });
        const exitCode = (await fixture.run.waitForExit()).exitCode;
        expect(exitCode).toBe(0);
      },
      LOCAL_TEST_TIMEOUT_MS,
    );
  }

  it(
    "rejects Gateway options on a local TUI alias through a real PTY",
    async ({ onTestFinished }) => {
      const run = await startRuntimePty(
        process.execPath,
        await buildTuiProcessArgs(["chat", "--url", "ws://127.0.0.1:1"]),
        {
          cwd: process.cwd(),
          env: {
            OPENCLAW_THEME: "dark",
            NO_COLOR: undefined,
          },
          exitTimeoutMs: LOCAL_EXIT_TIMEOUT_MS,
          outputTimeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
        },
      );
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

  it(
    "prints local usage costs without submitting a model request",
    async ({ onTestFinished }) => {
      const agentId = "main";
      const sessionKey = `agent:${agentId}:usage-cost-unpersisted`;
      const fixture = await startLocalModeTui(onTestFinished, {
        cliArgs: ["tui", "--local", "--session", sessionKey],
      });
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId, env: fixture.env });
      const selectedSession = { agentId, sessionKey, storePath: databasePath };
      await fixture.run.waitForOutput("local ready", LOCAL_STARTUP_TIMEOUT_MS);
      withEnv(fixture.env, () => {
        // An empty existing row still makes the direct Session reader wait.
        expect(loadSessionEntry(selectedSession)).toBeUndefined();
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
      expect(text).toContain("Session n/a Today $0.0000 Last 30d $0.0000");
      expect(fixture.mockModel.requests()).toHaveLength(0);
      withEnv(fixture.env, () => {
        expect(loadSessionEntry(selectedSession)).toBeUndefined();
      });
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
      const freshRequest = JSON.stringify(fixture.mockModel.requests()[1]?.body);
      expect(freshRequest).toContain("T03_HISTORY_SECOND_PROMPT");
      expect(freshRequest).not.toContain("T03_HISTORY_FIRST_PROMPT");
      await fixture.run.write("\u001b", { delay: false });
      await waitForSynchronizedFrameRows(fixture.run, pickerClosed, LOCAL_EXIT_TIMEOUT_MS);
      await fixture.run.write("/exit\r", { delay: false });
      expect((await fixture.run.waitForExit()).exitCode).toBe(0);
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

        await fixture.run.write("/exit\r", { delay: false });
        expect((await fixture.run.waitForExit()).exitCode).toBe(0);
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
        await fixture.run.waitForOutput("Allow local shell commands for this session?");
        await fixture.run.write("\u001b[B\r", { delay: false });
        await fixture.run.waitForOutput("local shell: enabled for this session");
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

        await fixture.run.write("/exit\r", { delay: false });
        expect((await fixture.run.waitForExit()).exitCode).toBe(1);
      } finally {
        trackedPids.forEach(killPidIfAlive);
        await fixture.cleanup();
      }
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
            writeJsonFixture(path.join(pluginDir, "package.json"), {
              name: "@openclaw/t05-local-auth-fixture",
              version: "0.0.0",
              type: "module",
              openclaw: { extensions: ["./index.js"] },
            }),
            writeJsonFixture(path.join(pluginDir, "openclaw.plugin.json"), {
              id: pluginId,
              name: "T05 Local Auth Fixture",
              providers: [providerId],
              setup: {
                providers: [{ id: providerId, envVars: ["T05_LOCAL_AUTH_API_KEY"] }],
              },
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
              configSchema: {
                type: "object",
                additionalProperties: false,
                properties: {},
              },
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
      await reloadSharedAuthStoreOwnership({
        ...process.env,
        OPENCLAW_STATE_DIR: fixture.stateDir,
      });
      const store = withEnv({ OPENCLAW_STATE_DIR: fixture.stateDir }, () => {
        return loadAuthProfileStoreForRuntime(agentDir, {
          readOnly: true,
          syncExternalCli: false,
        });
      });
      const profile = store?.profiles[profileId];
      expect(profile?.type === "api_key").toBe(true);
      expect(profile?.provider === providerId).toBe(true);
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

      await fixture.run.write("/exit\r", { delay: false });
      expect((await fixture.run.waitForExit()).exitCode).toBe(0);
    },
    LOCAL_TEST_TIMEOUT_MS,
  );

  // Register every Gateway case inside the nested suite so targeted runs retain
  // the fixture's separate startup timeout.
  const gatewayTestRegistrations: Array<() => void> = [];
  function registerGatewayTest(name: string, run: TestFunction, timeoutMs: number) {
    gatewayTestRegistrations.push(() => {
      it(name, run, timeoutMs);
    });
  }

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
    LOCAL_TEST_TIMEOUT_MS,
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
      const historyClient = new GatewayChatClient({
        url: shared.gateway.url,
        token: shared.gateway.gatewayToken,
      });
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
        historyClient.start();
        await waitFor({
          timeoutMs: LOCAL_STARTUP_TIMEOUT_MS,
          read: () => (historyClientConnected ? true : null),
          onTimeout: () => new Error("history Gateway client did not connect"),
        });
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
    LOCAL_TEST_TIMEOUT_MS,
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
    LOCAL_TEST_TIMEOUT_MS,
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
    LOCAL_TEST_TIMEOUT_MS,
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

    for (const register of gatewayTestRegistrations) {
      register();
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
