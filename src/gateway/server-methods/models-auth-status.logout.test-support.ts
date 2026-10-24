import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { AuthProfileStore, RuntimeAuthProfileStore } from "../../agents/auth-profiles.js";
import { createAuthProfileStoreFixture } from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import * as rpcSources from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { createRpcSourceForTest } from "../test-helpers.rpc-source.js";
import { modelsAuthStatusHandlers } from "./models-auth-status.js";
import type { ModelAuthLogoutResult, ModelAuthStatusResult } from "./models-auth-status.types.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type RespondOptions = GatewayRequestHandlerOptions & { respond: ReturnType<typeof vi.fn> };
type OAuthCredential = Extract<AuthProfileStore["profiles"][string], { type: "oauth" }>;

function createActiveRun(
  runId: string,
  providerId: string,
  authProviderId?: string,
  agentId = "main",
) {
  const identity = {
    sessionId: `session-${providerId}`,
    sessionKey: `agent:${agentId}:${providerId}`,
    agentId,
  };
  return createRpcSourceForTest({ providerId, authProviderId }, { ...identity, runId });
}

export function registerModelAuthLogoutTests({
  mocks,
  readAuthStatus,
  useRealHealth,
  setPreparedProfiles,
  setPreparedAuthStore,
  createLogoutOptions,
  expectSuccess,
  expectInvalid,
  expectUnknownAgentId,
  oauthCredential,
}: {
  mocks: {
    getRuntimeConfig: Mock;
    listAgentIds: Mock;
    resolveAgentDir: Mock;
    ensureAuthProfileStoreWithoutExternalProfilesAsync: Mock;
    removeModelAuthCredentials: Mock;
    listProfilesForProvider: Mock;
    buildAuthHealthSummary: Mock;
    refreshActiveProviderAuthRuntimeSnapshot: Mock;
    prepareModelRuntimeSnapshot: Mock;
  };
  readAuthStatus: (params?: Record<string, unknown>) => Promise<ModelAuthStatusResult>;
  useRealHealth: () => Promise<void>;
  setPreparedProfiles: (profiles: AuthProfileStore["profiles"]) => void;
  setPreparedAuthStore: (store: RuntimeAuthProfileStore) => void;
  createLogoutOptions: (params?: Record<string, unknown>) => RespondOptions;
  expectSuccess: (opts: RespondOptions, payload: unknown) => void;
  expectInvalid: (opts: RespondOptions, details: object) => void;
  expectUnknownAgentId: (opts: RespondOptions, agentId: string) => void;
  oauthCredential: (provider: string, overrides?: Partial<OAuthCredential>) => OAuthCredential;
}) {
  const logoutHandler = expectDefined(
    modelsAuthStatusHandlers["models.authLogout"],
    "logout handler",
  );
  const firstRespondCall = (opts: RespondOptions) => opts.respond.mock.calls[0];
  function setLogoutProfiles(profiles: AuthProfileStore["profiles"]) {
    mocks.ensureAuthProfileStoreWithoutExternalProfilesAsync.mockReturnValue(
      createAuthProfileStoreFixture(profiles),
    );
    mocks.listProfilesForProvider.mockReturnValue(Object.keys(profiles));
  }

  function expectLogoutFailurePreservesRun(params: {
    opts: ReturnType<typeof createLogoutOptions>;
    runId: string;
    run: ReturnType<typeof createActiveRun>;
    message: string;
  }): void {
    expect(params.run.input.abortSignal.aborted).toBe(false);
    expect(rpcSourceTesting.has(params.runId)).toBe(true);
    const [ok, payload, error] = firstRespondCall(params.opts) ?? [];
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error?.message).toContain(params.message);
  }

  async function expectLogoutFailureDoesNotAbortRun(params: {
    arrangeFailure: () => void;
    message: string;
  }): Promise<void> {
    params.arrangeFailure();
    const opts = createLogoutOptions({ provider: "openrouter" });
    const activeRun = createActiveRun("run-openrouter", "openrouter");
    rpcSources.registerRpcSource("run-openrouter", activeRun);

    await logoutHandler(opts);

    expectLogoutFailurePreservesRun({
      opts,
      runId: "run-openrouter",
      run: activeRun,
      message: params.message,
    });
  }

  describe("models.authLogout", () => {
    it("rejects an explicit unknown agentId without touching the default auth store", async () => {
      const cfg = { agents: { entries: { main: {}, writer: {} } } };
      mocks.getRuntimeConfig.mockReturnValue(cfg);
      mocks.listAgentIds.mockReturnValue(["main", "writer"]);
      const opts = createLogoutOptions({ provider: "openrouter", agentId: "retired" });

      await logoutHandler(opts);

      expect(mocks.resolveAgentDir).not.toHaveBeenCalled();
      expect(mocks.ensureAuthProfileStoreWithoutExternalProfilesAsync).not.toHaveBeenCalled();
      expect(mocks.removeModelAuthCredentials).not.toHaveBeenCalled();
      expectUnknownAgentId(opts, "retired");
    });

    it("removes provider auth profiles and invalidates the status cache", async () => {
      await useRealHealth();
      setPreparedProfiles({
        "openrouter:default": { type: "api_key", provider: "openrouter", key: "fixture-key" },
      });
      mocks.removeModelAuthCredentials.mockImplementationOnce(async () => {
        setPreparedAuthStore({ version: 1, profiles: {} });
      });
      mocks.listProfilesForProvider.mockReturnValue(["openrouter:default"]);
      expect((await readAuthStatus()).providers[0]?.profiles[0]?.profileId).toBe(
        "openrouter:default",
      );
      expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(1);

      const opts = createLogoutOptions({ provider: "OpenRouter" });
      await logoutHandler(opts);

      expect(mocks.removeModelAuthCredentials).toHaveBeenCalledWith({
        cfg: {},
        provider: "openrouter",
        agentDir: "/tmp/agent",
        profileIds: ["openrouter:default"],
      });
      expect(mocks.refreshActiveProviderAuthRuntimeSnapshot).toHaveBeenCalledTimes(1);
      const [ok, payload] = firstRespondCall(opts) ?? [];
      expect(ok).toBe(true);
      expect((payload as ModelAuthLogoutResult).removedProfiles).toEqual(["openrouter:default"]);

      expect((await readAuthStatus()).providers).toEqual([]);
      expect(mocks.buildAuthHealthSummary).toHaveBeenCalledTimes(2);
    });

    it("removes only requested saved OAuth or token profiles", async () => {
      setLogoutProfiles({
        "openrouter:oauth": oauthCredential("openrouter"),
        "openrouter:token": { type: "token", provider: "openrouter", token: "test-token" },
        "openrouter:api-key": { type: "api_key", provider: "openrouter", key: "key" },
      });
      const opts = createLogoutOptions({
        provider: "openrouter",
        profileIds: [" openrouter:token ", "openrouter:oauth", "openrouter:token"],
      });

      const run = createActiveRun("active", "openrouter");
      rpcSources.registerRpcSource("active", run);
      await logoutHandler(opts);
      expect(run.input.abortSignal.aborted).toBe(false);
      expect(rpcSourceTesting.has("active")).toBe(true);

      expect(mocks.removeModelAuthCredentials).toHaveBeenCalledWith({
        cfg: {},
        profileIds: ["openrouter:token", "openrouter:oauth"],
        agentDir: "/tmp/agent",
      });
      const [ok, payload] = firstRespondCall(opts) ?? [];
      expect(ok).toBe(true);
      expect(payload).toMatchObject({
        removedProfiles: ["openrouter:token", "openrouter:oauth"],
        abortedRunIds: [],
      });
    });

    it("rejects unavailable or external targeted profiles without aborting runs", async () => {
      setLogoutProfiles({ "openrouter:saved": oauthCredential("openrouter") });
      const opts = createLogoutOptions({
        provider: "openrouter",
        profileIds: ["openrouter:external"],
      });
      const activeRun = createActiveRun("run-openrouter", "openrouter");
      rpcSources.registerRpcSource("run-openrouter", activeRun);

      await logoutHandler(opts);

      expect(mocks.removeModelAuthCredentials).not.toHaveBeenCalled();
      expect(activeRun.input.abortSignal.aborted).toBe(false);
      const [ok, , error] = firstRespondCall(opts) ?? [];
      expect(ok).toBe(false);
      expect(error?.message).toContain("unavailable auth profiles");
    });

    it.each([
      { label: "empty", profileIds: [] },
      { label: "non-array", profileIds: "openrouter:oauth" },
      { label: "non-string", profileIds: ["openrouter:oauth", 1] },
      { label: "blank", profileIds: ["openrouter:oauth", " "] },
    ])("rejects $label targeted profile ids", async ({ profileIds }) => {
      const opts = createLogoutOptions({ provider: "openrouter", profileIds });

      await logoutHandler(opts);

      const [ok, , error] = firstRespondCall(opts) ?? [];
      expect(ok).toBe(false);
      expect(error?.message).toContain("non-empty string array");
      expect(mocks.ensureAuthProfileStoreWithoutExternalProfilesAsync).not.toHaveBeenCalled();
      expect(mocks.removeModelAuthCredentials).not.toHaveBeenCalled();
    });

    it.each([
      { credentialType: "token" },
      { credentialType: "api_key", profileIds: ["openrouter:default"] },
    ])("rejects incompatible logout selectors: %j", async (selection) => {
      const opts = createLogoutOptions({ provider: "openrouter", ...selection });
      await logoutHandler(opts);
      expectInvalid(opts, {});
      expect(mocks.ensureAuthProfileStoreWithoutExternalProfilesAsync).not.toHaveBeenCalled();
      expect(mocks.removeModelAuthCredentials).not.toHaveBeenCalled();
    });

    it("removes only inline API keys and preserves active provider runs", async () => {
      setLogoutProfiles({
        "openrouter:key": { type: "api_key", provider: "openrouter", key: "test-key" },
        "openrouter:ref": {
          type: "api_key",
          provider: "openrouter",
          keyRef: { source: "env", provider: "default", id: "OPENROUTER_API_KEY" },
        },
        "openrouter:token": { type: "token", provider: "openrouter", token: "test-token" },
        "openrouter:oauth": oauthCredential("openrouter"),
      });
      const opts = createLogoutOptions({ provider: "openrouter", credentialType: "api_key" });
      const run = createActiveRun("run-openrouter", "openrouter");
      rpcSources.registerRpcSource("run-openrouter", run);

      await logoutHandler(opts);

      expect(mocks.removeModelAuthCredentials).toHaveBeenCalledWith({
        cfg: {},
        agentDir: "/tmp/agent",
        profileIds: ["openrouter:key"],
        apiKeyProvider: "openrouter",
      });
      expect(run.input.abortSignal.aborted).toBe(false);
      expect(rpcSourceTesting.has("run-openrouter")).toBe(true);
      expectSuccess(opts, {
        provider: "openrouter",
        removedProfiles: ["openrouter:key"],
        abortedRunIds: [],
      });
    });

    it("aborts active runs that share a provider auth alias", async () => {
      const opts = createLogoutOptions({ provider: "byteplus" });
      const aliasedRun = createActiveRun("run-byteplus-plan", "byteplus-plan", "byteplus");
      rpcSources.registerRpcSource("run-byteplus-plan", aliasedRun);

      await logoutHandler(opts);

      expect(aliasedRun.input.abortSignal.aborted).toBe(true);
      const [, payload] = firstRespondCall(opts) ?? [];
      expect((payload as ModelAuthLogoutResult).abortedRunIds).toEqual(["run-byteplus-plan"]);
    });

    it("does not abort runs when auth profile removal fails", async () => {
      await expectLogoutFailureDoesNotAbortRun({
        arrangeFailure: () => {
          mocks.removeModelAuthCredentials.mockRejectedValue(new Error("removal failed"));
        },
        message: "removal failed",
      });
    });

    it.each(["secrets", "publication"] as const)(
      "reports committed logout and aborts revoked provider runs before %s refresh fails",
      async (stage) => {
        const cfg = { agents: { entries: { main: {}, writer: {} } } };
        mocks.getRuntimeConfig.mockReturnValue(cfg);
        mocks.listAgentIds.mockReturnValue(["main", "writer"]);
        const refresh =
          stage === "secrets"
            ? mocks.refreshActiveProviderAuthRuntimeSnapshot
            : mocks.prepareModelRuntimeSnapshot;
        const opts = createLogoutOptions({ provider: "byteplus", agentId: "writer" });
        const revokedRun = createActiveRun("revoked", "byteplus", undefined, "writer");
        const aliasedRun = createActiveRun("aliased", "byteplus-plan", "byteplus", "writer");
        const otherAgentRun = createActiveRun("other-agent", "byteplus", undefined, "main");
        const otherProviderRun = createActiveRun("other-provider", "openai", undefined, "writer");
        rpcSources.registerRpcSource("revoked", revokedRun);
        rpcSources.registerRpcSource("aliased", aliasedRun);
        rpcSources.registerRpcSource("other-agent", otherAgentRun);
        rpcSources.registerRpcSource("other-provider", otherProviderRun);
        let revokedAtRefresh = false;
        refresh.mockImplementationOnce(async () => {
          revokedAtRefresh =
            revokedRun.input.abortSignal.aborted && aliasedRun.input.abortSignal.aborted;
          throw new Error("refresh failed");
        });

        await logoutHandler(opts);

        expect(revokedAtRefresh).toBe(true);
        expect(revokedRun.input.abortSignal.aborted).toBe(true);
        expect(aliasedRun.input.abortSignal.aborted).toBe(true);
        expect(otherAgentRun.input.abortSignal.aborted).toBe(false);
        expect(otherProviderRun.input.abortSignal.aborted).toBe(false);
        expect(rpcSourceTesting.has("revoked")).toBe(false);
        expect(opts.context.broadcast).toHaveBeenCalledWith(
          "chat",
          expect.objectContaining({
            runId: "revoked",
            state: "aborted",
            stopReason: "auth-revoked",
          }),
          { sessionKeys: [rpcSources.getRpcSourceIdentity(revokedRun).sessionKey] },
        );
        const [ok, payload, error] = firstRespondCall(opts) ?? [];
        expect(ok).toBe(true);
        expect(payload).toMatchObject({
          abortedRunIds: ["revoked", "aliased"],
          warning: expect.stringContaining("openclaw gateway restart"),
        });
        expect(error).toBeUndefined();
      },
    );

    it("rejects missing provider", async () => {
      const opts = createLogoutOptions();
      await logoutHandler(opts);
      const [ok, , error] = firstRespondCall(opts) ?? [];
      expect(ok).toBe(false);
      expect(error?.message).toBe("provider is required");
    });
  });
}
