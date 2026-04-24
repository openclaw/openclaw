import { describe, expect, it } from "vitest";
import { formatOAuthRefreshFailureDoctorLine, resolveUnusableProfileHint } from "./doctor-auth.js";

describe("resolveUnusableProfileHint", () => {
  it("returns billing guidance for disabled billing profiles", () => {
    expect(resolveUnusableProfileHint({ kind: "disabled", reason: "billing" })).toBe(
      "Top up credits (provider billing) or switch provider.",
    );
  });

  it("returns credential guidance for permanent auth disables", () => {
    expect(resolveUnusableProfileHint({ kind: "disabled", reason: "auth_permanent" })).toBe(
      "Refresh or replace credentials, then retry.",
    );
  });

  it("falls back to cooldown guidance for non-billing disable reasons", () => {
    expect(resolveUnusableProfileHint({ kind: "disabled", reason: "unknown" })).toBe(
      "Wait for cooldown or switch provider.",
    );
  });

  it("returns cooldown guidance for cooldown windows", () => {
    expect(resolveUnusableProfileHint({ kind: "cooldown" })).toBe(
      "Wait for cooldown or switch provider.",
    );
  });

  it("formats permanent OAuth refresh failures as reauth-required", () => {
    expect(
      formatOAuthRefreshFailureDoctorLine({
        profileId: "openai-codex:default",
        provider: "openai-codex",
        message:
          "OAuth token refresh failed for openai-codex: refresh_token_reused. Please try again or re-authenticate.",
      }),
    ).toBe(
      "- openai-codex:default: re-auth required [refresh_token_reused] — Run `gemmaclaw models auth login --provider openai-codex`.",
    );
  });

  it("formats non-permanent OAuth refresh failures as retry-then-reauth guidance", () => {
    expect(
      formatOAuthRefreshFailureDoctorLine({
        profileId: "openai-codex:default",
        provider: "openai-codex",
        message:
          "OAuth token refresh failed for openai-codex: temporary upstream issue. Please try again or re-authenticate.",
      }),
    ).toBe(
      "- openai-codex:default: OAuth refresh failed — Try again; if this persists, run `gemmaclaw models auth login --provider openai-codex`.",
    );
  });

  it("drops the provider-specific command when the parsed provider is unsafe", () => {
    expect(
      formatOAuthRefreshFailureDoctorLine({
        profileId: "openai-codex:default",
        provider: "openai-codex",
        message:
          "OAuth token refresh failed for openai-codex`\nrm -rf /: invalid_grant. Please try again or re-authenticate.",
      }),
    ).toBe(
      "- openai-codex:default: re-auth required [invalid_grant] — Run `gemmaclaw models auth login --provider openai-codex`.",
    );
  });
});
