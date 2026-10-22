import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeAuthProfilesAcrossOwnerStores } from "../agents/auth-profiles/profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import type { RunEmbeddedAgentInternalParams as AgentRequest } from "../agents/embedded-agent-runner/run/internal-params.js";
import { resolveCronAgentLane } from "../agents/lanes.js";
import {
  runFallbackModelAttempt,
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../agents/test-helpers/model-fallback-runner.test-support.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureCronUpdatedInferenceBinding } from "../gateway/server-methods/cron-input-validation.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { captureCronInferenceBinding } from "./inference-binding.runtime.js";
import {
  makeIsolatedAgentJobFixture,
  makeIsolatedAgentParamsFixture,
} from "./isolated-agent/job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./isolated-agent/run.suite-helpers.js";
import * as h from "./isolated-agent/run.test-harness.js";
import { loadCronJobsStore, saveCronJobsStore } from "./store.js";
import type { CronStoredJob } from "./types.js";

const runCronIsolatedAgentTurn = await h.loadRunCronIsolatedAgentTurn();
const { resolveAgentDir } = await import("./isolated-agent/run.runtime.js");
const platformId = "openai:platform";
const subscriptionId = "openai:subscription";

const makeAuthJob = (overrides: Partial<CronStoredJob> = {}): CronStoredJob =>
  makeIsolatedAgentJobFixture({
    agentId: "main",
    delivery: { mode: "none" },
    payload: { kind: "agentTurn", message: "check status" },
    ...overrides,
  });

function runWithConfig(cfg: OpenClawConfig, job = makeAuthJob(), trigger?: "cron" | "event") {
  return runCronIsolatedAgentTurn(
    makeIsolatedAgentParamsFixture({
      cfg,
      job,
      trigger,
      message: "check status",
      sessionKey: "cron:job-1",
      lane: "cron",
    }),
  );
}

function setupClaudeCliBackend(): void {
  h.isCliProviderMock.mockImplementation((provider: string) => provider === "claude-cli");
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [
      {
        id: "claude-cli",
        modelProvider: "anthropic",
        pluginId: "anthropic",
        config: { command: "claude" },
        authEpochMode: "profile-only",
        autoSelectAuthProfile: false,
      },
    ],
    resolvePluginSetupCliBackend: () => undefined,
  });
}

const oauth = (provider = "openai"): AuthProfileCredential => ({
  type: "oauth",
  provider,
  access: "synthetic-subscription-access",
  refresh: "synthetic-subscription-refresh",
  expires: Date.now() + 3_600_000,
  accountId: "synthetic-account",
});

const claudeToken = (): AuthProfileCredential => ({
  type: "token",
  provider: "anthropic",
  token: "synthetic-claude-token",
});

const apiKey = (): AuthProfileCredential => ({
  type: "api_key",
  provider: "openai",
  key: "synthetic-platform-key",
});

