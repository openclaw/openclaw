import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import * as agentScope from "../../agents/agent-scope.js";
import { saveAuthProfileStore } from "../../agents/auth-profiles/store-runtime.js";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { resolveModelCandidateChain } from "../../agents/model-fallback-candidates.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import { closeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db.js";
import {
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  expectMockCallArgFields,
  fallbackAttemptOptions,
  getExecuteAgentTurnForTest,
  setupAgentRunnerExecutionTestState,
  initialFallbackAttemptOptions,
  useProductionEmbeddedRunExecutionParamsForTest,
  type FallbackRunnerParams,
} from "./agent-runner-execution.test-support.js";
import * as agentRunnerUtils from "./agent-runner-utils.js";
import { createModelSelectionState } from "./model-selection.js";

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

  it.each([
    { runtime: "claude-cli", provider: "anthropic" },
    { runtime: "google-gemini-cli", provider: "google" },
  ])(
    "keeps $runtime native after resume binding and fails closed with API credentials available",
    async ({ runtime, provider }) => {
      await useProductionEmbeddedRunExecutionParamsForTest();
      const { resolveModelFallbackOptions } =
        await vi.importActual<typeof agentRunnerUtils>("./agent-runner-utils.js");
      const fallbackOptions = vi
        .spyOn(agentRunnerUtils, "resolveModelFallbackOptions")
        .mockImplementation(resolveModelFallbackOptions);
      const actualAgentScope = await vi.importActual<typeof agentScope>(
        "../../agents/agent-scope.js",
      );
      const resolveFallbackAvailability = actualAgentScope.resolveModelFallbackAvailability;
      const projectFallbackOverride = actualAgentScope.modelFallbackOverrideFromAvailability;
      const availability = vi
        .spyOn(agentScope, "resolveModelFallbackAvailability")
        .mockImplementation(resolveFallbackAvailability);
      const fallbackOverride = vi
        .spyOn(agentScope, "modelFallbackOverrideFromAvailability")
        .mockImplementation(projectFallbackOverride);
      onTestFinished(() => {
        availability.mockRestore();
        fallbackOverride.mockRestore();
        fallbackOptions.mockRestore();
      });
      const followupRun = createFollowupRun();
      onTestFinished(() => {
        closeOpenClawAgentDatabaseByPath(
          path.join(followupRun.run.agentDir, "openclaw-agent.sqlite"),
        );
      });
      const model = "native-test-model";
      const profileId = `${provider}:api`;
      followupRun.run.config = {
        agents: {
          defaults: {
            model: { primary: `${provider}/${model}`, fallbacks: [`${provider}/api-backup`] },
          },
        },
        auth: {
          profiles: { [profileId]: { provider, mode: "api_key" } },
          order: { [provider]: [profileId] },
        },
      };
      saveAuthProfileStore(
        {
          version: 1,
          profiles: { [profileId]: { type: "api_key", provider, key: "synthetic-api-key" } },
        },
        followupRun.run.agentDir,
        { filterExternalAuthProfiles: false, syncExternalCli: false },
      );
      const catalog = [runtime, provider].map((entryProvider) => ({
        provider: entryProvider,
        id: model,
        name: model,
        input: ["text" as const],
      }));
      followupRun.run.thinkingCatalog = catalog;
      followupRun.run.hasSessionModelOverride = true;
      followupRun.run.modelOverrideSource = "user";
      const entry: SessionEntry = { sessionId: followupRun.run.sessionId, updatedAt: 1 };
      applyModelOverrideToSessionEntry({ entry, selection: { provider: runtime, model } });
      cliBackendsTesting.setDepsForTest({
        resolveRuntimeCliBackends: () => [
          {
            id: runtime,
            modelProvider: provider,
            pluginId: provider,
            config: { command: runtime },
          },
        ],
        resolvePluginSetupCliBackend: () => undefined,
      });
      state.isCliProviderMock.mockImplementation((candidate) => candidate === runtime);
      const candidatePlans: Array<Array<{ provider: string; model: string }>> = [];
      let candidateError: unknown;
      state.runWithModelFallbackMock.mockImplementation(
        async (params: FallbackRunnerParams & Parameters<typeof resolveModelCandidateChain>[0]) => {
          candidatePlans.push(
            resolveModelCandidateChain({ ...params, manifestPlugins: [] }).map((candidate) => ({
              provider: candidate.provider,
              model: candidate.model,
            })),
          );
          try {
            return {
              result: await params.run(
                params.provider,
                params.model,
                initialFallbackAttemptOptions(params),
              ),
              provider: params.provider,
              model: params.model,
              attempts: [],
            };
          } catch (error) {
            candidateError = error;
            throw error;
          }
        },
      );
      state.runCliAgentMock.mockResolvedValue({ payloads: [{ text: "native reply" }], meta: {} });
      state.runEmbeddedAgentMock.mockResolvedValue({ payloads: [{ text: "API reply" }], meta: {} });
      const executeAgentTurn = await getExecuteAgentTurnForTest();
      const runTurn = async () => {
        const selected = await createModelSelectionState({
          agentId: followupRun.run.agentId,
          cfg: followupRun.run.config,
          agentCfg: followupRun.run.config.agents?.defaults,
          sessionEntry: entry,
          sessionStore: { main: entry },
          sessionKey: "main",
          defaultProvider: provider,
          defaultModel: model,
          provider,
          model,
          hasModelDirective: false,
          preparedModelCatalog: { entries: catalog, routeVariants: catalog, authoritative: true },
        });
        followupRun.run.provider = selected.provider;
        followupRun.run.model = selected.model;
        followupRun.run.requestedRouteResolution = selected.requestedRouteResolution;
        return executeAgentTurn({
          ...createMinimalRunAgentTurnParams({ followupRun }),
          getActiveSessionEntry: () => entry,
        });
      };

      const firstTurn = await runTurn();
      expect(
        firstTurn,
        `${JSON.stringify(firstTurn)}; candidate error: ${String(candidateError)}`,
      ).toMatchObject({
        kind: "success",
        runResult: { payloads: [{ text: "native reply" }] },
      });
      entry.cliSessionBindings = { [runtime]: { sessionId: "native-resume-session" } };
      const resumedTurn = await runTurn();
      expect(
        resumedTurn,
        `${JSON.stringify(resumedTurn)}; candidate error: ${String(candidateError)}`,
      ).toMatchObject({
        kind: "success",
        runResult: { payloads: [{ text: "native reply" }] },
      });
      state.runCliAgentMock.mockRejectedValueOnce(
        Object.assign(new Error("native executable unavailable"), { code: "ENOENT" }),
      );
      expect(await runTurn()).toMatchObject({ kind: "final", payload: { isError: true } });
      expect(state.runCliAgentMock).toHaveBeenCalledTimes(3);
      expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
      if (runtime === "claude-cli") {
        expect(
          state.runCliAgentMock.mock.calls.some(([input]) => input.authProfileId === profileId),
        ).toBe(false);
      }
      // A user pin must not acquire the configured API fallback or appended primary.
      expect(candidatePlans).toEqual([
        [{ provider: runtime, model }],
        [{ provider: runtime, model }],
        [{ provider: runtime, model }],
      ]);

      applyModelOverrideToSessionEntry({ entry, selection: { provider, model } });
      const apiTurn = await runTurn();
      expect(
        apiTurn,
        `${JSON.stringify(apiTurn)}; candidate error: ${String(candidateError)}`,
      ).toMatchObject({
        kind: "success",
        runResult: { payloads: [{ text: "API reply" }] },
      });
      expect(state.runCliAgentMock).toHaveBeenCalledTimes(3);
      expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    },
  );
});
