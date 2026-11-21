import { describe, expect, it } from "vitest";
import { OpenClawSchemaShape } from "./zod-schema.root-shape.js";

const externalProfile = {
  engine: "lightpanda",
  cdpUrl: "ws://127.0.0.1:9222/",
  attachOnly: true,
};

describe.each(["lightpanda", "kitesurf"] as const)("%s browser engine config", (engine) => {
  it.each([
    ["cdpUrl", undefined],
    ["attachOnly", undefined],
    ["driver", "extension"],
    ["userDataDir", "/tmp/chrome-profile"],
    ["headlessUserAgent", "chrome"],
  ])("rejects incompatible external engine %s=%s", (key, value) => {
    const result = OpenClawSchemaShape.browser.safeParse({
      profiles: { lightweight: { ...externalProfile, engine, [key as string]: value } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(
        `profiles.lightweight.${key}`,
      );
    }
  });

  it("rejects an external endpoint shared with Chromium", () => {
    const result = OpenClawSchemaShape.browser.safeParse({
      profiles: {
        lightweight: { ...externalProfile, engine },
        alias: { engine: "chromium", cdpUrl: "ws://127.0.0.1:9222", attachOnly: true },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("dedicated CDP endpoint");
    }
  });
});

// The persisted config boundary must accept the opt-in while rejecting typos.
it.each([
  ["native", true],
  ["chrome", true],
  ["automatic", false],
])("validates headless user-agent mode %s", (headlessUserAgent, success) => {
  for (const browser of [
    { headlessUserAgent },
    { profiles: { work: { cdpPort: 18801, headlessUserAgent } } },
  ]) {
    expect(OpenClawSchemaShape.browser.safeParse(browser).success).toBe(success);
  }
});
