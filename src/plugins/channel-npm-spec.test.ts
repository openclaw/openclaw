import { describe, expect, it } from "vitest";
import { resolveChannelAwareNpmSpec } from "./channel-npm-spec.js";

describe("resolveChannelAwareNpmSpec", () => {
  it("pins bare npm specs to the package prerelease version", () => {
    expect(
      resolveChannelAwareNpmSpec({
        npmSpec: "@openclaw/twitch",
        packageName: "@openclaw/twitch",
        packageVersion: "2026.5.2-beta.2",
      }),
    ).toBe("@openclaw/twitch@2026.5.2-beta.2");
  });

  it("targets the beta dist-tag for bare plugin specs on beta channel", () => {
    expect(
      resolveChannelAwareNpmSpec({
        npmSpec: "@openclaw/twitch",
        channel: "beta",
      }),
    ).toBe("@openclaw/twitch@beta");
  });

  it("preserves explicit versions and tags", () => {
    expect(
      resolveChannelAwareNpmSpec({
        npmSpec: "@openclaw/twitch@2026.5.2-beta.2",
        channel: "beta",
      }),
    ).toBe("@openclaw/twitch@2026.5.2-beta.2");
    expect(
      resolveChannelAwareNpmSpec({
        npmSpec: "@openclaw/twitch@latest",
        packageVersion: "2026.5.2-beta.2",
      }),
    ).toBe("@openclaw/twitch@latest");
  });
});
