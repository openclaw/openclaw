import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveManifestProviderAuthChoice = vi.hoisted(() => vi.fn());
const resolveManifestDeprecatedProviderAuthChoice = vi.hoisted(() => vi.fn());
const resolveManifestProviderAuthChoices = vi.hoisted(() => vi.fn(() => []));
const resolveProviderPluginChoice = vi.hoisted(() => vi.fn());
const resolvePluginProviders = vi.hoisted(() => vi.fn(() => []));

vi.mock("../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoice,
  resolveManifestDeprecatedProviderAuthChoice,
  resolveManifestProviderAuthChoices,
}));

vi.mock("../plugins/provider-wizard.js", () => ({
  resolveProviderPluginChoice,
}));

vi.mock("../plugins/providers.runtime.js", () => ({
  resolvePluginProviders,
}));

import { resolvePreferredProviderForAuthChoice } from "./auth-choice.preferred-provider.js";

describe("resolvePreferredProviderForAuthChoice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveManifestProviderAuthChoice.mockReturnValue(undefined);
    resolveManifestDeprecatedProviderAuthChoice.mockReturnValue(undefined);
    resolveManifestProviderAuthChoices.mockReturnValue([]);
    resolvePluginProviders.mockReturnValue([]);
    resolveProviderPluginChoice.mockReturnValue(null);
  });

  it("prefers manifest metadata when available", async () => {
    resolveManifestProviderAuthChoice.mockReturnValue({
      pluginId: "openai",
      providerId: "openai",
      methodId: "api-key",
      choiceId: "openai-api-key",
      choiceLabel: "OpenAI API key",
    });

    await expect(resolvePreferredProviderForAuthChoice({ choice: "openai-api-key" })).resolves.toBe(
      "openai",
    );
    expect(resolvePluginProviders).not.toHaveBeenCalled();
  });

  it("normalizes legacy auth choices before plugin lookup", async () => {
    resolveManifestDeprecatedProviderAuthChoice.mockReturnValue({
      choiceId: "openai-codex",
      choiceLabel: "OpenAI Codex (ChatGPT OAuth)",
    });
    resolveManifestProviderAuthChoice.mockReturnValue({
      pluginId: "openai",
      providerId: "openai-codex",
      methodId: "oauth",
      choiceId: "openai-codex",
      choiceLabel: "OpenAI Codex (ChatGPT OAuth)",
    });

    await expect(resolvePreferredProviderForAuthChoice({ choice: "codex-cli" })).resolves.toBe(
      "openai-codex",
    );
    expect(resolveProviderPluginChoice).not.toHaveBeenCalled();
    expect(resolvePluginProviders).not.toHaveBeenCalled();
  });

  it("passes explicit env through legacy auth normalization", async () => {
    const env = { OPENCLAW_AUTH_CHOICE_TEST: "1" } as NodeJS.ProcessEnv;
    resolveManifestDeprecatedProviderAuthChoice.mockReturnValue({
      choiceId: "openai-codex",
      choiceLabel: "OpenAI Codex (ChatGPT OAuth)",
    });
    resolveManifestProviderAuthChoice.mockReturnValue({
      pluginId: "openai",
      providerId: "openai-codex",
      methodId: "oauth",
      choiceId: "openai-codex",
      choiceLabel: "OpenAI Codex (ChatGPT OAuth)",
    });

    await expect(resolvePreferredProviderForAuthChoice({ choice: "codex-cli", env })).resolves.toBe(
      "openai-codex",
    );
    expect(resolveManifestDeprecatedProviderAuthChoice).toHaveBeenCalledWith("codex-cli", { env });
  });

  it("uses manifest metadata for plugin-owned choices", async () => {
    resolveManifestProviderAuthChoice.mockReturnValue({
      pluginId: "chutes",
      providerId: "chutes",
      methodId: "oauth",
      choiceId: "chutes",
      choiceLabel: "Chutes OAuth",
    });

    await expect(resolvePreferredProviderForAuthChoice({ choice: "chutes" })).resolves.toBe(
      "chutes",
    );
    expect(resolvePluginProviders).not.toHaveBeenCalled();
  });
});
