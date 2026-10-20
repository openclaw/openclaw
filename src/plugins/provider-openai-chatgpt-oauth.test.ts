import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { RuntimeEnv } from "../runtime.js";

const providerRuntimeMocks = vi.hoisted(() => ({
  loadFacade: vi.fn(),
  resolveProviderRuntimePlugin: vi.fn(),
  runOAuth: vi.fn(),
  runFacadeOAuth: vi.fn(),
}));

vi.mock("./provider-hook-runtime.js", () => ({
  resolveProviderRuntimePlugin: providerRuntimeMocks.resolveProviderRuntimePlugin,
}));

vi.mock("../plugin-sdk/facade-runtime.js", () => ({
  loadActivatedBundledPluginPublicSurfaceModuleSync: providerRuntimeMocks.loadFacade,
}));

import { loginOpenAICodexOAuth } from "./provider-openai-chatgpt-oauth.js";

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }),
  };
}

function createLoginParams(isRemote = false) {
  return {
    prompter: createWizardPrompter({
      text: vi.fn(async () => "http://localhost:1455/auth/callback?code=test"),
    }),
    runtime: createRuntime(),
    isRemote,
    openUrl: vi.fn(async () => {}),
    signal: new AbortController().signal,
    onManualCodeInput: vi.fn(async () => "manual-code"),
  };
}

describe("loginOpenAICodexOAuth", () => {
  beforeEach(() => {
    for (const mock of Object.values(providerRuntimeMocks)) {
      mock.mockReset();
    }
    providerRuntimeMocks.resolveProviderRuntimePlugin.mockReturnValue({
      auth: [{ id: "oauth", run: providerRuntimeMocks.runOAuth }],
    });
    providerRuntimeMocks.loadFacade.mockReturnValue({
      loginOpenAICodexOAuth: providerRuntimeMocks.runFacadeOAuth,
    });
  });

  it.each(["hook", "facade"] as const)("delegates OAuth login to the %s", async (source) => {
    const facade = source === "facade";
    const credential = {
      access: `${source}-access-token`,
      refresh: `${source}-refresh-token`,
      expires: Date.now() + 60_000,
      ...(facade
        ? { accountId: "acct_facade" }
        : {
            type: "oauth",
            provider: "openai",
            email: "user@example.com",
          }),
    };
    const params = createLoginParams(!facade);
    const localBrowserMessage = "Complete sign-in in browser...";
    const login = facade ? providerRuntimeMocks.runFacadeOAuth : providerRuntimeMocks.runOAuth;
    if (facade) {
      providerRuntimeMocks.resolveProviderRuntimePlugin.mockReturnValueOnce(undefined);
      login.mockResolvedValueOnce(credential);
    } else {
      login.mockResolvedValueOnce({
        profiles: [{ profileId: "openai:user@example.com", credential }],
      });
    }
    await expect(loginOpenAICodexOAuth({ ...params, localBrowserMessage })).resolves.toEqual(
      credential,
    );
    expect(login).toHaveBeenCalledOnce();
    expect(
      facade ? providerRuntimeMocks.runOAuth : providerRuntimeMocks.loadFacade,
    ).not.toHaveBeenCalled();
    if (facade) {
      expect(providerRuntimeMocks.loadFacade).toHaveBeenCalledWith({
        dirName: "openai",
        artifactBasename: "api.js",
      });
    }
    expect(login).toHaveBeenCalledWith({
      ...params,
      ...(facade ? { localBrowserMessage } : { config: {} }),
      oauth: { createVpsAwareHandlers: expect.any(Function) },
    });
  });

  it("returns null when the provider hook does not create an OAuth credential", async () => {
    providerRuntimeMocks.runOAuth.mockResolvedValueOnce({ profiles: [] });
    await expect(loginOpenAICodexOAuth(createLoginParams())).resolves.toBeNull();
  });

  it("preserves activated-facade failures when the OpenAI plugin is disabled", async () => {
    providerRuntimeMocks.resolveProviderRuntimePlugin.mockReturnValueOnce(undefined);
    providerRuntimeMocks.loadFacade.mockImplementationOnce(() => {
      throw new Error("plugin runtime is not activated");
    });

    await expect(loginOpenAICodexOAuth(createLoginParams())).rejects.toThrow(
      "plugin runtime is not activated",
    );
    expect(providerRuntimeMocks.runFacadeOAuth).not.toHaveBeenCalled();
  });
});
