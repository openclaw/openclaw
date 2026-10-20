import "../test-utils/prepare-compiled-subprocesses.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveManifestProviderAuthChoice = vi.hoisted(() => vi.fn());
const resolveManifestDeprecatedProviderAuthChoice = vi.hoisted(() => vi.fn());
const resolveManifestProviderAuthChoices = vi.hoisted(() => vi.fn(() => []));
const resolveProviderPluginChoiceCore = vi.hoisted(() => vi.fn());
const resolvePluginProvidersCore = vi.hoisted(() => vi.fn(() => []));

vi.mock("../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoice,
  resolveManifestDeprecatedProviderAuthChoice,
  resolveManifestProviderAuthChoices,
}));

vi.mock("../plugins/provider-wizard.js", () => ({
  resolveProviderPluginChoiceCore,
}));

vi.mock("../plugins/providers.runtime.js", () => ({
  resolvePluginProvidersCore,
}));

import { resolvePreferredProviderForAuthChoice } from "../plugins/provider-auth-choice-preference.js";

function manifestChoice(
  providerId: string,
  methodId: string,
  choiceId: string,
  choiceLabel: string,
) {
  return { pluginId: providerId, providerId, methodId, choiceId, choiceLabel };
}

describe("resolvePreferredProviderForAuthChoice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveManifestProviderAuthChoice.mockReturnValue(undefined);
    resolveManifestDeprecatedProviderAuthChoice.mockReturnValue(undefined);
    resolveManifestProviderAuthChoices.mockReturnValue([]);
    resolvePluginProvidersCore.mockReturnValue([]);
    resolveProviderPluginChoiceCore.mockReturnValue(null);
  });

  it("prefers manifest metadata when available", async () => {
    resolveManifestProviderAuthChoice.mockReturnValue(
      manifestChoice("openai", "api-key", "openai-api-key", "OpenAI API key"),
    );

    await expect(resolvePreferredProviderForAuthChoice({ choice: "openai-api-key" })).resolves.toBe(
      "openai",
    );
    expect(resolvePluginProvidersCore).not.toHaveBeenCalled();
  });

  it("passes explicit env through legacy auth normalization", async () => {
    const env = { OPENCLAW_AUTH_CHOICE_TEST: "1" };
    resolveManifestDeprecatedProviderAuthChoice.mockReturnValue({
      choiceId: "anthropic-cli",
      choiceLabel: "Anthropic Claude CLI",
    });
    resolveManifestProviderAuthChoice.mockReturnValue(
      manifestChoice("anthropic", "cli", "anthropic-cli", "Anthropic Claude CLI"),
    );

    await expect(
      resolvePreferredProviderForAuthChoice({ choice: "claude-cli", env }),
    ).resolves.toBe("anthropic");
    expect(resolveManifestDeprecatedProviderAuthChoice).toHaveBeenCalledWith("claude-cli", { env });
    expect(resolveProviderPluginChoiceCore).not.toHaveBeenCalled();
    expect(resolvePluginProvidersCore).not.toHaveBeenCalled();
  });

  it("passes untrusted-workspace filtering through setup-provider fallback lookup", async () => {
    resolvePluginProvidersCore.mockReturnValue([
      {
        id: "demo-provider",
        label: "Demo Provider",
        auth: [{ id: "api-key", label: "API key", kind: "api_key" }],
      },
    ] as never);
    resolveProviderPluginChoiceCore.mockReturnValue({
      provider: { id: "demo-provider" },
      method: { id: "api-key" },
    });

    await expect(
      resolvePreferredProviderForAuthChoice({
        choice: "demo-provider",
        includeUntrustedWorkspacePlugins: false,
      }),
    ).resolves.toBe("demo-provider");
    expect(resolvePluginProvidersCore).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ mode: "setup", includeUntrustedWorkspacePlugins: false }),
    );
  });
});
