import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../../agents/auth-profiles/store.js";
import { createNonExitingRuntime } from "../../runtime.js";
import type {
  WizardMultiSelectParams,
  WizardPrompter,
  WizardProgress,
  WizardSelectParams,
} from "../../wizard/prompts.js";
import { registerProviders, requireProvider } from "./testkit.js";

type LoginOpenAICodexOAuth =
  (typeof import("../../plugins/provider-openai-codex-oauth.js"))["loginOpenAICodexOAuth"];
type LoginQwenPortalOAuth =
  (typeof import("../../../extensions/qwen-portal-auth/oauth.js"))["loginQwenPortalOAuth"];
type GithubCopilotLoginCommand =
  (typeof import("../../providers/github-copilot-auth.js"))["githubCopilotLoginCommand"];
type CreateVpsAwareHandlers =
  (typeof import("../../plugins/provider-oauth-flow.js"))["createVpsAwareOAuthHandlers"];

const loginOpenAICodexOAuthMock = vi.hoisted(() => vi.fn<LoginOpenAICodexOAuth>());
const loginQwenPortalOAuthMock = vi.hoisted(() => vi.fn<LoginQwenPortalOAuth>());
const githubCopilotLoginCommandMock = vi.hoisted(() => vi.fn<GithubCopilotLoginCommand>());

vi.mock("../../plugins/provider-openai-codex-oauth.js", () => ({
  loginOpenAICodexOAuth: loginOpenAICodexOAuthMock,
}));

vi.mock("../../../extensions/qwen-portal-auth/oauth.js", () => ({
  loginQwenPortalOAuth: loginQwenPortalOAuthMock,
}));

vi.mock("../../providers/github-copilot-auth.js", () => ({
  githubCopilotLoginCommand: githubCopilotLoginCommandMock,
}));

const openAIPlugin = (await import("../../../extensions/openai/index.js")).default;
const qwenPortalPlugin = (await import("../../../extensions/qwen-portal-auth/index.js")).default;
const githubCopilotPlugin = (await import("../../../extensions/github-copilot/index.js")).default;

function buildPrompter(): WizardPrompter {
  const progress: WizardProgress = {
    update() {},
    stop() {},
  };
  return {
    intro: async () => {},
    outro: async () => {},
    note: async () => {},
    select: async <T>(params: WizardSelectParams<T>) => {
      const option = params.options[0];
      if (!option) {
        throw new Error("missing select option");
      }
      return option.value;
    },
    multiselect: async <T>(params: WizardMultiSelectParams<T>) => params.initialValues ?? [],
    text: async () => "",
    confirm: async () => false,
    progress: () => progress,
  };
}

function buildAuthContext() {
  return {
    config: {},
    prompter: buildPrompter(),
    runtime: createNonExitingRuntime(),
    isRemote: false,
    openUrl: async () => {},
    oauth: {
      createVpsAwareHandlers: vi.fn<CreateVpsAwareHandlers>(),
    },
  };
}

