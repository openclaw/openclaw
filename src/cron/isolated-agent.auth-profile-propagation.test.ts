import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProfileMigrationRequiredError } from "../agents/auth-profiles/legacy-source-diagnostic.js";
import { removeAuthProfilesAcrossOwnerStores } from "../agents/auth-profiles/profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { AuthProfileStoreUnreadableError } from "../agents/auth-profiles/store-unreadable-error.js";
import type { AuthProfileCredential, AuthProfileStore } from "../agents/auth-profiles/types.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import {
  createClaudeCliBackends,
  testing as cliBackendsTesting,
} from "../agents/cli-backends.test-support.js";
import { resolveCliExecutionAuthProfileId } from "../agents/cli-execution-auth.js";
import type { RunEmbeddedAgentInternalParams as AgentRequest } from "../agents/embedded-agent-runner/run/internal-params.js";
import {
  isRecordedModelFallbackStop,
  recordModelFallbackStop,
} from "../agents/model-fallback-stop.js";
import {
  runFallbackModelAttempt,
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../agents/test-helpers/model-fallback-runner.test-support.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import {
  makeIsolatedAgentJobFixture,
  makeIsolatedAgentParamsFixture,
} from "./isolated-agent/job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./isolated-agent/run.suite-helpers.js";
import * as h from "./isolated-agent/run.test-harness.js";
import { resolveCarriedCronModelSelection } from "./isolated-agent/session-carried-model.js";
import { normalizeCronRunErrorText } from "./service/execution-errors.js";
import { loadCronJobsStore, saveCronJobsStore } from "./store.js";
import type { CronStoredJob } from "./types.js";

const runCronIsolatedAgentTurn = await h.loadRunCronIsolatedAgentTurn();
const { resolveAgentDir } = await import("./isolated-agent/run.runtime.js");
// Install the harness before capture loads the shared scheduled-model selector.
const { captureCronInferenceBinding } = await import("./inference-binding.runtime.js");
const { prepareCronRunInference } = await import("./run-inference.js");
const { captureCronUpdatedInferenceBinding } =
  await import("../gateway/server-methods/cron-input-validation.js");
const platformId = "openai:platform";
const subscriptionId = "openai:subscription";
const claudeProfile = "anthropic:default";
const claudeModel = "claude-opus-4-6";
const claudeRef = `anthropic/${claudeModel}`;
const capture = (cfg: OpenClawConfig, model?: string, sessionEntry?: SessionEntry) =>
  captureCronInferenceBinding({ cfg, agentId: "main", model, sessionEntry });
const cliReply = (model: string) => ({
  payloads: [{ text: "account reply" }],
  meta: { agentMeta: { provider: "claude-cli", model } },
});

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
    resolveRuntimeCliBackends: () => {
      const backend = createClaudeCliBackends()[0]!;
      backend.authEpochMode = "profile-only";
      backend.autoSelectAuthProfile = false;
      return [backend];
    },
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
    h.loadModelCatalogOwnerMock.mockImplementation(async ({ config: cfg, agentId = "main" }) => ({
      agentId,
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      config: cfg,
      modelCatalog: { entries: [], routeVariants: [] },
    }));
    h.resolveConfiguredModelRefMock.mockReturnValue({ provider: "openai", model: "gpt-4.1" });
    h.resolveAllowedModelRefMock.mockReturnValue({ ref: { provider: "openai", model: "gpt-4.1" } });
    h.mockRunCronFallbackPassthrough();
  });

  afterEach(async () => {
    cliBackendsTesting.resetDepsForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    await state.cleanup();
  });

  it("leases the creator's account through settlement and releases it after the turn", async () => {
    const profileId = platformId;
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
    const binding = await capture(cfg, undefined, creator);
    const other = subscriptionId;
    let assertLease: (() => void) | undefined;
    h.runEmbeddedAgentMock.mockImplementation(async (request: AgentRequest) => {
      expect(request).toMatchObject({
        authProfileId: profileId,
        authProfileIdSource: "auto",
        authProfileBinding: { profileId, authRequirement: "api-key" },
        allowAuthProfileFallback: false,
        authProfileFailurePolicy: "local_transient",
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
    h.runCliAgentMock.mockResolvedValue(cliReply("sonnet"));

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
      h.runCliAgentMock.mockResolvedValue(cliReply("gpt-4o"));

      const result = await runWithConfig(cfg, undefined, trigger);

      expect(h.runEmbeddedAgentMock).toHaveBeenCalledOnce();
      if (trigger === "cron") {
        expect(result.status).toBe("error");
        expect(result.error).toContain("Automation has no recorded inference account");
        // The refusal names the runtime and account, and the exact command that records it.
        expect(result.error).toContain(
          "Runtime claude-cli would run openai/gpt-4o with stored account claude-cli:personal",
        );
        expect(result.error).toContain(
          "openclaw automations edit <jobId> --model openai/gpt-4o@claude-cli:personal",
        );
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
    "explains a legacy bound account refusal for $trigger with cli=$cli (#144047)",
    async ({ trigger, cli }) => {
      await saveProfiles({ "openai:work": apiKey(), "claude-cli:personal": oauth("claude-cli") });
      const cfg = config();
      const captured = await capture(cfg, "openai/gpt-4.1@openai:work");
      expect(captured).toMatchObject({ profileId: "openai:work", source: "user" });
      // Captured before bindings recorded their runtime, so the run derives one as before.
      const { runtime: _runtime, ...binding } = captured!;
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
      expect(result.error).toContain("account openai:work (no recorded runtime)");
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

  it("keeps a bound job on its recorded runtime when config moves its model to a CLI", async () => {
    await saveProfiles({ "openai:work": apiKey(), "claude-cli:personal": oauth("claude-cli") });
    const cfg = config();
    const binding = await capture(cfg, "openai/gpt-4.1@openai:work");
    expect(binding?.runtime).toBeTruthy();
    setupClaudeCliBackend();
    h.resolveConfiguredModelRefMock.mockReturnValue({ provider: "openai", model: "gpt-4o" });
    cfg.agents!.defaults!.model = "openai/gpt-4o";
    cfg.agents!.defaults!.models = { "openai/gpt-4o": { agentRuntime: { id: "claude-cli" } } };
    h.runEmbeddedAgentMock.mockImplementation(async (request: AgentRequest) => {
      expect(request.authProfileBinding?.profileId).toBe("openai:work");
      expect(request.agentHarnessRuntimeOverride).toBe(binding?.runtime);
      request.userTurnTranscriptRecorder?.markBlocked();
      return { payloads: [{ text: "recorded runtime" }], meta: { agentMeta: {} } };
    });

    const result = await runWithConfig(cfg, makeAuthJob({ inferenceBinding: binding }));

    expect(result.status, result.error).toBe("ok");
    expect(h.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(h.runCliAgentMock).not.toHaveBeenCalled();
  });

  // Claude CLI forwards a stored Anthropic account the same way interactive chat does.
  const claudeCliConfig = async (): Promise<OpenClawConfig> => {
    await saveProfiles({ [claudeProfile]: claudeToken() });
    setupClaudeCliBackend();
    const cfg = config(claudeRef);
    cfg.agents!.defaults!.models = { [claudeRef]: { agentRuntime: { id: "claude-cli" } } };
    cfg.auth = {
      profiles: { [claudeProfile]: { provider: "anthropic", mode: "token" } },
      order: { anthropic: [claudeProfile] },
    };
    h.resolveConfiguredModelRefMock.mockReturnValue({
      provider: "anthropic",
      model: claudeModel,
    });
    h.resolveAllowedModelRefMock.mockReturnValue({
      ref: { provider: "anthropic", model: claudeModel },
    });
    return cfg;
  };

  it.each([
    { model: undefined, source: "auto" },
    { model: `${claudeRef}@${claudeProfile}`, source: "user" },
  ] as const)(
    "records and runs the stored account a Claude CLI runtime forwards (model=$model)",
    async ({ model, source }) => {
      const cfg = await claudeCliConfig();
      const binding = await capture(cfg, model);
      expect(binding).toMatchObject({
        provider: "anthropic",
        profileId: claudeProfile,
        authRequirement: "subscription",
        source,
      });
      let assertCurrent: (() => void) | undefined;
      h.runCliAgentMock.mockImplementation(async (request) => {
        assertCurrent = request.assertCurrent;
        expect(assertCurrent).toBeTypeOf("function");
        assertCurrent?.();
        return cliReply(claudeModel);
      });

      const result = await runWithConfig(cfg, makeAuthJob({ inferenceBinding: binding }));

      expect(result.status, result.error).toBe("ok");
      expect(h.runCliAgentMock).toHaveBeenCalledOnce();
      expect(h.runCliAgentMock.mock.lastCall?.[0]).toMatchObject({
        provider: "claude-cli",
        authProfileId: claudeProfile,
      });
      expect(h.runCliAgentMock.mock.lastCall?.[0].nativeAuthOnly).toBeUndefined();
      expect(h.runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(() => assertCurrent?.()).toThrow(/disconnected|replaced|settlement/i);
    },
  );

  it.each(["migration", "unreadable", "abort", "terminal"] as const)(
    "preserves a CLI account %s failure after acquiring scheduled authorization",
    async (kind) => {
      const cfg = await claudeCliConfig();
      const binding = await capture(cfg);
      const inference = await prepareCronRunInference({ binding, cfg, agentDir: state.agentDir() });
      if (!inference) {
        throw new Error("Expected the captured account's run authorization");
      }
      const secret = "sk-abcdefghijklmnopqrstuv";
      const failure =
        kind === "migration"
          ? new AuthProfileMigrationRequiredError({ agentDir: state.agentDir(), sources: [] })
          : kind === "unreadable"
            ? new AuthProfileStoreUnreadableError(state.statePath("unreadable.sqlite"))
            : new Error(`Authorization: Bearer ${secret}`);
      if (kind === "abort") {
        failure.name = "AbortError";
      } else if (kind === "terminal") {
        recordModelFallbackStop(failure);
      }
      try {
        // Fail the resolver's second store read, after the saved account was admitted.
        // Failing initial authorization would never reach the compatibility wrapper.
        await expect(
          inference.resolveCliAuthProfile((selected) =>
            resolveCliExecutionAuthProfileId({
              cliExecutionProvider: "claude-cli",
              authProfileProvider: "anthropic",
              config: cfg,
              agentDir: state.agentDir(),
              selected,
              loadAuthProfileStoreForRuntimeAsync: async () => {
                throw failure;
              },
            }),
          ),
        ).rejects.toBe(failure);
        const message = normalizeCronRunErrorText(failure);
        expect(message).not.toContain(secret);
        expect(message).not.toContain("incompatible with its recorded inference account");
        if (
          failure instanceof AuthProfileMigrationRequiredError ||
          failure instanceof AuthProfileStoreUnreadableError
        ) {
          expect(message).toContain(failure.code);
          expect(message).toContain("openclaw doctor --fix");
        }
        expect(isRecordedModelFallbackStop(failure)).toBe(kind === "terminal");
      } finally {
        inference.dispose();
      }
    },
  );

  it.each(["missing", "incompatible"] as const)(
    "keeps account adoption advice for a %s CLI profile",
    async (kind) => {
      const cfg = await claudeCliConfig();
      const binding = await capture(cfg);
      const inference = await prepareCronRunInference({ binding, cfg, agentDir: state.agentDir() });
      if (!inference) {
        throw new Error("Expected the captured account's run authorization");
      }
      try {
        await expect(
          inference.resolveCliAuthProfile((selected) =>
            resolveCliExecutionAuthProfileId({
              cliExecutionProvider: "claude-cli",
              authProfileProvider: "anthropic",
              config: cfg,
              agentDir: state.agentDir(),
              selected,
              loadAuthProfileStoreForRuntimeAsync: async (): Promise<AuthProfileStore> => ({
                version: 1,
                profiles: kind === "missing" ? {} : { [claudeProfile]: apiKey() },
              }),
            }),
          ),
        ).rejects.toMatchObject({
          message: expect.stringContaining("--model <provider/model>@<profileId>"),
          cause: expect.objectContaining({ name: "CliExecutionAuthProfileError" }),
        });
      } finally {
        inference.dispose();
      }
    },
  );

  it.each(["removed", "reconnected"] as const)(
    "rejects a %s account during CLI preparation before credential use",
    async (change) => {
      const cfg = await claudeCliConfig();
      const binding = await capture(cfg);
      const credentialUse = vi.fn();
      h.runCliAgentMock.mockImplementation(async (request) => {
        expect(request.assertCurrent).toBeTypeOf("function");
        request.assertCurrent?.();
        await removeAuthProfilesAcrossOwnerStores({
          profileIds: [claudeProfile],
          agentDir: state.agentDir(),
        });
        if (change === "reconnected") {
          await saveProfiles({ [claudeProfile]: claudeToken() });
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
    const cfg = await claudeCliConfig();

    await expect(capture(cfg, `${claudeRef}@anthropic:claude-cli`)).resolves.toBeUndefined();
    await expect(capture(cfg, `${claudeRef}@anthropic:missing`)).rejects.toThrow(
      /No credentials found for profile "anthropic:missing"/,
    );
  });

  it("binds an unbound Claude CLI job from an explicit model@profile update", async () => {
    const cfg = await claudeCliConfig();
    const update = async (model: string) => {
      const payload = { kind: "agentTurn" as const, message: "check status", model };
      return await captureCronUpdatedInferenceBinding(
        makeAuthJob({ payload }),
        { payload },
        cfg,
        {} as Parameters<typeof captureCronUpdatedInferenceBinding>[3],
      );
    };

    const selected = await update(`${claudeRef}@${claudeProfile}`);
    try {
      expect(selected?.inferenceBinding).toMatchObject({
        provider: "anthropic",
        profileId: claudeProfile,
        authRequirement: "subscription",
        source: "user",
      });
    } finally {
      selected?.disposeInferenceAuthorization?.();
    }
    // The native login stays the CLI's own and leaves the job unbound.
    await expect(update(`${claudeRef}@anthropic:claude-cli`)).resolves.toBeUndefined();
  });

  it("keeps the recorded runtime when an edit selects a different account", async () => {
    const cfg = await embeddedAnthropicConfig({
      type: "api_key",
      provider: "anthropic",
      key: "synthetic-anthropic-key",
    });
    const recorded = await captureFromCreator(cfg, claudeCliCreator());
    expect(recorded?.runtime).toBe("claude-cli");
    const payload = {
      kind: "agentTurn" as const,
      message: "check status",
      model: `${claudeRef}@${claudeProfile}`,
    };

    // Config alone would pick the embedded runtime; the job keeps the one it runs on.
    const edited = await captureCronUpdatedInferenceBinding(
      makeAuthJob({ payload, inferenceBinding: recorded }),
      { payload },
      cfg,
      {} as Parameters<typeof captureCronUpdatedInferenceBinding>[3],
    );
    try {
      expect(edited?.inferenceBinding).toMatchObject({
        profileId: claudeProfile,
        source: "user",
        runtime: "claude-cli",
      });
    } finally {
      edited?.disposeInferenceAuthorization?.();
    }
  });

  it("rejects an account edit that would move the job off its unavailable recorded runtime", async () => {
    const cfg = await embeddedAnthropicConfig({
      type: "api_key",
      provider: "anthropic",
      key: "synthetic-anthropic-key",
    });
    const recorded = await captureFromCreator(cfg, claudeCliCreator());
    expect(recorded?.runtime).toBe("claude-cli");
    // claude-cli stops being a CLI backend for this config after capture.
    h.isCliProviderMock.mockImplementation(() => false);
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [],
      resolvePluginSetupCliBackend: () => undefined,
    });
    const payload = {
      kind: "agentTurn" as const,
      message: "check status",
      model: `${claudeRef}@${claudeProfile}`,
    };
    const job = makeAuthJob({ payload, inferenceBinding: recorded });

    await expect(
      captureCronUpdatedInferenceBinding(
        job,
        { payload },
        cfg,
        {} as Parameters<typeof captureCronUpdatedInferenceBinding>[3],
      ),
    ).rejects.toThrow(/runs on runtime claude-cli, which is unavailable/);
    expect(job.inferenceBinding).toBe(recorded);
  });
  // The Oct 20 shape: a `current` job created from a conversation that runs Claude through
  // claude-cli, on an Anthropic model the config alone would run embedded, with a stored
  // Anthropic key. The run copies the conversation's runtime, so capture must resolve it too.
  const claudeCliCreator = (): SessionEntry => ({
    sessionId: "creator-session",
    updatedAt: 1,
    modelOverride: claudeModel,
    providerOverride: "anthropic",
    modelOverrideSource: "user",
    agentRuntimeOverride: "claude-cli",
  });
  const embeddedAnthropicConfig = async (credential: AuthProfileCredential) => {
    await saveProfiles({ [claudeProfile]: credential });
    setupClaudeCliBackend();
    const cfg = config(claudeRef);
    cfg.auth = {
      profiles: {
        [claudeProfile]: {
          provider: "anthropic",
          mode: credential.type === "api_key" ? "api_key" : "token",
        },
      },
      order: { anthropic: [claudeProfile] },
    };
    h.resolveConfiguredModelRefMock.mockReturnValue({ provider: "anthropic", model: claudeModel });
    h.resolveAllowedModelRefMock.mockReturnValue({
      ref: { provider: "anthropic", model: claudeModel },
    });
    return cfg;
  };
  // Same inputs as cron.add for a `current` job: the creator's auth, its carried runtime.
  const captureFromCreator = (cfg: OpenClawConfig, creatorEntry: SessionEntry) =>
    captureCronInferenceBinding({
      cfg,
      agentId: "main",
      sessionEntry: creatorEntry,
      runtimeSessionEntry: resolveCarriedCronModelSelection(creatorEntry),
    });
  const runCopyingCreator = (cfg: OpenClawConfig, job: CronStoredJob) => {
    // The run's cron session carries the creator's model and runtime, as session.ts copies them.
    h.resolveCronSessionMock.mockResolvedValue(
      h.makeCronSession({
        sessionEntry: h.makeCronSessionEntry(resolveCarriedCronModelSelection(claudeCliCreator())),
      }),
    );
    return runWithConfig(cfg, job);
  };

  it("binds the account a claude-cli creator's job always paid with and records claude-cli", async () => {
    const cfg = await embeddedAnthropicConfig({
      type: "api_key",
      provider: "anthropic",
      key: "synthetic-anthropic-key",
    });
    const binding = await captureFromCreator(cfg, claudeCliCreator());
    // The account is the one capture bound before runtimes were recorded; only the runtime is new.
    expect(binding).toMatchObject({
      provider: "anthropic",
      profileId: claudeProfile,
      authRequirement: "api-key",
      runtime: "claude-cli",
    });
    h.runCliAgentMock.mockResolvedValue(cliReply(claudeModel));

    const result = await runCopyingCreator(cfg, makeAuthJob({ inferenceBinding: binding }));

    // claude-cli runs with the recorded key, as the job did before.
    expect(result.status, result.error).toBe("ok");
    expect(h.runCliAgentMock.mock.lastCall?.[0]).toMatchObject({
      provider: "claude-cli",
      authProfileId: claudeProfile,
    });
    expect(h.runCliAgentMock.mock.lastCall?.[0].nativeAuthOnly).toBeUndefined();
    expect(h.runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("resolves a binding recorded without a runtime exactly as before", async () => {
    const cfg = await embeddedAnthropicConfig({
      type: "api_key",
      provider: "anthropic",
      key: "synthetic-anthropic-key",
    });
    const { runtime: _runtime, ...legacy } = (await capture(cfg))!;
    h.runCliAgentMock.mockResolvedValue(cliReply(claudeModel));

    // The cron session's copied claude-cli override still selects the runtime.
    const result = await runCopyingCreator(cfg, makeAuthJob({ inferenceBinding: legacy }));

    expect(result.status, result.error).toBe("ok");
    expect(h.runCliAgentMock.mock.lastCall?.[0]).toMatchObject({
      provider: "claude-cli",
      authProfileId: claudeProfile,
    });
    expect(h.runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("records the forwarded account with its claude-cli runtime and runs on that runtime", async () => {
    const cfg = await embeddedAnthropicConfig(claudeToken());
    const binding = await captureFromCreator(cfg, claudeCliCreator());
    expect(binding).toMatchObject({
      provider: "anthropic",
      profileId: claudeProfile,
      runtime: "claude-cli",
    });
    h.runCliAgentMock.mockResolvedValue(cliReply(claudeModel));

    const result = await runCopyingCreator(cfg, makeAuthJob({ inferenceBinding: binding }));

    expect(result.status, result.error).toBe("ok");
    expect(h.runCliAgentMock.mock.lastCall?.[0]).toMatchObject({
      provider: "claude-cli",
      authProfileId: claudeProfile,
    });
    expect(h.runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("runs a bound job on its captured runtime, not the runtime its cron session copied", async () => {
    const cfg = await embeddedAnthropicConfig(claudeToken());
    const binding = await capture(cfg);
    expect(binding?.runtime).toBeTruthy();
    expect(binding?.runtime).not.toBe("claude-cli");
    h.runEmbeddedAgentMock.mockImplementation(async (request: AgentRequest) => {
      expect(request.authProfileBinding?.profileId).toBe(claudeProfile);
      request.userTurnTranscriptRecorder?.markBlocked();
      return { payloads: [{ text: "captured runtime" }], meta: { agentMeta: {} } };
    });

    const result = await runCopyingCreator(cfg, makeAuthJob({ inferenceBinding: binding }));

    expect(result.status, result.error).toBe("ok");
    expect(h.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(h.runCliAgentMock).not.toHaveBeenCalled();
  });

  it("refuses a bound job whose captured runtime the config no longer allows", async () => {
    const cfg = await embeddedAnthropicConfig(claudeToken());
    const binding = await captureFromCreator(cfg, claudeCliCreator());
    expect(binding?.runtime).toBe("claude-cli");
    // claude-cli stops being a CLI backend for this config after capture.
    h.isCliProviderMock.mockImplementation(() => false);
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [],
      resolvePluginSetupCliBackend: () => undefined,
    });

    const result = await runCopyingCreator(cfg, makeAuthJob({ inferenceBinding: binding }));

    expect(result.status).toBe("error");
    expect(result.error).toContain(`account ${claudeProfile} on runtime claude-cli`);
    expect(result.error).toContain("captured for runtime claude-cli");
    expect(h.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(h.runCliAgentMock).not.toHaveBeenCalled();
  });

  it.each(["embedded", "cli"] as const)(
    "fails a %s job whose stored account was removed with one message naming account and runtime",
    async (route) => {
      const cfg =
        route === "cli" ? await claudeCliConfig() : await embeddedAnthropicConfig(claudeToken());
      const binding = await capture(cfg);
      if (!binding?.runtime) {
        throw new Error("Expected a binding with its captured runtime");
      }
      await removeAuthProfilesAcrossOwnerStores({
        profileIds: [claudeProfile],
        agentDir: state.agentDir(),
      });
      clearRuntimeAuthProfileStoreSnapshots();

      const result = await runWithConfig(cfg, makeAuthJob({ inferenceBinding: binding }));

      expect(result.status).toBe("error");
      expect(result.error).toContain(
        `Automation inference account ${claudeProfile} on runtime ${binding.runtime} was removed or signed out`,
      );
      expect(h.runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(h.runCliAgentMock).not.toHaveBeenCalled();
    },
  );
});
