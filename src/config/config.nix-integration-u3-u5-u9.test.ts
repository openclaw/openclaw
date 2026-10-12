import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfigPathCandidate } from "./config.js";
import { withTempHome } from "./test-helpers.js";

describe("Nix integration config selection", () => {
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
});
