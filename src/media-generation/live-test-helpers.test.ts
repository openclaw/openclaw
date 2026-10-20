import { describe, expect, it } from "vitest";
import {
  parseLiveCsvFilter,
  parseProviderModelMap,
  redactLiveApiKey,
} from "./live-test-helpers.js";

describe("media-generation live-test helpers", () => {
  it("parses provider filters and treats empty/all as unfiltered", () => {
    expect(parseLiveCsvFilter()).toBeNull();
    expect(parseLiveCsvFilter("all")).toBeNull();
    expect(parseLiveCsvFilter(" google , xai ")).toEqual(new Set(["google", "xai"]));
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
});
