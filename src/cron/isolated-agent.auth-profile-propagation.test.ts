// Auth profile propagation tests cover isolated agent auth profile forwarding.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeAuthProfileReadPool } from "../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import type { AuthProfileFailurePolicy } from "../agents/embedded-agent-runner/run/auth-profile-failure-policy.types.js";
import {
  runFallbackModelAttempt,
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../agents/test-helpers/model-fallback-runner.test-support.js";
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
  resolveSessionAuthSelectionMock,
  runCliAgentMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./isolated-agent/run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const { resolveAgentDir } = await import("./isolated-agent/run.runtime.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function getEmbeddedAgentParams(): {
  authProfileId?: string;
  authProfileIdSource?: string;
  authProfileFailurePolicy?: AuthProfileFailurePolicy;
} {
  const params = runEmbeddedAgentMock.mock.calls[0]?.[0];
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Expected embedded OpenClaw agent params to be an object");
  }
  return params;
}

function getCliAgentParams(): {
  authProfileId?: string;
  provider?: string;
  [key: string]: unknown;
} {
  const params = runCliAgentMock.mock.calls[0]?.[0];
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Expected CLI OpenClaw agent params to be an object");
  }
  return params as { authProfileId?: string; provider?: string };
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

  beforeEach(() => {
    agentDir = tempDirs.make("openclaw-cron-auth-");
    vi.mocked(resolveAgentDir).mockReturnValue(agentDir);
  });

  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
    closeAuthProfileReadPool({ kind: "root", rootPath: agentDir });
    closeOpenClawAgentDatabasesForTest(agentDir);
  });

  it("uses transient-local auth cooldown policy for cron throttling failures", async () => {
    mockRunCronFallbackPassthrough();

    await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
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

    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(getEmbeddedAgentParams()).toMatchObject({
      authProfileFailurePolicy: "local_transient",
    });
  });

  it("passes authProfileId to runEmbeddedAgent when auth profiles exist", async () => {
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

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        cfg: {
          auth: {
            profiles: {
              "openrouter:default": {
                provider: "openrouter",
                mode: "api_key",
              },
            },
            order: { openrouter: ["openrouter:default"] },
          },
        },
        job: makeIsolatedAgentJobFixture({
          agentId: "main",
          delivery: { mode: "none" },
          payload: {
            kind: "agentTurn",
            message: "check status",
          },
        }),
        message: "check status",
        sessionKey: "cron:job-1",
        lane: "cron",
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(getEmbeddedAgentParams()).toMatchObject({
      authProfileId: "openrouter:default",
    });
  });

  it("passes resolved authProfileId to runCliAgent when CLI execution provider is active (#144047)", async () => {
    isCliProviderMock.mockReturnValue(true);
    mockRunCronFallbackPassthrough();
    runCliAgentMock.mockResolvedValue({
      payloads: [{ text: "cli done" }],
      meta: { agentMeta: {} },
    });
    setupClaudeCliBackend();
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "claude-cli",
      model: "claude-opus-4-8",
    });
    resolveSessionAuthSelectionMock.mockResolvedValue({
      profileId: "claude-cli:personal",
      source: "auto",
    });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "claude-cli:personal": {
            type: "oauth",
            provider: "claude-cli",
            access: "test-token",
            refresh: "test-refresh",
            expires: Date.now() + 3600_000,
          },
        },
      },
      agentDir,
    );

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        cfg: {
          auth: {
            order: { "claude-cli": ["claude-cli:personal"] },
          },
        },
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

    expect(result.status).toBe("ok");
    expect(runCliAgentMock).toHaveBeenCalledOnce();
    expect(getCliAgentParams()).toMatchObject({
      provider: "claude-cli",
      authProfileId: "claude-cli:personal",
    });
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
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "sk-test",
          },
          "claude-cli:personal": {
            type: "oauth",
            provider: "claude-cli",
            access: "test-token",
            refresh: "test-refresh",
            expires: Date.now() + 3600_000,
          },
        },
      },
      agentDir,
    );
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

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        cfg: {
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
        },
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

    expect(result.status).toBe("ok");
    expect(runCliAgentMock).toHaveBeenCalledOnce();
    expect(getCliAgentParams()).toMatchObject({
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
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai:work": {
            type: "api_key",
            provider: "openai",
            key: "sk-test",
          },
        },
      },
      agentDir,
    );

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        cfg: {},
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

    expect(result.status).toBe("error");
    expect(result.error).toMatch(/cannot use auth profile "openai:work" owned by "openai"/i);
    expect(runCliAgentMock).not.toHaveBeenCalled();
  });

  it("defaults undefined authProfileIdSource to auto and allows fallback to Claude CLI (#144047)", async () => {
    isCliProviderMock.mockImplementation((provider: string) => provider === "claude-cli");
    setupClaudeCliBackend();
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    // Legacy / unspecified authProfileIdSource (undefined)
    resolveSessionAuthSelectionMock.mockResolvedValue({
      profileId: "openai:legacy",
      source: undefined,
    });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai:legacy": {
            type: "api_key",
            provider: "openai",
            key: "sk-test",
          },
          "claude-cli:personal": {
            type: "oauth",
            provider: "claude-cli",
            access: "test-token",
            refresh: "test-refresh",
            expires: Date.now() + 3600_000,
          },
        },
      },
      agentDir,
    );
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

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        cfg: {
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
        },
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

    expect(result.status).toBe("ok");
    expect(runCliAgentMock).toHaveBeenCalledOnce();
    expect(getCliAgentParams()).toMatchObject({
      provider: "claude-cli",
      authProfileId: "claude-cli:personal",
    });
  });
});
