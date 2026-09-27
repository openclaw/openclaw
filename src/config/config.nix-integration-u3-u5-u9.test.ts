import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfigPathCandidate, resolveIsNixMode } from "./config.js";
import { withTempHome } from "./test-helpers.js";

describe("Nix integration config selection", () => {
  it.each([
    { value: undefined, expected: false },
    { value: "true", expected: false },
    { value: "1", expected: true },
  ])("resolves OPENCLAW_NIX_MODE=$value to $expected", ({ value, expected }) => {
    expect(resolveIsNixMode({ OPENCLAW_NIX_MODE: value })).toBe(expected);
  });

  it("defaults CONFIG_PATH to OPENCLAW_HOME/.openclaw/openclaw.json", () => {
    const customHome = path.join(path.sep, "custom", "home");
    expect(resolveConfigPathCandidate({ OPENCLAW_HOME: customHome })).toBe(
      path.join(path.resolve(customHome), ".openclaw", "openclaw.json"),
    );
  });

  it("expands ~ in OPENCLAW_CONFIG_PATH override", async () => {
    await withTempHome(async (home) => {
      expect(
        resolveConfigPathCandidate(
          { OPENCLAW_HOME: home, OPENCLAW_CONFIG_PATH: "~/.openclaw/custom.json" },
          () => home,
        ),
      ).toBe(path.join(home, ".openclaw", "custom.json"));
    });
  });

  it("uses STATE_DIR when only state dir is overridden", () => {
    expect(
      resolveConfigPathCandidate(
        { OPENCLAW_STATE_DIR: "/custom/state", OPENCLAW_TEST_FAST: "1" },
        () => path.join(path.sep, "tmp", "openclaw-config-home"),
      ),
    ).toBe(path.join(path.resolve("/custom/state"), "openclaw.json"));
  });
});
