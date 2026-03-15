import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("BrowserConfig in OpenClawSchema - extraArgs validation", () => {
  it("parses valid extraArgs", () => {
    const input = {
      browser: {
        defaultProfile: "default",
        extraArgs: ["--no-sandbox", "--user-agent=Test/1.0"],
      },
    };

    const result = OpenClawSchema.safeParse(input);
    expect(result.success).toBe(true);
    expect(result.data?.browser?.extraArgs).toEqual(["--no-sandbox", "--user-agent=Test/1.0"]);
  });

  it("rejects non-array extraArgs", () => {
    const invalid = {
      browser: {
        defaultProfile: "default",
        extraArgs: "--invalid-string", // not an array
        profiles: { default: { cdpUrl: "http://localhost:9222" } },
      },
    };

    const result = OpenClawSchema.safeParse(invalid);
    expect(result.success).toBe(false);

    if (!result.success) {
      const issues = result.error.issues;
      const hasArrayError = issues.some(
        (i) => i.path.includes("extraArgs") && i.message.includes("array"),
      );
      expect(hasArrayError).toBe(true);
    }
  });

  it("allows extraArgs to be omitted (optional)", () => {
    const noExtra = {
      browser: {
        defaultProfile: "default",
      },
    };

    const result = OpenClawSchema.safeParse(noExtra);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data?.browser?.extraArgs).toBeUndefined(); // or undefined if no .default([])
    }
  });
});
