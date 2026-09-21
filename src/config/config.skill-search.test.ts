import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("Skill Search Labs config", () => {
  it.each([undefined, false, true])(
    "accepts boolean opt-in %s without enabling it implicitly",
    (search) => {
      const config = OpenClawSchema.parse(
        search === undefined ? {} : { skills: { experimental: { search } } },
      );
      expect(config.skills?.experimental?.search).toBe(search);
    },
  );
  it.each(["true", "auto", 1, {}, { enabled: true }])(
    "rejects unsupported enablement %j",
    (search) => {
      expect(OpenClawSchema.safeParse({ skills: { experimental: { search } } }).success).toBe(
        false,
      );
    },
  );
});
