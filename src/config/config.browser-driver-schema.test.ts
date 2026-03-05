import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("browser profile driver schema", () => {
  it("accepts driver=openclaw", () => {
    const res = OpenClawSchema.safeParse({
      browser: {
        profiles: {
          primary: {
            cdpUrl: "ws://127.0.0.1:9222/devtools/browser/test",
            driver: "openclaw",
            color: "#123456",
          },
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("keeps legacy driver=clawd for backward compatibility", () => {
    const res = OpenClawSchema.safeParse({
      browser: {
        profiles: {
          legacy: {
            cdpUrl: "ws://127.0.0.1:9222/devtools/browser/test",
            driver: "clawd",
            color: "#654321",
          },
        },
      },
    });

    expect(res.success).toBe(true);
  });
});
