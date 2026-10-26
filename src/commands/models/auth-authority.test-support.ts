import { expect, it, vi, type Mock } from "vitest";
import type { ConfigWriteOptions } from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { persistProviderAuthProfilesAfterLogin } from "../../plugins/provider-auth-persistence.js";
import type { ProviderAuthResult } from "../../plugins/types.js";
import type { runModelsAuthLoginFlowCore } from "./auth.js";

type PersistProviderAuthCall = Parameters<typeof persistProviderAuthProfilesAfterLogin>[0];
type PreparedEffect = Pick<PersistProviderAuthCall, "beforeWrite"> & {
  assertCurrent?: () => void;
};
type LoginOptions = Partial<Parameters<typeof runModelsAuthLoginFlowCore>[0]>;

export function registerModelsAuthAuthorityTests(fixture: {
  mocks: {
    persistProviderAuthProfilesAfterLogin: Mock;
    promoteAuthProfileInOrder: Mock;
    updateConfig: Mock;
  };
  loginFlow: (options: LoginOptions) => ReturnType<typeof runModelsAuthLoginFlowCore>;
  setProviderAuthResult: (result: ProviderAuthResult) => void;
}) {
  const { mocks, loginFlow } = fixture;
  const ended = () => new Error("Login authority ended.");
  const reject = (authority: AbortController, options: LoginOptions = {}) =>
    expect(
      loginFlow({
        credentialOnly: true,
        assertCurrent: () => authority.signal.throwIfAborted(),
        ...options,
      }),
    ).rejects.toThrow("Login authority ended.");
  it.each(["cancelled", "revoked"] as const)(
    "does not complete a saved login when authority is %s during a rejected refresh",
    async (reason) => {
      const controller = new AbortController();
      const authority = new AbortController();
      const onModelAccessRequested = vi.fn();
      await reject(authority, {
        credentialOnly: false,
        signal: controller.signal,
        refreshAfterLogin: async () => {
          if (reason === "cancelled") {
            controller.abort(ended());
          } else {
            authority.abort(ended());
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
      const authority = new AbortController();
      let published = false;
      const credentialGate = gate === "beforeWrite" || gate === "assertCurrent";
      if (credentialGate) {
        const effect =
          gate === "beforeWrite"
            ? mocks.persistProviderAuthProfilesAfterLogin
            : mocks.promoteAuthProfileInOrder;
        effect.mockImplementationOnce(async (params: PreparedEffect) => {
          authority.abort(ended());
          params[gate]?.();
          published = true;
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
            mutator({});
            authority.abort(ended());
            if (gate === "beforeCommit") {
              await beforeCommit?.();
            } else {
              writeOptions?.assertCurrent?.();
            }
            published = true;
          },
        );
      }
      await reject(authority);
      expect(published).toBe(false);
      if (credentialGate) {
        expect(mocks.updateConfig).not.toHaveBeenCalled();
      }
    },
  );
}
