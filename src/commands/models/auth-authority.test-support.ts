import { expect, it, vi, type Mock } from "vitest";
import type { ConfigWriteOptions } from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { persistProviderAuthProfilesAfterLogin } from "../../plugins/provider-auth-persistence.js";
import type { ProviderAuthResult } from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { runModelsAuthLoginFlowCore } from "./auth.js";

type PersistProviderAuthCall = Parameters<typeof persistProviderAuthProfilesAfterLogin>[0];

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
    let current = true;
    return {
      revoke: () => {
        current = false;
      },
      run: (options: Partial<Parameters<typeof runModelsAuthLoginFlowCore>[0]> = {}) =>
        runModelsAuthLoginFlowCore({
          provider: "openai",
          credentialOnly: true,
          runtime: createRuntime(),
          prompter: mocks.createClackPrompter(),
          assertCurrent: () => {
            if (!current) {
              throw new Error("Login authority ended.");
            }
          },
          ...options,
        }),
    };
  }
  it.each(["cancelled", "revoked"] as const)(
    "does not complete a saved login when authority is %s during a rejected refresh",
    async (reason) => {
      const controller = new AbortController();
      const authority = loginAuthority();
      const onModelAccessRequested = vi.fn();
      await expect(
        authority.run({
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
        }),
      ).rejects.toThrow("Login authority ended.");
      expect(onModelAccessRequested).not.toHaveBeenCalled();
    },
  );

  it("does not publish credentials when authority ends after persistence preparation", async () => {
    const authority = loginAuthority();
    let saved = false;
    mocks.persistProviderAuthProfilesAfterLogin.mockImplementationOnce(
      async (params: PersistProviderAuthCall) => {
        authority.revoke();
        params.beforeWrite?.();
        saved = true;
        return params.profiles ?? [];
      },
    );
    await expect(authority.run()).rejects.toThrow("Login authority ended.");
    expect(saved).toBe(false);
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it("does not promote a saved login after requester authority ends during order preparation", async () => {
    const authority = loginAuthority();
    let promoted = false;
    mocks.promoteAuthProfileInOrder.mockImplementationOnce(
      async (params: { assertCurrent?: () => void }) => {
        authority.revoke();
        params.assertCurrent?.();
        promoted = true;
        return { ok: true, value: { version: 1, profiles: {} } };
      },
    );
    await expect(authority.run()).rejects.toThrow("Login authority ended.");
    expect(promoted).toBe(false);
    expect(mocks.persistProviderAuthProfilesAfterLogin).toHaveBeenCalledOnce();
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it.each(["beforeCommit", "writeAuthority"] as const)(
    "does not publish provider config when authority ends after preparation at %s",
    async (boundary) => {
      const authority = loginAuthority();
      let published = false;
      fixture.setProviderAuthResult({
        profiles: [
          {
            profileId: "openai:saved",
            credential: { type: "api_key", provider: "openai", key: "fixture-key" },
          },
        ],
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
          if (boundary === "beforeCommit") {
            await beforeCommit?.();
          } else {
            writeOptions?.assertCurrent?.();
          }
          published = true;
          return prepared;
        },
      );
      await expect(authority.run()).rejects.toThrow("Login authority ended.");
      expect(published).toBe(false);
      expect(mocks.persistProviderAuthProfilesAfterLogin).toHaveBeenCalledOnce();
    },
  );
}
