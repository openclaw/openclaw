import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

// Regression test for https://github.com/openclaw/openclaw/issues/35620
// The project was renamed from "clawd" -> "openclaw"; schema must accept "openclaw".

describe("config schema: browser.profiles.*.driver", () => {
  it("accepts browser profile driver: openclaw", () => {
    const res = validateConfigObject({
      browser: {
        profiles: {
          default: {
            cdpPort: 9222,
            driver: "openclaw",
            color: "#ff0000",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts browser profile driver: clawd (legacy)", () => {
    const res = validateConfigObject({
      browser: {
        profiles: {
          default: {
            cdpPort: 9222,
            driver: "clawd",
            color: "#ff0000",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects unknown browser profile driver values", () => {
    const res = validateConfigObject({
      browser: {
        profiles: {
          default: {
            cdpPort: 9222,
            driver: "not-a-driver",
            color: "#ff0000",
          },
        },
      },
    });

    expect(res.ok).toBe(false);
  });
});
