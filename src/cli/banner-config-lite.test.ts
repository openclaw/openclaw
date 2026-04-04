import { describe, expect, it } from "vitest";
import { readCliBannerTaglineMode } from "./banner-config-lite.js";

describe("readCliBannerTaglineMode", () => {
  it("reads the tagline mode from env only", () => {
    expect(
      readCliBannerTaglineMode({
        OPENCLAW_CLI_BANNER_TAGLINE_MODE: "off",
      } as NodeJS.ProcessEnv),
    ).toBe("off");
  });

  it("ignores invalid env values", () => {
    expect(
      readCliBannerTaglineMode({
        OPENCLAW_CLI_BANNER_TAGLINE_MODE: "loud",
      } as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });
});
