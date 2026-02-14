import { describe, expect, it } from "vitest";
import type { ProviderPlugin } from "../plugins/types.js";
import { resolveRequestedLoginProviderOrThrow } from "./models/auth.js";

function makeProvider(params: { id: string; label?: string; aliases?: string[] }): ProviderPlugin {
  return {
    id: params.id,
    label: params.label ?? params.id,
    aliases: params.aliases,
    auth: [],
  };
}

describe("resolveRequestedLoginProviderOrThrow", () => {
  it("returns null when no provider was requested", () => {
    const providers = [makeProvider({ id: "google-antigravity" })];
    const result = resolveRequestedLoginProviderOrThrow(providers, undefined);
    expect(result).toBeNull();
  });

  it("resolves requested provider by id", () => {
    const providers = [
      makeProvider({ id: "google-antigravity" }),
      makeProvider({ id: "google-gemini-cli" }),
    ];
    const result = resolveRequestedLoginProviderOrThrow(providers, "google-antigravity");
    expect(result?.id).toBe("google-antigravity");
  });

  it("resolves requested provider by alias", () => {
    const providers = [makeProvider({ id: "google-antigravity", aliases: ["antigravity"] })];
    const result = resolveRequestedLoginProviderOrThrow(providers, "antigravity");
    expect(result?.id).toBe("google-antigravity");
  });

  it("throws when requested provider is not loaded", () => {
    const providers = [
      makeProvider({ id: "google-gemini-cli" }),
      makeProvider({ id: "qwen-portal" }),
    ];

    expect(() =>
      resolveRequestedLoginProviderOrThrow(providers, "google-antigravity"),
    ).toThrowError(
      'Unknown provider "google-antigravity". Loaded providers: google-gemini-cli, qwen-portal. Verify plugins via `openclaw plugins list --json`.',
    );
  });
});
