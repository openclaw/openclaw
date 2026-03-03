import { describe, expect, it } from "vitest";
import { shouldSkipRespawnForArgv } from "./respawn-policy.js";

describe("shouldSkipRespawnForArgv", () => {
  it("skips respawn for help/version invocations", () => {
    expect(shouldSkipRespawnForArgv(["node", "ironclaw", "--help"])).toBe(true);
    expect(shouldSkipRespawnForArgv(["node", "ironclaw", "-V"])).toBe(true);
  });

  it("does not skip respawn for normal command execution", () => {
    expect(shouldSkipRespawnForArgv(["node", "ironclaw", "chat", "send"])).toBe(false);
  });
});
