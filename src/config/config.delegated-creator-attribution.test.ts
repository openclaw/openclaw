import { expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

it("keeps delegated creator attribution opt-in and validates its boolean setting", () => {
  expect(
    OpenClawSchema.parse({}).agents?.defaults?.experimental?.delegatedCreatorAttribution,
  ).toBeUndefined();
  for (const enabled of [false, true]) {
    const parsed = OpenClawSchema.parse({
      agents: {
        entries: { main: {} },
        defaults: { experimental: { delegatedCreatorAttribution: enabled } },
      },
    });
    expect(parsed.agents?.defaults?.experimental?.delegatedCreatorAttribution).toBe(enabled);
  }
  for (const value of ["true", 1, null]) {
    const result = OpenClawSchema.safeParse({
      agents: {
        entries: { main: {} },
        defaults: { experimental: { delegatedCreatorAttribution: value } },
      },
    });
    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Invalid Lab setting was accepted");
    }
    expect(result.error.issues.map((issue) => issue.path)).toEqual([
      ["agents", "defaults", "experimental", "delegatedCreatorAttribution"],
    ]);
  }
});
