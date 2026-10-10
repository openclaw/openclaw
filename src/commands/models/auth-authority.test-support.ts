import { expect, it, vi, type Mock } from "vitest";
import type { ConfigWriteOptions } from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { persistProviderAuthProfilesAfterLogin } from "../../plugins/provider-auth-persistence.js";
import type { ProviderAuthResult } from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { runModelsAuthLoginFlowCore } from "./auth.js";

type PersistProviderAuthCall = Parameters<typeof persistProviderAuthProfilesAfterLogin>[0];

export function registerModelsAuthAuthorityTests(params: {
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
  const { mocks, createRuntime, runModelsAuthLoginFlowCore } = params;
  it.each(["cancelled", "revoked"] as const)(
    "does not complete a saved login when authority is %s during a rejected refresh",
    async (reason) => {
      const controller = new AbortController();
      let current = true;
      const onModelAccessRequested = vi.fn();
      await expect(
        runModelsAuthLoginFlowCore({
          provider: "openai",
          runtime: createRuntime(),
          prompter: mocks.createClackPrompter(),
          signal: controller.signal,
          assertCurrent: () => {
            if (!current) {
              throw new Error("Login authority ended.");
            }
          },
          refreshAfterLogin: async () => {
            if (reason === "cancelled") {
              controller.abort(new Error("Login authority ended."));
            } else {
              current = false;
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
    let current = true;
    let saved = false;
    mocks.persistProviderAuthProfilesAfterLogin.mockImplementationOnce(
      async (params: PersistProviderAuthCall) => {
        current = false;
        params.beforeWrite?.();
        saved = true;
        return params.profiles ?? [];
      },
    );
    await expect(
      runModelsAuthLoginFlowCore({
        provider: "openai",
        credentialOnly: true,
        runtime: createRuntime(),
        prompter: mocks.createClackPrompter(),
        assertCurrent: () => {
          if (!current) throw new Error("Login authority ended.");
        },
      }),
    ).rejects.toThrow("Login authority ended.");
    expect(saved).toBe(false);
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it("does not promote a saved login after requester authority ends during order preparation", async () => {
    let current = true;
    let promoted = false;
    mocks.promoteAuthProfileInOrder.mockImplementationOnce(
      async (params: { assertCurrent?: () => void }) => {
        current = false;
        params.assertCurrent?.();
        promoted = true;
        return { ok: true, value: { version: 1, profiles: {} } };
      },
    );
    await expect(
      runModelsAuthLoginFlowCore({
        provider: "openai",
        credentialOnly: true,
        runtime: createRuntime(),
        prompter: mocks.createClackPrompter(),
        assertCurrent: () => {
          if (!current) throw new Error("Login authority ended.");
        },
      }),
    ).rejects.toThrow("Login authority ended.");
    expect(promoted).toBe(false);
    expect(mocks.persistProviderAuthProfilesAfterLogin).toHaveBeenCalledOnce();
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it.each(["beforeCommit", "writeAuthority"] as const)(
    "does not publish provider config when authority ends after preparation at %s",
    async (boundary) => {
      let current = true;
      let published = false;
      params.setProviderAuthResult({
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
          current = false;
          if (boundary === "beforeCommit") await beforeCommit?.();
          else writeOptions?.assertCurrent?.();
          published = true;
          return prepared;
        },
      );
      await expect(
        runModelsAuthLoginFlowCore({
          provider: "openai",
          credentialOnly: true,
          runtime: createRuntime(),
          prompter: mocks.createClackPrompter(),
          assertCurrent: () => {
            if (!current) throw new Error("Login authority ended.");
          },
        }),
      ).rejects.toThrow("Login authority ended.");
      expect(published).toBe(false);
      expect(mocks.persistProviderAuthProfilesAfterLogin).toHaveBeenCalledOnce();
    },
  );
}
