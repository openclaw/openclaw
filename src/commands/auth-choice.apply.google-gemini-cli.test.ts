import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyAuthChoiceGoogleGeminiCli } from "./auth-choice.apply.google-gemini-cli.js";
import type { ApplyAuthChoiceParams } from "./auth-choice.apply.js";
import { applyAuthChoicePluginProvider } from "./auth-choice.apply.plugin-provider.js";
import { createExitThrowingRuntime, createWizardPrompter } from "./test-wizard-helpers.js";

vi.mock("./auth-choice.apply.plugin-provider.js", () => ({
  applyAuthChoicePluginProvider: vi.fn(),
}));

function createParams(
  authChoice: ApplyAuthChoiceParams["authChoice"],
  overrides: Partial<ApplyAuthChoiceParams> = {},
): ApplyAuthChoiceParams {
  return {
    authChoice,
    config: {},
    prompter: createWizardPrompter({}, { defaultSelect: "" }),
    runtime: createExitThrowingRuntime(),
    setDefaultModel: true,
    ...overrides,
  };
}

describe("applyAuthChoiceGoogleGeminiCli", () => {
  const mockedApplyAuthChoicePluginProvider = vi.mocked(applyAuthChoicePluginProvider);

  beforeEach(() => {
    mockedApplyAuthChoicePluginProvider.mockReset();
  });

  it("returns null for unrelated authChoice", async () => {
    const result = await applyAuthChoiceGoogleGeminiCli(createParams("openrouter-api-key"));

    expect(result).toBeNull();
    expect(mockedApplyAuthChoicePluginProvider).not.toHaveBeenCalled();
  });

  it("shows caution and skips setup when user declines", async () => {
    const confirm = vi.fn(async () => false);
    const note = vi.fn(async () => {});
    const params = createParams("google-gemini-cli", {
      prompter: createWizardPrompter({ confirm, note }, { defaultSelect: "" }),
    });

    const result = await applyAuthChoiceGoogleGeminiCli(params);

    expect(result).toEqual({ config: params.config });
    expect(note).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("This is an unofficial integration and is not endorsed by Google."),
      "Google Gemini CLI caution",
    );
    expect(confirm).toHaveBeenCalledWith({
      message: "Continue with Google Gemini CLI OAuth?",
      initialValue: false,
    });
    expect(note).toHaveBeenNthCalledWith(
      2,
      "Skipped Google Gemini CLI OAuth setup.",
      "Setup skipped",
    );
    expect(mockedApplyAuthChoicePluginProvider).not.toHaveBeenCalled();
  });

  it("continues to plugin provider flow when user confirms", async () => {
    const confirm = vi.fn(async () => true);
    const note = vi.fn(async () => {});
    const params = createParams("google-gemini-cli", {
      prompter: createWizardPrompter({ confirm, note }, { defaultSelect: "" }),
    });
    const expected = { config: {} };
    mockedApplyAuthChoicePluginProvider.mockResolvedValue(expected);

    const result = await applyAuthChoiceGoogleGeminiCli(params);

    expect(result).toBe(expected);
    expect(mockedApplyAuthChoicePluginProvider).toHaveBeenCalledWith(params, {
      authChoice: "google-gemini-cli",
      pluginId: "google-gemini-cli-auth",
      providerId: "google-gemini-cli",
      methodId: "oauth",
      label: "Google Gemini CLI",
    });
  });
});
