// Isolated cron Codex app-server tests cover the reporter path without mocking the runner.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCodexAttemptThread } from "../../extensions/codex/src/app-server/attempt-startup.js";
import {
  resolveCodexAppServerRuntimeOptions,
  type CodexPluginConfig,
} from "../../extensions/codex/src/app-server/config.js";
import { clearSharedCodexAppServerClient } from "../../extensions/codex/src/app-server/shared-client.js";
import { createClientHarness } from "../../extensions/codex/src/app-server/test-support.js";
import { withTimeout } from "../../extensions/codex/src/app-server/timeout.js";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../agents/auth-profiles/store.js";
import {
  clearAgentHarnesses,
  registerAgentHarness,
  restoreRegisteredAgentHarnesses,
  listRegisteredAgentHarnesses,
} from "../agents/harness/registry.js";
import type { AgentHarness } from "../agents/harness/types.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  makeCfg,
  makeJob,
  withTempCronHome,
  writeSessionStoreEntries,
} from "./isolated-agent.test-harness.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent/run.js";

const loadModelCatalogMock = vi.hoisted(() => vi.fn<() => Promise<ModelCatalogEntry[]>>());
const runCliAgentMock = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error("unexpected CLI agent path for Codex app-server cron proof");
  }),
);

vi.mock("./isolated-agent/run-model-catalog.runtime.js", () => ({
  loadModelCatalog: loadModelCatalogMock,
}));

vi.mock("./isolated-agent/run-model-selection.runtime.js", async () => ({
  ...(await vi.importActual<typeof import("./isolated-agent/run-model-selection.runtime.js")>(
    "./isolated-agent/run-model-selection.runtime.js",
  )),
  loadModelCatalog: loadModelCatalogMock,
}));

vi.mock("../agents/harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: vi.fn(),
}));

vi.mock("./isolated-agent/run-execution-cli.runtime.js", () => ({
  getCliSessionId: vi.fn(),
  runCliAgent: runCliAgentMock,
}));

const OPENAI_MODEL = "gpt-5.5";
const OPENAI_PROFILE_ID = "openai-codex:default";
const OPENAI_DEFAULT_PROFILE_ID = "openai:default";
const HARNESS_REQUEST_TIMEOUT_MS = 15_000;

const CODEX_PLUGIN_CONFIG: CodexPluginConfig = {
  appServer: { command: "codex" },
  computerUse: { enabled: false },
};

const bundleMcpThreadConfig = {
  configPatch: undefined,
  diagnostics: [],
  evaluated: false,
  fingerprint: undefined,
} satisfies Parameters<typeof startCodexAttemptThread>[0]["bundleMcpThreadConfig"];

type ClientHarness = ReturnType<typeof createClientHarness>;
type AgentHarnessAttemptParams = Parameters<AgentHarness["runAttempt"]>[0];
type AgentHarnessAttemptResult = Awaited<ReturnType<AgentHarness["runAttempt"]>>;

function readHarnessMessages(writes: string[]): Array<{ id?: number; method?: string }> {
  return writes.map((write) => JSON.parse(write) as { id?: number; method?: string });
}

async function waitForRequest(
  harness: ClientHarness,
  method: string,
): Promise<{ id?: number; method?: string }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < HARNESS_REQUEST_TIMEOUT_MS) {
    const request = readHarnessMessages(harness.writes).find((write) => write.method === method);
    if (request) {
      return request;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `${method} request was not written; observed=${JSON.stringify(readHarnessMessages(harness.writes))}`,
  );
}

async function waitForRequestBeforeRunSettles(
  harness: ClientHarness,
  method: string,
  run: Promise<unknown>,
): Promise<{ id?: number; method?: string }> {
  return await Promise.race([
    waitForRequest(harness, method),
    run.then((result) => {
      throw new Error(
        `${method} request was not written before cron run settled: ${JSON.stringify(result)}`,
      );
    }),
  ]);
}

async function answerInitialize(harness: ClientHarness, run: Promise<unknown>): Promise<void> {
  const initialize = await waitForRequestBeforeRunSettles(harness, "initialize", run);
  harness.send({ id: initialize.id, result: { userAgent: "openclaw/0.125.0 (linux; test)" } });
}

function createThreadStartResponse(cwd: string) {
  const timestamp = Math.floor(Date.now() / 1_000);
  return {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    cwd,
    model: OPENAI_MODEL,
    modelProvider: "openai",
    sandbox: { type: "readOnly" },
    thread: {
      cliVersion: "0.0.0-test",
      createdAt: timestamp,
      cwd,
      ephemeral: false,
      id: "thread-1",
      modelProvider: "openai",
      preview: "run the scheduled Codex task",
      sessionId: "session-1",
      source: "appServer",
      status: { type: "idle" },
      turns: [],
      updatedAt: timestamp,
    },
  };
}