describe("runCronIsolatedAgentTurn auth profile propagation (#20624, #90991)", () => {
  setupRunCronIsolatedAgentTurnSuite();
  let state: OpenClawTestState;

  async function saveProfiles(profiles: Record<string, AuthProfileCredential>) {
    const batch = Object.entries(profiles).map(([profileId, credential]) => ({
      profileId,
      credential,
    }));
    await persistAuthProfileBatch({ profiles: batch });
  }

  const config = (primary = "openai/gpt-4.1"): OpenClawConfig => ({
    agents: {
      entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
      defaults: { model: primary },
    },
    auth: {
      profiles: {
        [platformId]: { provider: "openai", mode: "api_key" },
        [subscriptionId]: { provider: "openai", mode: "oauth" },
      },
      order: { openai: [platformId, subscriptionId] },
    },
  });

  beforeEach(async () => {
    state = await createOpenClawTestState({
      label: "cron-auth-propagation",
      env: { OPENAI_API_KEY: undefined, OPENAI_OAUTH_TOKEN: undefined },
    });
    // The real credential owner resolves the canonical main directory, not a custom test root.
    vi.mocked(resolveAgentDir).mockReturnValue(state.agentDir());
    h.mockRunCronFallbackPassthrough();
  });

  afterEach(async () => {
    cliBackendsTesting.resetDepsForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    await state.cleanup();
  });

  it("leases the creator's account through settlement and releases it after the turn", async () => {
    const profileId = platformId;
    const requirement = "api-key";
    await saveProfiles({ [platformId]: apiKey(), [subscriptionId]: oauth() });
    const cfg = config();
    const creator: SessionEntry = {
      sessionId: "creator-session",
      updatedAt: 1,
      modelProvider: "openai",
      model: "gpt-4.1",
      authProfileOverride: profileId,
      authProfileOverrideSource: "auto",
    };
    const binding = await captureCronInferenceBinding({
      cfg,
      agentId: "main",
      sessionEntry: creator,
    });
    expect(creator.authProfileOverrideSource).toBe("auto");
    const other = subscriptionId;
    h.resolveCronAgentLaneMock.mockImplementation(resolveCronAgentLane);
    let assertLease: (() => void) | undefined;
    h.runEmbeddedAgentMock.mockImplementation(async (request: AgentRequest) => {
      expect(request).toMatchObject({
        authProfileId: profileId,
        authProfileIdSource: "auto",
        authProfileBinding: { profileId, authRequirement: requirement },
        allowAuthProfileFallback: false,
        authProfileFailurePolicy: "local_transient",
        lane: "cron-nested",
      });
      const { authProfileBinding, onSuccessfulAuthProfile } = request;
      if (!authProfileBinding || !onSuccessfulAuthProfile) {
        throw new Error("Expected live binding and account settlement guard");
      }
      const assertCurrent = () => authProfileBinding.assertCurrent();
      expect(() => assertCurrent()).not.toThrow();
      expect(() => onSuccessfulAuthProfile(profileId)).not.toThrow();
      expect(() => onSuccessfulAuthProfile(other)).toThrow(/inference account changed/i);
      assertLease = assertCurrent;
      request.userTurnTranscriptRecorder?.markBlocked();
      return { payloads: [{ text: "same authorized account" }], meta: { agentMeta: {} } };
    });

    // Persistence and changed defaults are covered through real HTTP in auth-continuity.integration.
    const result = await runWithConfig(
      config(`openai/gpt-4.1@${other}`),
      makeAuthJob({ inferenceBinding: binding }),
    );
    expect(result.status, result.error).toBe("ok");
    expect(h.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(h.resolveSessionAuthSelectionMock).not.toHaveBeenCalled();
    expect(assertLease).toBeTypeOf("function");
    expect(() => assertLease!()).toThrow(/disconnected|replaced/i);
    expect(h.runCliAgentMock).not.toHaveBeenCalled();
  });

  it("executes a reloaded native-owned job without resolving its irrelevant host profile", async () => {
    const runtimeAuthority = {
      version: 1 as const,
      runtimeId: "openclaw",
      namespace: "synthetic.inference",
      payload: { account: "synthetic-native-account" },
    };
    const job = makeAuthJob({
      runtimeAuthority,
      payload: {
        kind: "agentTurn",
        message: "check status",
        model: "openai/gpt-4.1@openai:missing-native-only",
      },
    });
    const storePath = state.statePath("cron", "jobs.json");
    await saveCronJobsStore(storePath, { version: 1, jobs: [job] });
    const reloaded = (await loadCronJobsStore(storePath)).jobs[0];
    if (!reloaded) {
      throw new Error("Expected the native-owned persisted job");
    }
    h.resolveSessionAuthSelectionMock.mockRejectedValue(
      new Error("Host auth must not be resolved"),
    );
    h.runEmbeddedAgentMock.mockImplementation(async (request: AgentRequest) => {
      expect(request.scheduledRuntimeAuthority).toEqual(runtimeAuthority);
      expect(request.authProfileId).toBeUndefined();
      expect(request.authProfileBinding).toBeUndefined();
      request.userTurnTranscriptRecorder?.markBlocked();
      return { payloads: [{ text: "native authorized account" }], meta: { agentMeta: {} } };
    });
    const result = await runWithConfig(config(), reloaded);
    expect(result.status, result.error).toBe("ok");
    expect(h.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(h.resolveSessionAuthSelectionMock).not.toHaveBeenCalled();
    expect(h.runCliAgentMock).not.toHaveBeenCalled();
  });

  it("runs a native Claude CLI job without adopting an unrelated host account", async () => {
    await saveProfiles({ [platformId]: apiKey() });
    setupClaudeCliBackend();
    h.resolveConfiguredModelRefMock.mockReturnValue({ provider: "claude-cli", model: "sonnet" });
    h.resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
    h.runCliAgentMock.mockResolvedValue({
      payloads: [{ text: "native account reply" }],
      meta: { agentMeta: { provider: "claude-cli", model: "sonnet" } },
    });

    const result = await runWithConfig(config("claude-cli/sonnet"));

    expect(result.status, result.error).toBe("ok");
    expect(h.runCliAgentMock).toHaveBeenCalledOnce();
    expect(h.runCliAgentMock.mock.lastCall?.[0].authProfileId).toBeUndefined();
    expect(h.runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it.each(["cron", "event"] as const)(
    "keeps %s CLI fallback on its account boundary (#144047)",
    async (trigger) => {
      setupClaudeCliBackend();
      h.resolveConfiguredModelRefMock.mockReturnValue({ provider: "openai", model: "gpt-4.1" });
      h.resolveSessionAuthSelectionMock.mockResolvedValue({
        profileId: platformId,
        source: "auto",
      });
      await saveProfiles({ [platformId]: apiKey(), "claude-cli:personal": oauth("claude-cli") });
      h.runWithModelFallbackMock.mockImplementation(
        async (params: TestModelFallbackRunnerParams) => {
          await runInitialModelFallbackAttempt(params);
          return {
            result: await runFallbackModelAttempt(params, "openai", "gpt-4o", "unknown"),
            provider: "openai",
            model: "gpt-4o",
            attempts: [],
          };
        },
      );
      const cfg = config();
      cfg.agents!.defaults!.model = { primary: "openai/gpt-4.1", fallbacks: ["openai/gpt-4o"] };
      cfg.agents!.defaults!.models = { "openai/gpt-4o": { agentRuntime: { id: "claude-cli" } } };
      cfg.auth!.order = { "claude-cli": ["claude-cli:personal"] };
      h.runCliAgentMock.mockResolvedValue({
        payloads: [{ text: "event account reply" }],
        meta: { agentMeta: { provider: "claude-cli", model: "gpt-4o" } },
      });

      const result = await runWithConfig(cfg, undefined, trigger);

      expect(h.runEmbeddedAgentMock).toHaveBeenCalledOnce();
      if (trigger === "cron") {
        expect(result.status).toBe("error");
        expect(result.error).toContain("Automation has no recorded inference account");
        expect(h.runCliAgentMock).not.toHaveBeenCalled();
      } else {
        expect(result.status, result.error).toBe("ok");
        expect(h.runCliAgentMock).toHaveBeenCalledOnce();
        expect(h.runCliAgentMock.mock.lastCall?.[0].trigger).toBe("event");
        expect(h.runCliAgentMock.mock.lastCall?.[0].nativeAuthOnly).toBeUndefined();
        expect(h.runCliAgentMock.mock.lastCall?.[0].authProfileId).toBe("claude-cli:personal");
      }
    },
  );

  it.each([
    { trigger: "cron", cli: true },
    { trigger: "event", cli: true },
    { trigger: "cron", cli: false },
  ] as const)(
    "explains a bound account refusal for $trigger with cli=$cli (#144047)",
    async ({ trigger, cli }) => {
      await saveProfiles({ "openai:work": apiKey(), "claude-cli:personal": oauth("claude-cli") });
      const cfg = config();
      const binding = await captureCronInferenceBinding({
        cfg,
        agentId: "main",
        model: "openai/gpt-4.1@openai:work",
      });
      expect(binding).toMatchObject({ profileId: "openai:work", source: "user" });
      const storePath = state.statePath("cron", "jobs.json");
      await saveCronJobsStore(storePath, {
        version: 1,
        jobs: [makeAuthJob({ inferenceBinding: binding })],
      });
      setupClaudeCliBackend();
      const provider = cli ? "openai" : "anthropic";
      const model = cli ? "gpt-4o" : "claude-sonnet-4-5";
      h.resolveConfiguredModelRefMock.mockReturnValue({ provider, model });
      cfg.agents!.defaults!.model = `${provider}/${model}`;
      if (cli) {
        cfg.agents!.defaults!.models = { "openai/gpt-4o": { agentRuntime: { id: "claude-cli" } } };
      }
      cfg.auth!.order = { "claude-cli": ["claude-cli:personal"] };
      clearRuntimeAuthProfileStoreSnapshots();
      await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
      const reloaded = (await loadCronJobsStore(storePath)).jobs[0];
      if (!reloaded) {
        throw new Error("Expected the persisted automation");
      }
      const result = await runWithConfig(cfg, reloaded, trigger);

      expect(result.status).toBe("error");
      expect(result.error).toContain("incompatible with its recorded inference account and route");
      expect(result.error).toContain(cli ? "CLI login" : "different provider");
      expect(result.error).toContain(
        "openclaw automations edit <jobId> --model <provider/model>@<profileId>",
      );
      expect(reloaded.inferenceBinding).toEqual(binding);
      expect((await loadCronJobsStore(storePath)).jobs[0]?.inferenceBinding).toEqual(binding);
      expect(h.resolveSessionAuthSelectionMock).not.toHaveBeenCalled();
      expect(h.runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(h.runCliAgentMock).not.toHaveBeenCalled();
    },
  );

  // Claude CLI forwards a stored Anthropic account the same way interactive chat does.
  const claudeCliConfig = (): OpenClawConfig => {
    const cfg = config("anthropic/claude-opus-4-6");
    cfg.agents!.defaults!.models = {
      "anthropic/claude-opus-4-6": { agentRuntime: { id: "claude-cli" } },
    };
    cfg.auth = {
      profiles: { "anthropic:default": { provider: "anthropic", mode: "token" } },
      order: { anthropic: ["anthropic:default"] },
    };
    return cfg;
  };

  it.each([
    { model: undefined, source: "auto" },
    { model: "anthropic/claude-opus-4-6@anthropic:default", source: "user" },
  ] as const)(
    "records and runs the stored account a Claude CLI runtime forwards (model=$model)",
    async ({ model, source }) => {
      await saveProfiles({ "anthropic:default": claudeToken() });
      setupClaudeCliBackend();
      const cfg = claudeCliConfig();
      const binding = await captureCronInferenceBinding({ cfg, agentId: "main", model });
      expect(binding).toMatchObject({
        provider: "anthropic",
        profileId: "anthropic:default",
        authRequirement: "subscription",
        source,
      });
      h.resolveConfiguredModelRefMock.mockReturnValue({
        provider: "anthropic",
        model: "claude-opus-4-6",
      });
      let assertCurrent: (() => void) | undefined;
      h.runCliAgentMock.mockImplementation(async (request) => {
        assertCurrent = request.assertCurrent;
        expect(assertCurrent).toBeTypeOf("function");
        assertCurrent?.();
        return {
          payloads: [{ text: "stored account reply" }],
          meta: { agentMeta: { provider: "claude-cli", model: "claude-opus-4-6" } },
        };
      });

      const result = await runWithConfig(cfg, makeAuthJob({ inferenceBinding: binding }));

      expect(result.status, result.error).toBe("ok");
      expect(h.runCliAgentMock).toHaveBeenCalledOnce();
      expect(h.runCliAgentMock.mock.lastCall?.[0]).toMatchObject({
        provider: "claude-cli",
        authProfileId: "anthropic:default",
      });
      expect(h.runCliAgentMock.mock.lastCall?.[0].nativeAuthOnly).toBeUndefined();
      expect(h.runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(() => assertCurrent?.()).toThrow(/disconnected|replaced|settlement/i);
    },
  );

  it.each(["removed", "reconnected"] as const)(
    "rejects a %s account during CLI preparation before credential use",
    async (change) => {
      await saveProfiles({ "anthropic:default": claudeToken() });
      setupClaudeCliBackend();
      const cfg = claudeCliConfig();
      const binding = await captureCronInferenceBinding({ cfg, agentId: "main" });
      h.resolveConfiguredModelRefMock.mockReturnValue({
        provider: "anthropic",
        model: "claude-opus-4-6",
      });
      const credentialUse = vi.fn();
      h.runCliAgentMock.mockImplementation(async (request) => {
        expect(request.assertCurrent).toBeTypeOf("function");
        request.assertCurrent?.();
        await removeAuthProfilesAcrossOwnerStores({
          profileIds: ["anthropic:default"],
          agentDir: state.agentDir(),
        });
        if (change === "reconnected") {
          await saveProfiles({ "anthropic:default": claudeToken() });
        }
        request.assertCurrent?.();
        credentialUse();
        return { payloads: [{ text: "must not run" }], meta: {} };
      });
      const result = await runWithConfig(cfg, makeAuthJob({ inferenceBinding: binding }));
      expect(result.status).toBe("error");
      expect(result.error).toMatch(/disconnected|replaced/i);
      expect(credentialUse).not.toHaveBeenCalled();
    },
  );

  it("leaves a native Claude CLI login unbound and rejects a missing explicit account", async () => {
    await saveProfiles({ "anthropic:default": claudeToken() });
    setupClaudeCliBackend();
    const cfg = claudeCliConfig();

    await expect(
      captureCronInferenceBinding({
        cfg,
        agentId: "main",
        model: "anthropic/claude-opus-4-6@anthropic:claude-cli",
      }),
    ).resolves.toBeUndefined();
    await expect(
      captureCronInferenceBinding({
        cfg,
        agentId: "main",
        model: "anthropic/claude-opus-4-6@anthropic:missing",
      }),
    ).rejects.toThrow(/No credentials found for profile "anthropic:missing"/);
  });

  it("binds an unbound Claude CLI job from an explicit model@profile update", async () => {
    await saveProfiles({ "anthropic:default": claudeToken() });
    setupClaudeCliBackend();
    const cfg = claudeCliConfig();
    const update = async (model: string) => {
      const payload = { kind: "agentTurn" as const, message: "check status", model };
      return await captureCronUpdatedInferenceBinding(
        makeAuthJob({ payload }),
        { payload },
        cfg,
        {} as Parameters<typeof captureCronUpdatedInferenceBinding>[3],
      );
    };

    const selected = await update("anthropic/claude-opus-4-6@anthropic:default");
    try {
      expect(selected?.inferenceBinding).toMatchObject({
        provider: "anthropic",
        profileId: "anthropic:default",
        authRequirement: "subscription",
        source: "user",
      });
    } finally {
      selected?.disposeInferenceAuthorization?.();
    }
    // The native login stays the CLI's own and leaves the job unbound.
    await expect(update("anthropic/claude-opus-4-6@anthropic:claude-cli")).resolves.toBeUndefined();
  });
});
