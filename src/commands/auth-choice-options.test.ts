import { describe, expect, it } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import { buildAuthChoiceGroups, buildAuthChoiceOptions } from "./auth-choice-options.js";

describe("buildAuthChoiceOptions (unit)", () => {
  it("includes edgee auth choice", () => {
    const store: AuthProfileStore = { version: 1, profiles: {} };
    const options = buildAuthChoiceOptions({ store, includeSkip: false });
    expect(options.some((opt) => opt.value === "edgee-api-key")).toBe(true);
  });

  it("includes edgee auth group", () => {
    const store: AuthProfileStore = { version: 1, profiles: {} };
    const { groups } = buildAuthChoiceGroups({ store, includeSkip: false });
    const edgeeGroup = groups.find((group) => group.value === "edgee");
    expect(edgeeGroup).toBeDefined();
    expect(edgeeGroup?.options.some((opt) => opt.value === "edgee-api-key")).toBe(true);
  });
});
