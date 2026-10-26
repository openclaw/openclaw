import { describe, expect, it } from "vitest";
import { ToolsSchema } from "./zod-schema.agent-runtime.js";

describe("web_fetch Decision quality config", () => {
  it("accepts only explicit modes", () => {
    for (const mode of ["shadow", "apply"]) {
      expect(
        ToolsSchema.parse({ web: { fetch: { decisionQuality: mode } } })?.web?.fetch
          ?.decisionQuality,
      ).toBe(mode);
    }
    for (const mode of [true, "off", { mode: "apply" }]) {
      expect(ToolsSchema.safeParse({ web: { fetch: { decisionQuality: mode } } }).success).toBe(
        false,
      );
    }
  });
});
