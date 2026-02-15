import { describe, expect, it } from "vitest";
import { shouldSkipRespawnForArgv } from "./respawn-policy.js";

describe("shouldSkipRespawnForArgv", () => {
  it("skips respawn for help/version calls", () => {
    expect(shouldSkipRespawnForArgv(["node", "openclaw", "--help"])).toBe(true);
    expect(shouldSkipRespawnForArgv(["node", "openclaw", "-V"])).toBe(true);
  });

  it("keeps respawn path for normal commands", () => {
    expect(shouldSkipRespawnForArgv(["node", "openclaw", "status"])).toBe(false);
  });
});
