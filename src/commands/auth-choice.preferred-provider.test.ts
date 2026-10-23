import "../test-utils/prepare-compiled-subprocesses.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveManifestProviderAuthChoice = vi.hoisted(() => vi.fn());
const resolveManifestDeprecatedProviderAuthChoice = vi.hoisted(() => vi.fn());
const resolveProviderPluginChoiceCore = vi.hoisted(() => vi.fn());
const resolvePluginProvidersCore = vi.hoisted(() => vi.fn(() => []));

// mock-isolation: Each case controls manifest choices independently of installed providers.
vi.mock("../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoice,
  resolveManifestDeprecatedProviderAuthChoice,
}));

vi.mock("../plugins/provider-wizard.js", () => ({
  resolveProviderPluginChoiceCore,
}));

vi.mock("../plugins/providers.runtime.js", () => ({
  resolvePluginProvidersCore,
}));

import { resolvePreferredProviderForAuthChoice } from "../plugins/provider-auth-choice-preference.js";

describe("resolvePreferredProviderForAuthChoice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveManifestProviderAuthChoice.mockReturnValue(undefined);
    resolveManifestDeprecatedProviderAuthChoice.mockReturnValue(undefined);
    resolvePluginProvidersCore.mockReturnValue([]);
    resolveProviderPluginChoiceCore.mockReturnValue(null);
  });

  it("prefers manifest metadata when available", async () => {
    resolveManifestProviderAuthChoice.mockReturnValue({ providerId: "openai" });

    await expect(resolvePreferredProviderForAuthChoice({ choice: "openai-api-key" })).resolves.toBe(
      "openai",
    );
    expect(resolvePluginProvidersCore).not.toHaveBeenCalled();
  });

  it("normalizes legacy auth choices before provider selection", async () => {
    resolveManifestDeprecatedProviderAuthChoice.mockReturnValue({
      choiceId: "anthropic-cli",
      choiceLabel: "Anthropic Claude CLI",
    });
    resolveManifestProviderAuthChoice.mockReturnValue({ providerId: "anthropic" });

    await expect(resolvePreferredProviderForAuthChoice({ choice: "claude-cli" })).resolves.toBe(
      "anthropic",
    );
    expect(resolveManifestDeprecatedProviderAuthChoice).toHaveBeenCalledWith(
      "claude-cli",
      undefined,
    );
    expect(resolveProviderPluginChoiceCore).not.toHaveBeenCalled();
    expect(resolvePluginProvidersCore).not.toHaveBeenCalled();
  });

  it("passes untrusted-workspace filtering through setup-provider fallback lookup", async () => {
    resolveProviderPluginChoiceCore.mockReturnValue({
      provider: { id: "demo-provider" },
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
