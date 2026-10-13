// Auth profile propagation tests cover isolated agent auth profile forwarding.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeAuthProfileReadPool } from "../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import { resolveCronAgentLane } from "../agents/lanes.js";
import {
  runFallbackModelAttempt,
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../agents/test-helpers/model-fallback-runner.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  makeIsolatedAgentJobFixture,
  makeIsolatedAgentParamsFixture,
} from "./isolated-agent/job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./isolated-agent/run.suite-helpers.js";
import {
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resolveConfiguredModelRefMock,
  resolveCronAgentLaneMock,
  resolveSessionAuthSelectionMock,
  runCliAgentMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./isolated-agent/run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const { resolveAgentDir } = await import("./isolated-agent/run.runtime.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runWithConfig(cfg: OpenClawConfig = {}) {
  return runCronIsolatedAgentTurn(
    makeIsolatedAgentParamsFixture({
      cfg,
      job: makeIsolatedAgentJobFixture({
        agentId: "main",
        delivery: { mode: "none" },
        payload: { kind: "agentTurn", message: "check status" },
      }),
      message: "check status",
      sessionKey: "cron:job-1",
      lane: "cron",
    }),
  );
}

function setupClaudeCliBackend(): void {
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [
      {
        id: "claude-cli",
        modelProvider: "anthropic",
        pluginId: "anthropic",
        config: { command: "claude" },
      },
    ],
    resolvePluginSetupCliBackend: () => undefined,
  });
}

describe("runCronIsolatedAgentTurn auth profile propagation (#20624, #90991)", () => {
  setupRunCronIsolatedAgentTurnSuite();
  let agentDir: string;

  function saveProfiles(profiles: Parameters<typeof saveAuthProfileStore>[0]["profiles"]) {
    saveAuthProfileStore({ version: 1, profiles }, agentDir);
  }
  function cliProfile() {
    return {
      type: "oauth" as const,
      provider: "claude-cli",
      access: "test-token",
      refresh: "test-refresh",
      expires: Date.now() + 3600_000,
    };
  }

  beforeEach(() => {
    agentDir = tempDirs.make("openclaw-cron-auth-");
    vi.mocked(resolveAgentDir).mockReturnValue(agentDir);
  });

  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
    closeAuthProfileReadPool({ kind: "root", rootPath: agentDir });
    closeOpenClawAgentDatabasesForTest(agentDir);
  });

  it("passes authProfileId to runEmbeddedAgent when auth profiles exist", async () => {
    resolveCronAgentLaneMock.mockImplementation(resolveCronAgentLane);
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "openrouter",
      model: "moonshotai/kimi-k2.5",
    });
    resolveSessionAuthSelectionMock.mockResolvedValue({
      profileId: "openrouter:default",
      source: "auto",
      routeRequirement: "api-key",
    });
    mockRunCronFallbackPassthrough();

    const result = await runWithConfig({
      auth: {
        profiles: {
          "openrouter:default": {
            provider: "openrouter",
            mode: "api_key",
          },
        },
        order: { openrouter: ["openrouter:default"] },
      },
    });

    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedAgentMock.mock.calls[0]?.[0]).toMatchObject({
      authProfileId: "openrouter:default",
      authProfileFailurePolicy: "local_transient",
      lane: "cron-nested",
    });
    expect(resolveSessionAuthSelectionMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openrouter", isNewSession: false }),
    );
  });

  it("resolves and forwards ordered CLI auth profile on fallback to Claude CLI (#144047)", async () => {
    isCliProviderMock.mockImplementation((provider: string) => provider === "claude-cli");
    setupClaudeCliBackend();
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    resolveSessionAuthSelectionMock.mockResolvedValue({
      profileId: "openai:default",
      source: "auto",
    });
    saveProfiles({
      "openai:default": {
        type: "api_key",
        provider: "openai",
        key: "sk-test",
      },
      "claude-cli:personal": cliProfile(),
    });
    runCliAgentMock.mockImplementation(async (request) => {
      request.userTurnTranscriptRecorder?.markBlocked();
      return {
        payloads: [{ text: "fallback ok" }],
        meta: { agentMeta: {} },
      };
    });
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => {
      const firstResult = await runInitialModelFallbackAttempt(params);
      const secondResult = await runFallbackModelAttempt(
        params,
        "anthropic",
        "claude-sonnet-4-6",
        "unknown",
      );
      return {
        result: secondResult ?? firstResult,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        attempts: [],
      };
    });

    const result = await runWithConfig({
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
          models: {
            "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
      auth: {
        order: { "claude-cli": ["claude-cli:personal"] },
      },
    });

    expect(result.status).toBe("ok");
    expect(runCliAgentMock).toHaveBeenCalledOnce();
    expect(runCliAgentMock.mock.calls[0]?.[0]).toMatchObject({
      provider: "claude-cli",
      authProfileId: "claude-cli:personal",
    });
  });

  it("fails closed when user-locked auth profile cannot be used by CLI backend (#144047)", async () => {
    isCliProviderMock.mockReturnValue(true);
    mockRunCronFallbackPassthrough();
    setupClaudeCliBackend();
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "claude-cli",
      model: "claude-opus-4-8",
    });
    resolveSessionAuthSelectionMock.mockResolvedValue({
      profileId: "openai:work",
      source: "user",
    });
    saveProfiles({
      "openai:work": {
        type: "api_key",
        provider: "openai",
        key: "sk-test",
      },
    });

    const result = await runWithConfig({});

    expect(result.status).toBe("error");
    expect(result.error).toMatch(/cannot use auth profile "openai:work" owned by "openai"/i);
    expect(runCliAgentMock).not.toHaveBeenCalled();
  });
});
