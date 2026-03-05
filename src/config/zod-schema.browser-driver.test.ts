import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema browser profile driver", () => {
  it("accepts openclaw and legacy clawd drivers", () => {
    expect(() =>
      OpenClawSchema.parse({
        browser: {
          profiles: {
            default: {
              cdpPort: 9222,
              driver: "openclaw",
            },
            legacy: {
              cdpPort: 9223,
              driver: "clawd",
            },
          },
        },
      }),
    ).not.toThrow();
  });
});
