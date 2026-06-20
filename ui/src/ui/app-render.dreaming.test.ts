// Control UI tests cover app renderreaming behavior.
import { describe, expect, it } from "vitest";
import { formatDreamNextCycle } from "../pages/dreams/route.ts";

describe("formatDreamNextCycle", () => {
  it("formats valid next-run timestamps", () => {
    expect(formatDreamNextCycle(1_700_000_000_000)).toMatch(/\d/);
  });
});
