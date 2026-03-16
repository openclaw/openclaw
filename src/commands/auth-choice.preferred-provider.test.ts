import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveProviderPluginChoice = vi.hoisted(() => vi.fn());
const resolvePluginProviders = vi.hoisted(() => vi.fn(() => []));

vi.mock("../plugins/provider-wizard.js", () => ({
  resolveProviderPluginChoice,
}));

vi.mock("../plugins/providers.js", () => ({
  resolvePluginProviders,
}));

import { resolvePreferredProviderForAuthChoice } from "./auth-choice.preferred-provider.js";

describe("resolvePreferredProviderForAuthChoice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolvePluginProviders.mockReturnValue([]);
    resolveProviderPluginChoice.mockReturnValue(null);
  });

  it("normalizes legacy auth choices before plugin lookup", async () => {
    resolveProviderPluginChoice.mockReturnValue({
      provider: { id: "anthropic", label: "Anthropic", auth: [] },
      method: { id: "setup-token", label: "setup-token", kind: "token" },
    });

    await expect(resolvePreferredProviderForAuthChoice({ choice: "claude-cli" })).resolves.toBe(
      "anthropic",
    );
    expect(resolveProviderPluginChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        choice: "setup-token",
      }),
    );
    expect(resolvePluginProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        bundledProviderAllowlistCompat: true,
        bundledProviderVitestCompat: true,
      }),
    );
  });

  it("falls back to static core choices when no provider plugin claims the choice", async () => {
    await expect(resolvePreferredProviderForAuthChoice({ choice: "chutes" })).resolves.toBe(
      "chutes",
    );
  });
});
