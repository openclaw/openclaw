import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureAuthProfileAuthorization } from "../agents/auth-profiles/authorization.js";
import { removeAuthProfilesAcrossOwnerStores } from "../agents/auth-profiles/profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import {
  createClaudeCliBackends,
  testing as cliBackendsTesting,
} from "../agents/cli-backends.test-support.js";
import type { RunEmbeddedAgentInternalParams as AgentRequest } from "../agents/embedded-agent-runner/run/internal-params.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
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

  it("pins the saved runtime even when model config selects a different one", async () => {
    await saveProfiles({ [platformId]: apiKey() });
    const cfg = config();
    cfg.agents!.defaults!.models = { "openai/gpt-4.1": { agentRuntime: { id: "claude-cli" } } };
    setupClaudeCliBackend();
    const job = makeAuthJob({
      payload: {
        kind: "agentTurn",
        message: "Check status",
        model: "openai/gpt-4.1@openai:platform",
        modelRuntime: "openclaw",
      },
    });
    const result = await runWithConfig(cfg, job);
    expect(result.status, result.error).toBe("ok");
    expect(h.runEmbeddedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: platformId, allowAuthProfileFallback: false }),
    );
    expect(h.runCliAgentMock).not.toHaveBeenCalled();
  });

  it.each(["embedded", "cli"] as const)(
    "fails a %s job whose stored account was removed with one message naming account and runtime",
    async (route) => {
      const claudeProfile = "anthropic:default";
      const model = "claude-opus-4-6";
      const modelRef = `anthropic/${model}`;
      const runtime = route === "cli" ? "claude-cli" : "openclaw";
      await saveProfiles({
        [claudeProfile]: { type: "token", provider: "anthropic", token: "synthetic-claude-token" },
      });
      setupClaudeCliBackend();
      const cfg = config(modelRef);
      cfg.agents!.defaults!.models = { [modelRef]: { agentRuntime: { id: runtime } } };
      cfg.auth = { profiles: { [claudeProfile]: { provider: "anthropic", mode: "token" } } };
      h.resolveConfiguredModelRefMock.mockReturnValue({ provider: "anthropic", model });
      h.resolveAllowedModelRefMock.mockReturnValue({ ref: { provider: "anthropic", model } });
      const captured = await captureAuthProfileAuthorization({
        cfg,
        agentDir: state.agentDir(),
        profileId: claudeProfile,
        assertCurrent() {},
      });
      const job = makeAuthJob({
        payload: {
          kind: "agentTurn",
          message: "Check status",
          model: `${modelRef}@${claudeProfile}`,
          modelRuntime: runtime,
        },
        modelAuthProfileAuthorizationId: captured.authorizationId,
      });
      captured.dispose();
      await removeAuthProfilesAcrossOwnerStores({
        profileIds: [claudeProfile],
        agentDir: state.agentDir(),
      });
      clearRuntimeAuthProfileStoreSnapshots();

      const result = await runWithConfig(cfg, job);

      expect(result.status).toBe("error");
      expect(result.error).toContain(
        `runs on account ${claudeProfile}, which was removed or signed out`,
      );
      expect(result.error).toContain("list accounts: openclaw gateway call models.authStatus");
      expect(result.error).toContain(
        "To use the agent’s normal account selection: openclaw automations edit test-job --model <provider/model>.",
      );
      // The pause decision reads the producer's code, not this text.
      expect(result.errorClassification).toEqual({ kind: "permanent" });
      expect(result.failureNotificationDetail).toEqual({ kind: "inference-account-retired" });
      expect(h.runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(h.runCliAgentMock).not.toHaveBeenCalled();
    },
  );
});
