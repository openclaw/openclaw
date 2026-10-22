import { expect, it, vi, type Mock } from "vitest";
import type { ConfigWriteOptions } from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { persistProviderAuthProfilesAfterLogin } from "../../plugins/provider-auth-persistence.js";
import type { ProviderAuthResult } from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { runModelsAuthLoginFlowCore } from "./auth.js";

type PersistProviderAuthCall = Parameters<typeof persistProviderAuthProfilesAfterLogin>[0];
type PreparedEffect = Pick<PersistProviderAuthCall, "beforeWrite" | "profiles"> & {
  assertCurrent?: () => void;
};

export function registerModelsAuthAuthorityTests(fixture: {
  mocks: {
    createClackPrompter: Mock;
    persistProviderAuthProfilesAfterLogin: Mock;
    promoteAuthProfileInOrder: Mock;
    updateConfig: Mock;
  };
  createRuntime: () => RuntimeEnv;
  runModelsAuthLoginFlowCore: typeof runModelsAuthLoginFlowCore;
  setProviderAuthResult: (result: ProviderAuthResult) => void;
}) {
  const { mocks, createRuntime, runModelsAuthLoginFlowCore } = fixture;
  function loginAuthority() {
    const authority = new AbortController();
    return {
      revoke: () => authority.abort(new Error("Login authority ended.")),
      reject: (options: Partial<Parameters<typeof runModelsAuthLoginFlowCore>[0]> = {}) =>
        expect(
          runModelsAuthLoginFlowCore({
            provider: "openai",
            credentialOnly: true,
            runtime: createRuntime(),
            prompter: mocks.createClackPrompter(),
            assertCurrent: () => authority.signal.throwIfAborted(),
            ...options,
          }),
        ).rejects.toThrow("Login authority ended."),
    };
  }
  it.each(["cancelled", "revoked"] as const)(
    "does not complete a saved login when authority is %s during a rejected refresh",
    async (reason) => {
      const controller = new AbortController();
      const authority = loginAuthority();
      const onModelAccessRequested = vi.fn();
      await authority.reject({
        credentialOnly: false,
        signal: controller.signal,
        refreshAfterLogin: async () => {
          if (reason === "cancelled") {
            controller.abort(new Error("Login authority ended."));
          } else {
            authority.revoke();
          }
          throw new Error("Auth publication failed.");
        },
        onModelAccessRequested,
      });
      expect(onModelAccessRequested).not.toHaveBeenCalled();
    },
  );

  it.each(["beforeWrite", "assertCurrent", "beforeCommit", "writeAuthority"] as const)(
    "does not publish after authority ends at %s",
    async (gate) => {
      const authority = loginAuthority();
      let published = false;
      const credentialGate = gate === "beforeWrite" || gate === "assertCurrent";
      if (credentialGate) {
        const effect =
          gate === "beforeWrite"
            ? mocks.persistProviderAuthProfilesAfterLogin
            : mocks.promoteAuthProfileInOrder;
        effect.mockImplementationOnce(async (params: PreparedEffect) => {
          authority.revoke();
          params[gate]?.();
          published = true;
          return gate === "beforeWrite"
            ? (params.profiles ?? [])
            : { ok: true, value: { version: 1, profiles: {} } };
        });
      } else {
        const credential = { type: "api_key" as const, provider: "openai", key: "fixture-key" };
        fixture.setProviderAuthResult({
          profiles: [{ profileId: "openai:saved", credential }],
          configPatch: {
            models: { providers: { openai: { baseUrl: "https://api.openai.com/v1", models: [] } } },
          },
        });
        mocks.updateConfig.mockImplementationOnce(
          async (
            mutator: (cfg: OpenClawConfig) => OpenClawConfig,
            _refs: unknown,
            beforeCommit?: ConfigWriteOptions["beforeCommit"],
            writeOptions?: ConfigWriteOptions,
          ) => {
            const prepared = mutator({});
            authority.revoke();
            if (gate === "beforeCommit") {
              await beforeCommit?.();
            } else {
              writeOptions?.assertCurrent?.();
            }
            published = true;
            return prepared;
          },
        );
      }
      await authority.reject();
      expect(published).toBe(false);
      if (gate !== "beforeWrite") {
        expect(mocks.persistProviderAuthProfilesAfterLogin).toHaveBeenCalledOnce();
      }
      if (credentialGate) {
        expect(mocks.updateConfig).not.toHaveBeenCalled();
      }
    },
  );
}
