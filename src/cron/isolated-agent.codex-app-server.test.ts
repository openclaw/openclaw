import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const cronRuntimeMocks = vi.hoisted(() => {
  process.env.OPENCLAW_TEST_FAST = "1";
  return {
    ensureRuntimePluginsLoaded: vi.fn(),
    loadModelCatalog: vi.fn<() => Promise<ModelCatalogEntry[]>>(),
    preflightCronModelProvider: vi.fn(async () => ({ status: "available" })),
    runCliAgent: vi.fn(async () => {
      throw new Error("unexpected CLI agent path for Codex app-server cron proof");
    }),
  };
});
const loadModelCatalogMock = cronRuntimeMocks.loadModelCatalog;
const runCliAgentMock = cronRuntimeMocks.runCliAgent;

vi.mock("./isolated-agent/run-model-catalog.runtime.js", () => ({
  loadModelCatalog: cronRuntimeMocks.loadModelCatalog,
}));

vi.mock("./isolated-agent/run-model-selection.runtime.js", async () => ({
  ...(await vi.importActual<typeof import("./isolated-agent/run-model-selection.runtime.js")>(
    "./isolated-agent/run-model-selection.runtime.js",
  )),
  loadModelCatalog: cronRuntimeMocks.loadModelCatalog,
}));

vi.mock("../agents/harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: vi.fn(),
}));

vi.mock("../plugins/runtime-plugins.runtime.js", () => ({
  ensureRuntimePluginsLoaded: cronRuntimeMocks.ensureRuntimePluginsLoaded,
}));

vi.mock("./isolated-agent/model-preflight.runtime.js", () => ({
  preflightCronModelProvider: cronRuntimeMocks.preflightCronModelProvider,
}));

vi.mock("./isolated-agent/run-execution-cli.runtime.js", () => ({
  getCliSessionId: vi.fn(),
  runCliAgent: cronRuntimeMocks.runCliAgent,
}));

const OPENAI_MODEL = "gpt-5.5";
const OPENAI_PROFILE_ID = "openai-codex:default";
const OPENAI_DEFAULT_PROFILE_ID = "openai:default";

type AgentHarnessAttemptParams = Parameters<AgentHarness["runAttempt"]>[0];
type AgentHarnessAttemptResult = Awaited<ReturnType<AgentHarness["runAttempt"]>>;

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

function expectCodexAttemptParams(params: AgentHarnessAttemptParams): void {
  expect(params.provider).toBe("openai");
  expect(params.model.id).toBe(OPENAI_MODEL);
  expect(params.authProfileId).toBe(OPENAI_PROFILE_ID);
  expect(params.authProfileIdSource).toBe("user");
  expect(params.agentDir).toBeDefined();
}

function createCodexHarness(params: {
  attempts: AgentHarnessAttemptParams[];
  runAttempt: (attemptParams: AgentHarnessAttemptParams) => Promise<AgentHarnessAttemptResult>;
}): AgentHarness {
  return {
    id: "codex",
    label: "Codex agent harness test double",
    supports: ({ provider }) => {
      return provider.trim().toLowerCase() === "openai"
        ? { supported: true, priority: 100 }
        : { supported: false, reason: "test harness only supports openai" };
    },
    runAttempt: async (attemptParams) => {
      params.attempts.push(attemptParams);
      expectCodexAttemptParams(attemptParams);
      return params.runAttempt(attemptParams);
    },
  };
}

async function runReporterCronTurn(params: {
  home: string;
  storePath: string;
  attempts: AgentHarnessAttemptParams[];
  runAttempt: (attemptParams: AgentHarnessAttemptParams) => Promise<AgentHarnessAttemptResult>;
}) {
  registerAgentHarness(createCodexHarness(params));
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
  });
}

describe("runCronIsolatedAgentTurn Codex harness routing", () => {
  const originalHarnesses = listRegisteredAgentHarnesses();

  beforeEach(() => {
    vi.useRealTimers();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    vi.stubEnv("OPENCLAW_AUTH_STORE_READONLY", "1");
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
    clearRuntimeAuthProfileStoreSnapshots();
    restoreRegisteredAgentHarnesses(originalHarnesses);
    loadModelCatalogMock.mockReset();
  });

  it("attributes a Codex initialize stall from the selected harness to agent-run diagnostics", async () => {
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
      const attempts: AgentHarnessAttemptParams[] = [];

      const result = await runReporterCronTurn({
        home,
        storePath,
        attempts,
        runAttempt: async () => {
          throw new Error("codex app-server initialize timed out");
        },
      });

      expect(result.status).toBe("error");
      expect(result.error).toContain("codex app-server initialize timed out");
      expect(result.error).not.toContain("isolated agent setup timed out before runner start");
      expect(result.error).not.toContain("codex app-server startup timed out");
      expect(result.diagnostics?.summary).toContain("codex app-server initialize timed out");
      expect(result.diagnostics?.entries.some((entry) => entry.source === "agent-run")).toBe(true);
      expect(result.diagnostics?.entries.some((entry) => entry.source === "cron-setup")).toBe(
        false,
      );
      expect(attempts).toHaveLength(1);
      expect(runCliAgentMock).not.toHaveBeenCalled();
    });
  }, 60_000);

  it("uses the Codex harness for a successful isolated cron agentTurn", async () => {
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
      const attempts: AgentHarnessAttemptParams[] = [];

      const run = runReporterCronTurn({
        home,
        storePath,
        attempts,
        runAttempt: async (attemptParams) => createSuccessfulAttemptResult(attemptParams),
      });

      await expect(run).resolves.toEqual(expect.objectContaining({ status: "ok" }));
      expect(attempts).toHaveLength(1);
      expect(runCliAgentMock).not.toHaveBeenCalled();
    });
  }, 60_000);
});
