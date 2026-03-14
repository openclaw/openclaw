import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveApiKeyForProvider: vi.fn(),
}));

vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProvider: mocks.resolveApiKeyForProvider,
}));

import { ensureGatewayModelAuthConfigured } from "./startup-model-auth.js";

describe("ensureGatewayModelAuthConfigured", () => {
  beforeEach(() => {
    mocks.resolveApiKeyForProvider.mockReset();
  });

  it("checks provider auth for the configured model on startup", async () => {
    mocks.resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "test-key",
      source: "env",
      mode: "api-key",
    });

    await expect(
      ensureGatewayModelAuthConfigured({
        cfg: {},
      }),
    ).resolves.toBeUndefined();

    expect(mocks.resolveApiKeyForProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        cfg: {},
      }),
    );
  });

  it("skips startup auth preflight for CLI-backed models", async () => {
    await expect(
      ensureGatewayModelAuthConfigured({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "codex-cli/gpt-5",
              },
            },
          },
        },
      }),
    ).resolves.toBeUndefined();

    expect(mocks.resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("throws an actionable startup error when provider auth is missing", async () => {
    mocks.resolveApiKeyForProvider.mockRejectedValue(
      new Error('No API key found for provider "anthropic".'),
    );

    await expect(
      ensureGatewayModelAuthConfigured({
        cfg: {},
      }),
    ).rejects.toThrow(/Gateway startup blocked/);
    await expect(
      ensureGatewayModelAuthConfigured({
        cfg: {},
      }),
    ).rejects.toThrow(/anthropic\/claude-opus-4-6/);
    await expect(
      ensureGatewayModelAuthConfigured({
        cfg: {},
      }),
    ).rejects.toThrow(/openclaw configure/);
    await expect(
      ensureGatewayModelAuthConfigured({
        cfg: {},
      }),
    ).rejects.toThrow(/openclaw models set/);
  });
});

