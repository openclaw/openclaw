// Exercise durable auth identity through isolated cron orchestration, stopping at provider I/O.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureAuthProfileAuthorization } from "../agents/auth-profiles/authorization.js";
import { setAuthProfileOrder } from "../agents/auth-profiles/profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { updateAuthProfileStoreWithLock } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import type { RunEmbeddedAgentInternalParams } from "../agents/embedded-agent-runner/run/internal-params.js";
import { resolveCronAgentLane } from "../agents/lanes.js";
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
import { captureCronInferenceBinding } from "./inference-binding.runtime.js";
import {
  makeIsolatedAgentJobFixture,
  makeIsolatedAgentParamsFixture,
} from "./isolated-agent/job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./isolated-agent/run.suite-helpers.js";
import {
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  makeCronSessionEntry,
  mockRunCronFallbackPassthrough,
  resolveConfiguredModelRefMock,
  resolveCronAgentLaneMock,
  resolveCronSessionMock,
  resolveSessionAuthSelectionMock,
  runCliAgentMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./isolated-agent/run.test-harness.js";
import { loadCronJobsStore, saveCronJobsStore } from "./store.js";
import type { CronStoredJob } from "./types.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const { resolveAgentDir } = await import("./isolated-agent/run.runtime.js");
const platformId = "openai:platform";
const subscriptionId = "openai:subscription";

function runWithConfig(
  cfg: OpenClawConfig,
  job: CronStoredJob = makeIsolatedAgentJobFixture({
    agentId: "main",
    delivery: { mode: "none" },
    payload: { kind: "agentTurn", message: "check status" },
  }),
  trigger?: "cron" | "event",
) {
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

function oauth(provider = "openai"): AuthProfileCredential {
  return {
    type: "oauth",
    provider,
    access: "synthetic-subscription-access",
    refresh: "synthetic-subscription-refresh",
    expires: Date.now() + 3_600_000,
    accountId: "synthetic-account",
  };
}

function apiKey(): AuthProfileCredential {
  return { type: "api_key", provider: "openai", key: "synthetic-platform-key" };
}

describe("runCronIsolatedAgentTurn auth profile propagation (#20624, #90991)", () => {
  setupRunCronIsolatedAgentTurnSuite();
  let state: OpenClawTestState;

  async function saveProfiles(profiles: Record<string, AuthProfileCredential>) {
    await persistAuthProfileBatch({
      profiles: Object.entries(profiles).map(([profileId, credential]) => ({
        profileId,
        credential,
      })),
    });
  }

  function config(primary = "openai/gpt-4.1"): OpenClawConfig {
    return {
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
    };
  }

  beforeEach(async () => {
    state = await createOpenClawTestState({
      label: "cron-auth-propagation",
      env: { OPENAI_API_KEY: undefined, OPENAI_OAUTH_TOKEN: undefined },
    });
    // The real credential owner resolves the canonical main directory, not a custom test root.
    vi.mocked(resolveAgentDir).mockReturnValue(state.agentDir());
  });

  afterEach(async () => {
    cliBackendsTesting.resetDepsForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    await state.cleanup();
  });

  it.each([
    { profileId: platformId, mode: "API-key", requirement: "api-key" },
    { profileId: subscriptionId, mode: "OAuth", requirement: "subscription" },
  ] as const)(
    "forwards the creator's durable $mode account on fresh runs despite opposite current auth",
    async ({ profileId, requirement }) => {
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
      expect(binding).toMatchObject({
        version: 1,
        provider: "openai",
        profileId,
        source: "auto",
        authRequirement: requirement,
      });
      expect(creator.authProfileOverrideSource).toBe("auto");
      const authority = await captureAuthProfileAuthorization({
        profileId,
        agentDir: state.agentDir(),
        cfg,
        assertCurrent() {},
      });
      try {
        expect(binding?.authorizationId).toBe(authority.authorizationId);
        authority.assertCurrent();
      } finally {
        authority.dispose();
      }
      const job: CronStoredJob = {
        id: "durable-auth",
        name: "Durable auth",
        agentId: "main",
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 1,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        delivery: { mode: "none" },
        payload: { kind: "agentTurn", message: "check status" },
        state: {},
        inferenceBinding: binding,
      };
      const storePath = state.statePath("cron", "jobs.json");
      await saveCronJobsStore(storePath, { version: 1, jobs: [job] });
      const other = profileId === platformId ? subscriptionId : platformId;
      await setAuthProfileOrder({
        agentDir: state.agentDir(),
        provider: "openai",
        order: [other, profileId],
      });
      await updateAuthProfileStoreWithLock({
        agentDir: state.agentDir(),
        updater(store) {
          store.lastGood = { openai: other };
          return true;
        },
      });
      resolveCronAgentLaneMock.mockImplementation(resolveCronAgentLane);
      resolveSessionAuthSelectionMock.mockResolvedValue({
        profileId: other,
        source: "auto",
        routeRequirement: requirement === "api-key" ? "subscription" : "api-key",
      });
      mockRunCronFallbackPassthrough();
      const liveAssertions: Array<() => void> = [];
      runEmbeddedAgentMock.mockImplementation(async (request: RunEmbeddedAgentInternalParams) => {
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
        liveAssertions.push(assertCurrent);
        request.userTurnTranscriptRecorder?.markBlocked();
        return { payloads: [{ text: "same authorized account" }], meta: { agentMeta: {} } };
      });

      let previousSessionEntry: ReturnType<typeof makeCronSessionEntry> | undefined;
      for (const [index, model] of ["gpt-4.1", "gpt-4o"].entries()) {
        // Close the real SQLite owners before each load: neither job nor credential comes from a warm handle.
        clearRuntimeAuthProfileStoreSnapshots();
        await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
        const reloaded = (await loadCronJobsStore(storePath)).jobs[0];
        expect(reloaded?.inferenceBinding).toEqual(binding);
        if (!reloaded) {
          throw new Error("Expected the persisted automation");
        }
        const changed = config(`openai/${model}@${other}`);
        changed.auth!.order = { openai: [other, profileId] };
        resolveConfiguredModelRefMock.mockReturnValue({ provider: "openai", model });
        const cronSession = makeCronSession({
          sessionEntry: makeCronSessionEntry({ sessionId: `fresh-run-${index}` }),
          initialSessionEntry: previousSessionEntry,
        });
        resolveCronSessionMock.mockReturnValue(cronSession);
        const result = await runWithConfig(changed, reloaded);
        previousSessionEntry = cronSession.sessionEntry;
        expect(result.status).toBe("ok");
        expect(result.sessionId).toBe(`fresh-run-${index}`);
        expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(index + 1);
        expect(runEmbeddedAgentMock.mock.lastCall?.[0]).toMatchObject({
          provider: "openai",
          model,
        });
        expect(resolveSessionAuthSelectionMock).not.toHaveBeenCalled();
        // The assertion is backed by a per-run owner lease, not a permanently valid closure.
        expect(() => liveAssertions[index]!()).toThrow(/disconnected|replaced/i);
      }
      expect(runCliAgentMock).not.toHaveBeenCalled();
    },
  );

  it("executes a reloaded native-owned job without resolving its irrelevant host profile", async () => {
    const runtimeAuthority = {
      version: 1 as const,
      runtimeId: "openclaw",
      namespace: "synthetic.inference",
      payload: { account: "synthetic-native-account" },
    };
    const job = makeIsolatedAgentJobFixture({
      agentId: "main",
      runtimeAuthority,
      payload: {
        kind: "agentTurn",
        message: "check status",
        model: "openai/gpt-4.1@openai:missing-native-only",
      },
      delivery: { mode: "none" },
    });
    const storePath = state.statePath("cron", "jobs.json");
    await saveCronJobsStore(storePath, { version: 1, jobs: [job] });
    const reloaded = (await loadCronJobsStore(storePath)).jobs[0];
    if (!reloaded) {
      throw new Error("Expected the native-owned persisted job");
    }
    resolveSessionAuthSelectionMock.mockRejectedValue(new Error("Host auth must not be resolved"));
    mockRunCronFallbackPassthrough();
    runEmbeddedAgentMock.mockImplementation(async (request: RunEmbeddedAgentInternalParams) => {
      expect(request.scheduledRuntimeAuthority).toEqual(runtimeAuthority);
      expect(request.authProfileId).toBeUndefined();
      expect(request.authProfileBinding).toBeUndefined();
      request.userTurnTranscriptRecorder?.markBlocked();
      return { payloads: [{ text: "native authorized account" }], meta: { agentMeta: {} } };
    });
    const result = await runWithConfig(config(), reloaded);
    expect(result.status, result.error).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(resolveSessionAuthSelectionMock).not.toHaveBeenCalled();
    expect(runCliAgentMock).not.toHaveBeenCalled();
  });

  it("runs a native Claude CLI job without adopting an unrelated host account", async () => {
    await saveProfiles({ [platformId]: apiKey() });
    setupClaudeCliBackend();
    isCliProviderMock.mockImplementation((provider: string) => provider === "claude-cli");
    resolveConfiguredModelRefMock.mockReturnValue({ provider: "claude-cli", model: "sonnet" });
    resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
    mockRunCronFallbackPassthrough();
    runCliAgentMock.mockResolvedValue({
      payloads: [{ text: "native account reply" }],
      meta: { agentMeta: { provider: "claude-cli", model: "sonnet" } },
    });

    const result = await runWithConfig(config("claude-cli/sonnet"));

    expect(result.status, result.error).toBe("ok");
    expect(runCliAgentMock).toHaveBeenCalledOnce();
    expect(runCliAgentMock.mock.lastCall?.[0].authProfileId).toBeUndefined();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it.each(["cron", "event"] as const)(
    "keeps %s CLI fallback on its account boundary (#144047)",
    async (trigger) => {
      isCliProviderMock.mockImplementation((provider: string) => provider === "claude-cli");
      setupClaudeCliBackend();
      resolveConfiguredModelRefMock.mockReturnValue({ provider: "openai", model: "gpt-4.1" });
      resolveSessionAuthSelectionMock.mockResolvedValue({ profileId: platformId, source: "auto" });
      await saveProfiles({ [platformId]: apiKey(), "claude-cli:personal": oauth("claude-cli") });
      runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => {
        await runInitialModelFallbackAttempt(params);
        return {
          result: await runFallbackModelAttempt(params, "openai", "gpt-4o", "unknown"),
          provider: "openai",
          model: "gpt-4o",
          attempts: [],
        };
      });
      const cfg = config();
      cfg.agents!.defaults!.model = { primary: "openai/gpt-4.1", fallbacks: ["openai/gpt-4o"] };
      cfg.agents!.defaults!.models = { "openai/gpt-4o": { agentRuntime: { id: "claude-cli" } } };
      cfg.auth!.order = { "claude-cli": ["claude-cli:personal"] };
      runCliAgentMock.mockResolvedValue({
        payloads: [{ text: "event account reply" }],
        meta: { agentMeta: { provider: "claude-cli", model: "gpt-4o" } },
      });

      const result = await runWithConfig(cfg, undefined, trigger);

      expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
      if (trigger === "cron") {
        expect(result.status).toBe("error");
        expect(result.error).toContain("Automation has no recorded inference account");
        expect(runCliAgentMock).not.toHaveBeenCalled();
      } else {
        expect(result.status, result.error).toBe("ok");
        expect(runCliAgentMock).toHaveBeenCalledOnce();
        expect(runCliAgentMock.mock.lastCall?.[0].trigger).toBe("event");
        expect(runCliAgentMock.mock.lastCall?.[0].nativeAuthOnly).toBeUndefined();
        expect(runCliAgentMock.mock.lastCall?.[0].authProfileId).toBe("claude-cli:personal");
      }
    },
  );

  it.each(["cron", "event"] as const)(
    "fails closed for a bound account on a %s CLI route (#144047)",
    async (trigger) => {
      await saveProfiles({ "openai:work": apiKey(), "claude-cli:personal": oauth("claude-cli") });
      const cfg = config();
      const binding = await captureCronInferenceBinding({
        cfg,
        agentId: "main",
        model: "openai/gpt-4.1@openai:work",
      });
      expect(binding).toMatchObject({ profileId: "openai:work", source: "user" });
      isCliProviderMock.mockImplementation((provider: string) => provider === "claude-cli");
      mockRunCronFallbackPassthrough();
      setupClaudeCliBackend();
      resolveConfiguredModelRefMock.mockReturnValue({ provider: "openai", model: "gpt-4o" });
      cfg.agents!.defaults!.model = "openai/gpt-4o";
      cfg.agents!.defaults!.models = { "openai/gpt-4o": { agentRuntime: { id: "claude-cli" } } };
      cfg.auth!.order = { "claude-cli": ["claude-cli:personal"] };

      const result = await runWithConfig(
        cfg,
        makeIsolatedAgentJobFixture({ agentId: "main", inferenceBinding: binding }),
        trigger,
      );

      expect(result.status).toBe("error");
      expect(result.error).toContain("incompatible with its recorded inference account and route");
      expect(resolveSessionAuthSelectionMock).not.toHaveBeenCalled();
      expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(runCliAgentMock).not.toHaveBeenCalled();
    },
  );
});