describe("provider auth contract", () => {
  afterEach(() => {
    loginOpenAICodexOAuthMock.mockReset();
    loginQwenPortalOAuthMock.mockReset();
    githubCopilotLoginCommandMock.mockReset();
    clearRuntimeAuthProfileStoreSnapshots();
  });

  it("keeps OpenAI Codex OAuth auth results provider-owned", async () => {
    const provider = requireProvider(registerProviders(openAIPlugin), "openai-codex");
    loginOpenAICodexOAuthMock.mockResolvedValueOnce({
      email: "user@example.com",
      refresh: "refresh-token",
      access: "access-token",
      expires: 1_700_000_000_000,
    });

    const result = await provider.auth[0]?.run(buildAuthContext() as never);

    expect(result).toEqual({
      profiles: [
        {
          profileId: "openai-codex:user@example.com",
          credential: {
            type: "oauth",
            provider: "openai-codex",
            access: "access-token",
            refresh: "refresh-token",
            expires: 1_700_000_000_000,
            email: "user@example.com",
          },
        },
      ],
      configPatch: {
        agents: {
          defaults: {
            models: {
              "openai-codex/gpt-5.4": {},
            },
          },
        },
      },
      defaultModel: "openai-codex/gpt-5.4",
      notes: undefined,
    });
  });

  it("keeps OpenAI Codex OAuth failures non-fatal at the provider layer", async () => {
    const provider = requireProvider(registerProviders(openAIPlugin), "openai-codex");
    loginOpenAICodexOAuthMock.mockRejectedValueOnce(new Error("oauth failed"));

    await expect(provider.auth[0]?.run(buildAuthContext() as never)).resolves.toEqual({
      profiles: [],
    });
  });

  it("keeps Qwen portal OAuth auth results provider-owned", async () => {
    const provider = requireProvider(registerProviders(qwenPortalPlugin), "qwen-portal");
    loginQwenPortalOAuthMock.mockResolvedValueOnce({
      access: "access-token",
      refresh: "refresh-token",
      expires: 1_700_000_000_000,
      resourceUrl: "portal.qwen.ai",
    });

    const result = await provider.auth[0]?.run(buildAuthContext() as never);

    expect(result).toMatchObject({
      profiles: [
        {
          profileId: "qwen-portal:default",
          credential: {
            type: "oauth",
            provider: "qwen-portal",
            access: "access-token",
            refresh: "refresh-token",
            expires: 1_700_000_000_000,
          },
        },
      ],
      defaultModel: "qwen-portal/coder-model",
      configPatch: {
        models: {
          providers: {
            "qwen-portal": {
              baseUrl: "https://portal.qwen.ai/v1",
              models: [],
            },
          },
        },
      },
    });
    expect(result?.notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("auto-refresh"),
        expect.stringContaining("Base URL defaults"),
      ]),
    );
  });

  it("keeps GitHub Copilot device auth results provider-owned", async () => {
    const provider = requireProvider(registerProviders(githubCopilotPlugin), "github-copilot");
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        store: {
          version: 1,
          profiles: {
            "github-copilot:github": {
              type: "token",
              provider: "github-copilot",
              token: "github-device-token",
            },
          },
        },
      },
    ]);

    const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
    const hadOwnIsTTY = Object.prototype.hasOwnProperty.call(stdin, "isTTY");
    const previousIsTTYDescriptor = Object.getOwnPropertyDescriptor(stdin, "isTTY");
    Object.defineProperty(stdin, "isTTY", {
      configurable: true,
      enumerable: true,
      get: () => true,
    });

    try {
      const result = await provider.auth[0]?.run(buildAuthContext() as never);
      expect(githubCopilotLoginCommandMock).toHaveBeenCalledWith(
        { yes: true, profileId: "github-copilot:github" },
        expect.any(Object),
      );
      expect(result).toEqual({
        profiles: [
          {
            profileId: "github-copilot:github",
            credential: {
              type: "token",
              provider: "github-copilot",
              token: "github-device-token",
            },
          },
        ],
        defaultModel: "github-copilot/gpt-4o",
      });
    } finally {
      if (previousIsTTYDescriptor) {
        Object.defineProperty(stdin, "isTTY", previousIsTTYDescriptor);
      } else if (!hadOwnIsTTY) {
        delete (stdin as { isTTY?: boolean }).isTTY;
      }
    }
  });

  it("keeps GitHub Copilot auth gated on interactive TTYs", async () => {
    const provider = requireProvider(registerProviders(githubCopilotPlugin), "github-copilot");
    const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
    const hadOwnIsTTY = Object.prototype.hasOwnProperty.call(stdin, "isTTY");
    const previousIsTTYDescriptor = Object.getOwnPropertyDescriptor(stdin, "isTTY");
    Object.defineProperty(stdin, "isTTY", {
      configurable: true,
      enumerable: true,
      get: () => false,
    });

    try {
      await expect(provider.auth[0]?.run(buildAuthContext() as never)).resolves.toEqual({
        profiles: [],
      });
      expect(githubCopilotLoginCommandMock).not.toHaveBeenCalled();
    } finally {
      if (previousIsTTYDescriptor) {
        Object.defineProperty(stdin, "isTTY", previousIsTTYDescriptor);
      } else if (!hadOwnIsTTY) {
        delete (stdin as { isTTY?: boolean }).isTTY;
      }
    }
  });
});