function createSuccessfulAttemptResult(
  params: AgentHarnessAttemptParams,
): AgentHarnessAttemptResult {
  return {
    aborted: false,
    externalAbort: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    timedOutDuringToolExecution: false,
    promptError: null,
    promptErrorSource: null,
    sessionIdUsed: params.sessionId,
    sessionFileUsed: params.sessionFile,
    agentHarnessId: "codex",
    messagesSnapshot: [],
    assistantTexts: ["ok"],
    toolMetas: [],
    acceptedSessionSpawns: [],
    lastAssistant: undefined,
    currentAttemptAssistant: undefined,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    messagingToolSourceReplyPayloads: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: 1, activeCount: 0 },
  };
}

async function writeOpenAICodexAuthProfile(home: string, storePath: string): Promise<void> {
  const agentDir = resolveAgentDir(createOpenAICodexCronConfig(home, storePath), "main");
  await fs.mkdir(agentDir, { recursive: true });
  replaceRuntimeAuthProfileStoreSnapshots([
    {
      agentDir,
      store: {
        version: 1,
        profiles: {
          [OPENAI_PROFILE_ID]: {
            type: "token",
            provider: "openai",
            token: "test-access-token",
            expires: Date.now() + 60_000,
            email: "codex@example.test",
          },
        },
        order: {
          openai: [OPENAI_PROFILE_ID],
        },
      },
    },
  ]);
}

function createOpenAICodexCronConfig(home: string, storePath: string): OpenClawConfig {
  return makeCfg(home, storePath, {
    plugins: { enabled: false },
    auth: {
      profiles: {
        [OPENAI_PROFILE_ID]: {
          provider: "openai",
          mode: "oauth",
          email: "codex@example.test",
        },
        [OPENAI_DEFAULT_PROFILE_ID]: {
          provider: "openai",
          mode: "oauth",
          email: "openai@example.test",
        },
      },
      order: {
        openai: [OPENAI_PROFILE_ID, OPENAI_DEFAULT_PROFILE_ID],
      },
    },
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-6",
        workspace: path.join(home, "openclaw"),
        timeoutSeconds: 2,
        models: {
          [`openai/${OPENAI_MODEL}`]: {
            alias: "Reporter OpenAI Codex",
            agentRuntime: { id: "codex" },
          },
        },
      },
    },
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          auth: "oauth",
          api: "openai-chatgpt-responses",
          models: [
            {
              id: OPENAI_MODEL,
              name: OPENAI_MODEL,
              api: "openai-chatgpt-responses",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 8_000,
            },
          ],
        },
      },
    },
  } as Partial<OpenClawConfig>);
}

function createCodexHarness(harness: ClientHarness): AgentHarness {
  return {
    id: "codex",
    label: "Codex agent harness test double",
    supports: ({ provider }) => {
      return provider.trim().toLowerCase() === "openai"
        ? { supported: true, priority: 100 }
        : { supported: false, reason: "test harness only supports openai" };
    },
    runAttempt: async (params) => {
      expect(params.provider).toBe("openai");
      expect(params.model.id).toBe(OPENAI_MODEL);
      expect(params.authProfileId).toBe(OPENAI_PROFILE_ID);
      expect(params.authProfileIdSource).toBe("user");
      const startup = await startCodexAttemptThread({
        attemptClientFactory: async (_startOptions, authProfileId, _agentDir, _config, options) => {
          expect(authProfileId).toBe(OPENAI_PROFILE_ID);
          options?.onStartedClient?.(harness.client);
          const initializeTimeoutMs =
            typeof options?.initializeTimeoutDeadlineMs === "number"
              ? Math.max(1, options.initializeTimeoutDeadlineMs - Date.now())
              : (options?.timeoutMs ?? 2_000);
          await withTimeout(
            harness.client.initialize(),
            initializeTimeoutMs,
            "codex app-server initialize timed out",
          );
          return harness.client;
        },
        appServer: resolveCodexAppServerRuntimeOptions({ pluginConfig: CODEX_PLUGIN_CONFIG }),
        pluginConfig: CODEX_PLUGIN_CONFIG,
        computerUseConfig: CODEX_PLUGIN_CONFIG.computerUse ?? { enabled: false },
        startupAuthProfileId: params.authProfileId,
        startupAuthAccountCacheKey: undefined,
        startupEnvApiKeyCacheKey: undefined,
        agentDir: params.agentDir,
        config: params.config,
        buildAttemptParams: () => params,
        sessionAgentId: params.agentId ?? "main",
        effectiveWorkspace: params.workspaceDir,
        effectiveCwd: params.cwd ?? params.workspaceDir,
        dynamicTools: [],
        developerInstructions: undefined,
        finalConfigPatch: undefined,
        bundleMcpThreadConfig,
        nativeToolSurfaceEnabled: true,
        sandboxExecServerEnabled: false,
        sandbox: null,
        contextEngineProjection: undefined,
        startupTimeoutMs: 2_000,
        signal: params.abortSignal ?? new AbortController().signal,
        onStartupTimeout: vi.fn(),
        spawnedBy: params.spawnedBy,
      });
      startup.releaseSharedClientLease();
      return createSuccessfulAttemptResult(params);
    },
  };
}

