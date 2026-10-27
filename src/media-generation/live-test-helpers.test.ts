import { describe, expect, it } from "vitest";
import {
  parseLiveCsvFilter,
  parseProviderModelMap,
  redactLiveApiKey,
  resolveLiveAuthStore,
} from "./live-test-helpers.js";

describe("media-generation live-test helpers", () => {
  it("parses provider filters and treats empty/all as unfiltered", () => {
    expect(parseLiveCsvFilter()).toBeNull();
    expect(parseLiveCsvFilter("all")).toBeNull();
    expect(parseLiveCsvFilter(" Google:Flash , OpenAI:Default ")).toEqual(
      new Set(["google:flash", "openai:default"]),
    );
    expect(parseLiveCsvFilter(" OpenAI , Google ", { lowercase: false })).toEqual(
      new Set(["OpenAI", "Google"]),
    );
  });

  it("parses provider model overrides by provider id", () => {
    expect(
      parseProviderModelMap(
        "google/veo-3.1-fast-generate-preview, xai/grok-imagine-video, invalid",
      ),
    ).toEqual(
      new Map([
        ["google", "google/veo-3.1-fast-generate-preview"],
        ["xai", "xai/grok-imagine-video"],
      ]),
    );
  });

  it("redacts live API keys for diagnostics", () => {
    expect(redactLiveApiKey(undefined)).toBe("none");
    expect(redactLiveApiKey("   ")).toBe("none");
    expect(redactLiveApiKey("synthetic-12")).toBe("<redacted>");
    expect(redactLiveApiKey("synthetic-credential-value")).toBe("<redacted>");
  });

  it("uses an empty auth store when live env keys should override stale profiles", () => {
    expect(
      resolveLiveAuthStore({
        requireProfileKeys: false,
        hasLiveKeys: true,
      }),
    ).toEqual({
      version: 1,
      profiles: {},
    });
  });

  it("keeps profile-store mode when requested or when no live keys exist", () => {
    expect(
      resolveLiveAuthStore({
        requireProfileKeys: true,
        hasLiveKeys: true,
      }),
    ).toBeUndefined();
    expect(
      resolveLiveAuthStore({
        requireProfileKeys: false,
        hasLiveKeys: false,
      }),
    ).toBeUndefined();
  });
});
