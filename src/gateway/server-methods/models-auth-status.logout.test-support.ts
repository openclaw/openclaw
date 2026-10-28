import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { AuthProfileStore, RuntimeAuthProfileStore } from "../../agents/auth-profiles.js";
import * as rpcSources from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { createRpcSourceForTest } from "../test-helpers.rpc-source.js";
import { modelsAuthStatusHandlers } from "./models-auth-status.js";
import type { ModelAuthStatusResult } from "./models-auth-status.types.js";
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
  const run = createRpcSourceForTest({ providerId, authProviderId }, { ...identity, runId });
  rpcSources.registerRpcSource(runId, run);
  return run;
}

export function registerModelAuthLogoutTests({
  mocks,
  createLogoutOptions,
  expectInvalid,
  expectUnknownAgentId,
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
  async function logout(params?: Record<string, unknown>) {
    const opts = createLogoutOptions(params);
    await logoutHandler(opts);
    return opts;
  }
  function expectUntouched() {
    expect(mocks.ensureAuthProfileStoreWithoutExternalProfilesAsync).not.toHaveBeenCalled();
    expect(mocks.removeModelAuthCredentials).not.toHaveBeenCalled();
  }

  describe("models.authLogout", () => {
    it("rejects an explicit unknown agentId without touching the default auth store", async () => {
      const cfg = { agents: { entries: { main: {}, writer: {} } } };
      mocks.getRuntimeConfig.mockReturnValue(cfg);
      mocks.listAgentIds.mockReturnValue(["main", "writer"]);
      const opts = await logout({ provider: "openrouter", agentId: "retired" });

      expect(mocks.resolveAgentDir).not.toHaveBeenCalled();
      expectUntouched();
      expectUnknownAgentId(opts, "retired");
    });

    it.each([
      { label: "empty", profileIds: [] },
      { label: "non-array", profileIds: "openrouter:oauth" },
      { label: "non-string", profileIds: ["openrouter:oauth", 1] },
      { label: "blank", profileIds: ["openrouter:oauth", " "] },
    ])("rejects $label targeted profile ids", async ({ profileIds }) => {
      const opts = await logout({ provider: "openrouter", profileIds });

      const [ok, , error] = firstRespondCall(opts) ?? [];
      expect(ok).toBe(false);
      expect(error?.message).toContain("non-empty string array");
      expectUntouched();
    });

    it.each([
      { credentialType: "token" },
      { credentialType: "api_key", profileIds: ["openrouter:default"] },
    ])("rejects incompatible logout selectors: %j", async (selection) => {
      const opts = await logout({ provider: "openrouter", ...selection });
      expectInvalid(opts, {});
      expectUntouched();
    });

    it("does not abort runs when auth profile removal fails", async () => {
      mocks.removeModelAuthCredentials.mockRejectedValue(new Error("removal failed"));
      const run = createActiveRun("run-openrouter", "openrouter");
      const opts = await logout({ provider: "openrouter" });
      expect(run.input.abortSignal.aborted).toBe(false);
      expect(rpcSourceTesting.has("run-openrouter")).toBe(true);
      expect(firstRespondCall(opts)).toEqual([
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("removal failed") }),
      ]);
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
      const opts = await logout();
      const [ok, , error] = firstRespondCall(opts) ?? [];
      expect(ok).toBe(false);
      expect(error?.message).toBe("provider is required");
    });
  });
}