async function runReporterCronTurn(params: {
  home: string;
  storePath: string;
  harness: ClientHarness;
  abortSignal?: AbortSignal;
}) {
  registerAgentHarness(createCodexHarness(params.harness));
  return runCronIsolatedAgentTurn({
    cfg: createOpenAICodexCronConfig(params.home, params.storePath),
    deps: {} as never,
    job: {
      ...makeJob({
        kind: "agentTurn",
        message: "run the scheduled Codex task",
        model: `openai/${OPENAI_MODEL}`,
        timeoutSeconds: 2,
        lightContext: true,
      }),
      schedule: { kind: "cron", expr: "0 20,21,22,23,0,1,2,3,4,5,6 * * *", tz: "Europe/Berlin" },
      delivery: { mode: "none" },
    },
    message: "run the scheduled Codex task",
    sessionKey: "cron:job-1",
    lane: "cron",
    abortSignal: params.abortSignal,
  });
}

describe("runCronIsolatedAgentTurn Codex app-server path", () => {
  const originalHarnesses = listRegisteredAgentHarnesses();

  beforeEach(() => {
    vi.useRealTimers();
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    vi.stubEnv("OPENCLAW_AUTH_STORE_READONLY", "1");
    clearSharedCodexAppServerClient();
    clearAgentHarnesses();
    runCliAgentMock.mockClear();
    loadModelCatalogMock.mockResolvedValue([
      {
        id: OPENAI_MODEL,
        name: OPENAI_MODEL,
        provider: "openai",
        api: "openai-chatgpt-responses",
        reasoning: true,
        input: ["text"],
        contextWindow: 128_000,
        maxTokens: 8_000,
      } as ModelCatalogEntry,
      {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        provider: "anthropic",
      },
    ]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearSharedCodexAppServerClient();
    clearRuntimeAuthProfileStoreSnapshots();
    restoreRegisteredAgentHarnesses(originalHarnesses);
    loadModelCatalogMock.mockReset();
  });

  it("attributes an isolated cron agentTurn Codex initialize stall to the app-server initialize phase", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStoreEntries(home, {
        "agent:main:cron:job-1": {
          sessionId: "previous-cron-session",
          updatedAt: Date.now(),
          authProfileOverride: OPENAI_PROFILE_ID,
          authProfileOverrideSource: "user",
        },
      });
      await writeOpenAICodexAuthProfile(home, storePath);
      const harness = createClientHarness();
      const abortController = new AbortController();
      const run = runReporterCronTurn({
        home,
        storePath,
        harness,
        abortSignal: abortController.signal,
      });

      let initialize: { id?: number; method?: string };
      try {
        initialize = await waitForRequestBeforeRunSettles(harness, "initialize", run);
      } catch (error) {
        abortController.abort("test timed out waiting for initialize");
        await run.catch(() => undefined);
        throw error;
      }
      expect(initialize.id).toBeDefined();

      const result = await run;

      expect(result.status).toBe("error");
      expect(result.error).toContain("codex app-server initialize timed out");
      expect(result.error).not.toContain("isolated agent setup timed out before runner start");
      expect(result.error).not.toContain("codex app-server startup timed out");
      expect(result.diagnostics?.summary).toContain("codex app-server initialize timed out");
      expect(result.diagnostics?.entries.some((entry) => entry.source === "agent-run")).toBe(true);
      expect(result.diagnostics?.entries.some((entry) => entry.source === "cron-setup")).toBe(
        false,
      );
      expect(
        readHarnessMessages(harness.writes).some((write) => write.method === "thread/start"),
      ).toBe(false);
    });
  }, 60_000);

  it("reaches thread/start after initialize succeeds for an isolated cron agentTurn", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStoreEntries(home, {
        "agent:main:cron:job-1": {
          sessionId: "previous-cron-session",
          updatedAt: Date.now(),
          authProfileOverride: OPENAI_PROFILE_ID,
          authProfileOverrideSource: "user",
        },
      });
      await writeOpenAICodexAuthProfile(home, storePath);
      const harness = createClientHarness();
      const run = runReporterCronTurn({ home, storePath, harness });

      await answerInitialize(harness, run);
      const threadStart = await waitForRequestBeforeRunSettles(harness, "thread/start", run);

      expect(threadStart.id).toBeDefined();
      expect(
        readHarnessMessages(harness.writes).some((write) => write.method === "thread/start"),
      ).toBe(true);
      harness.send({
        id: threadStart.id,
        result: createThreadStartResponse(path.join(home, "openclaw")),
      });
      await expect(run).resolves.toEqual(expect.objectContaining({ status: "ok" }));
    });
  }, 60_000);
});
