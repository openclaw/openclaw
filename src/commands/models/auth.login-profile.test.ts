import { describe, expect, it } from "vitest";
import { normalizeAuthLoginProfileId, remapAuthLoginProfiles } from "./auth.js";

describe("normalizeAuthLoginProfileId", () => {
  it("returns undefined when no profile id is provided", () => {
    expect(normalizeAuthLoginProfileId(undefined, "openai-codex")).toBeUndefined();
    expect(normalizeAuthLoginProfileId("   ", "openai-codex")).toBeUndefined();
  });

  it("prefixes bare profile names with provider id", () => {
    expect(normalizeAuthLoginProfileId("two", "openai-codex")).toBe("openai-codex:two");
  });

  it("normalizes prefixed profile ids for matching provider", () => {
    expect(normalizeAuthLoginProfileId("OpenAI-Codex:two", "openai-codex")).toBe(
      "openai-codex:two",
    );
  });

  it("rejects profile ids for other providers", () => {
    expect(() => normalizeAuthLoginProfileId("anthropic:work", "openai-codex")).toThrow(
      'Auth profile "anthropic:work" is for anthropic, not openai-codex.',
    );
  });

  it("rejects malformed prefixed ids", () => {
    expect(() => normalizeAuthLoginProfileId("openai-codex:", "openai-codex")).toThrow(
      'Invalid --profile-id "openai-codex:".',
    );
  });
});

describe("remapAuthLoginProfiles", () => {
  const oauthCredential = {
    type: "oauth" as const,
    provider: "openai-codex",
    access: "a",
    refresh: "r",
    expires: Date.now() + 60_000,
  };

  it("keeps original profiles when no override is provided", () => {
    const profiles = [{ profileId: "openai-codex:default", credential: oauthCredential }];
    expect(
      remapAuthLoginProfiles({
        profiles,
        profileId: undefined,
        providerId: "openai-codex",
      }),
    ).toEqual(profiles);
  });

  it("remaps a single returned profile to requested profile id", () => {
    expect(
      remapAuthLoginProfiles({
        profiles: [{ profileId: "openai-codex:default", credential: oauthCredential }],
        profileId: "openai-codex:two",
        providerId: "openai-codex",
      }),
    ).toEqual([{ profileId: "openai-codex:two", credential: oauthCredential }]);
  });

  it("rejects remap when provider returns multiple profiles", () => {
    expect(() =>
      remapAuthLoginProfiles({
        profiles: [
          { profileId: "openai-codex:default", credential: oauthCredential },
          { profileId: "openai-codex:other", credential: oauthCredential },
        ],
        profileId: "openai-codex:two",
        providerId: "openai-codex",
      }),
    ).toThrow("--profile-id requires exactly one returned profile");
  });

  it("rejects remap when returned credential provider mismatches selection", () => {
    expect(() =>
      remapAuthLoginProfiles({
        profiles: [
          {
            profileId: "anthropic:default",
            credential: { ...oauthCredential, provider: "anthropic" },
          },
        ],
        profileId: "openai-codex:two",
        providerId: "openai-codex",
      }),
    ).toThrow('Auth flow returned provider "anthropic" but selected provider is "openai-codex".');
  });
});
