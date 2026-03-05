import { describe, expect, it } from "vitest";
import type { ProviderPlugin } from "../plugins/types.js";
import { resolveLoginProviders, resolveRequestedLoginProviderOrThrow } from "./models/auth.js";

function makeProvider(params: { id: string; label?: string; aliases?: string[] }): ProviderPlugin {
  return {
    id: params.id,
    label: params.label ?? params.id,
    aliases: params.aliases,
    auth: [],
  };
}

describe("resolveRequestedLoginProviderOrThrow", () => {
  it("returns null and resolves provider by id/alias", () => {
    const providers = [
      makeProvider({ id: "google-gemini-cli", aliases: ["gemini-cli"] }),
      makeProvider({ id: "qwen-portal" }),
    ];
    const scenarios = [
      { requested: undefined, expectedId: null },
      { requested: "google-gemini-cli", expectedId: "google-gemini-cli" },
      { requested: "gemini-cli", expectedId: "google-gemini-cli" },
    ] as const;

    for (const scenario of scenarios) {
      const result = resolveRequestedLoginProviderOrThrow(providers, scenario.requested);
      expect(result?.id ?? null).toBe(scenario.expectedId);
    }
  });

  it("throws when requested provider is not loaded", () => {
    const loadedProviders = [
      makeProvider({ id: "google-gemini-cli" }),
      makeProvider({ id: "qwen-portal" }),
    ];

    expect(() =>
      resolveRequestedLoginProviderOrThrow(loadedProviders, "google-antigravity"),
    ).toThrowError(
      'Unknown provider "google-antigravity". Loaded providers: google-gemini-cli, qwen-portal. Verify plugins via `openclaw plugins list --json`.',
    );
  });
});

describe("resolveLoginProviders", () => {
  it("includes openai-codex built-in provider when no plugins are installed", () => {
    const providers = resolveLoginProviders([]);
    expect(providers.some((provider) => provider.id === "openai-codex")).toBe(true);
  });

  it("prefers loaded plugins over built-in providers for the same id", () => {
    const providers = resolveLoginProviders([
      makeProvider({ id: "openai-codex", label: "custom" }),
    ]);
    const codex = providers.find((provider) => provider.id === "openai-codex");
    expect(codex?.label).toBe("custom");
  });
});
