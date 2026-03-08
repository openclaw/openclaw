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
              color: "#1a2b3c",
            },
            legacy: {
              cdpPort: 9223,
              driver: "clawd",
              color: "#3c2b1a",
            },
          },
        },
      }),
    ).not.toThrow();
  });
});
