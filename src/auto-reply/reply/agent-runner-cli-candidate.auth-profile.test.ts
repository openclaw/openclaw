// Tests the CLI dispatch boundary's auth identity conversion: a session pin
// resolved for the model provider must not leak into a claude-cli child as a
// forwarded API key when auth.order names the backend's native login. The
// helper-level cases pin the conversion contract; the executeAgentTurn cases
// observe the credential that actually reaches the CLI runner through the
// reply dispatch, so restoring the raw session pin at the dispatch site fails.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import {
  resolveCliForwardedAuthProfileId,
  resolveRunAuthProfile,
} from "./agent-runner-auth-profile.js";
import {
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  initialFallbackAttemptOptions,
  requireMockCall,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";
import type { FollowupRun } from "./queue.js";

const state = await setupAgentRunnerExecutionTestState();

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  profiles: {} as Record<string, AuthProfileCredential>,
}));

vi.mock("../../agents/auth-profiles/store-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/auth-profiles/store-runtime.js")>()),
  loadAuthProfileStoreForRuntime: () => ({ version: 1, profiles: mocks.profiles }),
}));

vi.mock("../../agents/auth-profiles/order.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/auth-profiles/order.js")>()),
  resolveAuthProfileOrder: () => mocks.order,
}));

const sessionPinRun = {
  provider: "anthropic",
  authProfileId: "anthropic:default",
  authProfileIdSource: "auto",
} as FollowupRun["run"];

describe("reply CLI dispatch auth identity", () => {
  beforeEach(() => {
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
    mocks.order.length = 0;
    for (const profileId of Object.keys(mocks.profiles)) {
      delete mocks.profiles[profileId];
    }
  });

  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
  });

  it("drops a model-provider auto pin at the CLI dispatch boundary", () => {
    // Issue repro: auth.order.claude-cli names the backend's native login, the
    // store only holds an api_key profile for the model provider, and the
    // session layer auto-pins it for the turn. The boundary must drop that pin
    // so the CLI child keeps its own login instead of silently billing the
    // stored key.
    mocks.profiles["anthropic:default"] = {
      type: "api_key",
      provider: "anthropic",
      key: "test-anthropic-key",
    };
    // The session layer alone forwards the model-provider pin to the run; the
    // dispatch boundary must convert it to the CLI execution identity.
    expect(resolveRunAuthProfile(sessionPinRun, "claude-cli", { config: {} })).toEqual({
      authProfileId: "anthropic:default",
      authProfileIdSource: "auto",
    });

    expect(
      resolveCliForwardedAuthProfileId({
        candidateRun: sessionPinRun,
        cliExecutionProvider: "claude-cli",
        authProfileProvider: "anthropic",
        config: {},
        agentDir: "/tmp/unused-agent",
      }),
    ).toBeUndefined();
  });

  it("keeps a profile the CLI backend owns and forwards a native login as none", () => {
    mocks.order.push("claude-cli:work");
    mocks.profiles["claude-cli:work"] = {
      type: "api_key",
      provider: "claude-cli",
      key: "test-claude-key",
    };

    expect(
      resolveCliForwardedAuthProfileId({
        candidateRun: {
          provider: "anthropic",
          authProfileId: "claude-cli:work",
          authProfileIdSource: "user",
        } as FollowupRun["run"],
        cliExecutionProvider: "claude-cli",
        authProfileProvider: "anthropic",
        config: {},
        agentDir: "/tmp/unused-agent",
      }),
    ).toBe("claude-cli:work");

    expect(
      resolveCliForwardedAuthProfileId({
        candidateRun: {
          provider: "anthropic",
          authProfileId: "anthropic:claude-cli",
          authProfileIdSource: "user",
        } as FollowupRun["run"],
        cliExecutionProvider: "claude-cli",
        authProfileProvider: "anthropic",
        config: {},
        agentDir: "/tmp/unused-agent",
      }),
    ).toBeUndefined();
  });

  it("forwards no auth profile through the reply dispatch when the session auto-pins a model-provider key", async () => {
    mocks.profiles["anthropic:default"] = {
      type: "api_key",
      provider: "anthropic",
      key: "test-anthropic-key",
    };
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run(
        "claude-cli",
        "claude-sonnet-4-6",
        initialFallbackAttemptOptions(params),
      ),
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
      attempts: [],
    }));
    state.runCliAgentMock.mockResolvedValueOnce({ payloads: [{ text: "done" }], meta: {} });

    const followupRun = createFollowupRun();
    followupRun.run.authProfileId = "anthropic:default";
    followupRun.run.authProfileIdSource = "auto";

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createMinimalRunAgentTurnParams({ followupRun }));

    expect(result.kind).toBe("success");
    const forwarded = requireMockCall(
      state.runCliAgentMock,
      0,
      "CLI run params",
    )[0] as RunCliAgentParams;
    expect(forwarded.authProfileId).toBeUndefined();
  });

  it("forwards a backend-owned profile through the reply dispatch", async () => {
    mocks.profiles["claude-cli:work"] = {
      type: "api_key",
      provider: "claude-cli",
      key: "test-claude-key",
    };
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run(
        "claude-cli",
        "claude-sonnet-4-6",
        initialFallbackAttemptOptions(params),
      ),
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
      attempts: [],
    }));
    state.runCliAgentMock.mockResolvedValueOnce({ payloads: [{ text: "done" }], meta: {} });

    const followupRun = createFollowupRun();
    followupRun.run.authProfileId = "claude-cli:work";
    followupRun.run.authProfileIdSource = "auto";

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createMinimalRunAgentTurnParams({ followupRun }));

    expect(result.kind).toBe("success");
    const forwarded = requireMockCall(
      state.runCliAgentMock,
      0,
      "CLI run params",
    )[0] as RunCliAgentParams;
    expect(forwarded.authProfileId).toBe("claude-cli:work");
  });
});
