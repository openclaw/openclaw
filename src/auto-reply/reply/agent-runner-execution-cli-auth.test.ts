import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { saveAuthProfileStore } from "../../agents/auth-profiles/store-runtime.js";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { closeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db.js";
import {
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  expectMockCallArgFields,
  fallbackAttemptOptions,
  getExecuteAgentTurnForTest,
  setupAgentRunnerExecutionTestState,
  type FallbackRunnerParams,
} from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();
const managedProfile = "claude-cli:managed";
const canonicalProfile = "anthropic:managed";
const primaryProfile = "openai:primary";
const googleProfile = "google:managed";
const nativeProfile = "anthropic:claude-cli";
const customProfile = "custom-cli:managed";
const credentials = {
  [managedProfile]: { type: "token", provider: "claude-cli", token: "synthetic-managed-token" },
  [canonicalProfile]: { type: "token", provider: "anthropic", token: "synthetic-canonical-token" },
  [primaryProfile]: { type: "api_key", provider: "openai", key: "synthetic-primary-key" },
  [googleProfile]: { type: "api_key", provider: "google", key: "synthetic-google-key" },
  [nativeProfile]: { type: "token", provider: "claude-cli", token: "synthetic-native-token" },
  [customProfile]: { type: "token", provider: "custom-cli", token: "synthetic-custom-token" },
} satisfies Record<string, AuthProfileCredential>;

describe("executeAgentTurn: CLI credential selection", () => {
  it.each([
    {
      name: "selects ordered CLI credentials after an automatic cross-provider fallback",
      selected: primaryProfile,
      source: "auto",
      primary: "openai",
      provider: "claude-cli",
      backend: "claude-cli",
      profiles: [primaryProfile, managedProfile],
      expected: managedProfile,
    },
    {
      name: "rejects an incompatible explicit account before CLI execution",
      selected: primaryProfile,
      source: "user",
      primary: "openai",
      provider: "claude-cli",
      backend: "claude-cli",
      profiles: [primaryProfile, managedProfile],
      error: 'cannot use auth profile "openai:primary"',
    },
    {
      name: "forwards explicitly selected canonical credentials",
      selected: canonicalProfile,
      source: "user",
      primary: "anthropic",
      provider: "claude-cli",
      backend: "claude-cli",
      profiles: [canonicalProfile, managedProfile],
      expected: canonicalProfile,
    },
    {
      name: "preserves native login for automatic canonical credentials",
      selected: canonicalProfile,
      source: "auto",
      primary: "anthropic",
      provider: "claude-cli",
      backend: "claude-cli",
      profiles: [canonicalProfile],
      expected: undefined,
    },
    {
      name: "preserves a selected native login even when a managed account exists",
      selected: nativeProfile,
      source: "user",
      primary: "claude-cli",
      provider: "claude-cli",
      backend: "claude-cli",
      profiles: [nativeProfile, managedProfile],
      expected: undefined,
    },
    {
      name: "uses the executing Google candidate for canonical API-key fallback",
      selected: primaryProfile,
      source: "auto",
      primary: "openai",
      provider: "google",
      backend: "google-gemini-cli",
      profiles: [primaryProfile, googleProfile],
      expected: googleProfile,
    },
    {
      name: "retains existing scoped forwarding for a custom CLI backend",
      selected: customProfile,
      source: "user",
      primary: "custom-cli",
      provider: "custom-cli",
      backend: "custom-cli",
      profiles: [customProfile],
      expected: customProfile,
    },
  ] as const)("$name", async (testCase) => {
    const followupRun = createFollowupRun();
    onTestFinished(() => {
      closeOpenClawAgentDatabaseByPath(
        path.join(followupRun.run.agentDir, "openclaw-agent.sqlite"),
      );
    });
    const model = "test-model";
    followupRun.run.provider = testCase.primary;
    followupRun.run.model = model;
    followupRun.run.authProfileId = testCase.selected;
    followupRun.run.authProfileIdSource = testCase.source;
    followupRun.run.thinkingCatalog = [{ provider: testCase.provider, id: model, input: ["text"] }];
    const profiles = Object.fromEntries(testCase.profiles.map((id) => [id, credentials[id]]));
    followupRun.run.config = {
      auth: {
        order: Object.fromEntries(testCase.profiles.map((id) => [credentials[id].provider, [id]])),
      },
      agents: {
        defaults: {
          models: { [`${testCase.provider}/${model}`]: { agentRuntime: { id: testCase.backend } } },
        },
      },
    };
    saveAuthProfileStore({ version: 1, profiles }, followupRun.run.agentDir, {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    });
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          pluginId: "anthropic",
          config: { command: "claude" },
        },
        {
          id: "google-gemini-cli",
          modelProvider: "google",
          pluginId: "google",
          config: { command: "gemini" },
        },
        {
          id: "custom-cli",
          modelProvider: "custom-cli",
          pluginId: "custom",
          config: { command: "custom" },
        },
      ],
      resolvePluginSetupCliBackend: () => undefined,
    });
    state.isCliProviderMock.mockImplementation((provider) => provider === testCase.backend);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run(
        testCase.provider,
        model,
        fallbackAttemptOptions(params, "rate_limit"),
      ),
      provider: testCase.provider,
      model,
      attempts: [],
    }));
    state.runCliAgentMock.mockResolvedValueOnce({ payloads: [{ text: "done" }], meta: {} });
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = executeAgentTurn(createMinimalRunAgentTurnParams({ followupRun }));
    if ("error" in testCase) {
      expect(await result).toMatchObject({ kind: "final", payload: { isError: true } });
      expect(state.runCliAgentMock).not.toHaveBeenCalled();
      return;
    }
    expect((await result).kind).toBe("success");
    expect(state.runCliAgentMock).toHaveBeenCalledOnce();
    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI credential handoff", {
      provider: testCase.backend,
      authProfileId: testCase.expected,
    });
  });
});
