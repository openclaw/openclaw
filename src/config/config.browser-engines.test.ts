import { describe, expect, it } from "vitest";
import { OpenClawSchemaShape } from "./zod-schema.root-shape.js";

const lightpandaProfile = {
  engine: "lightpanda",
  cdpUrl: "ws://127.0.0.1:9222/",
  attachOnly: true,
};

describe("browser engine config", () => {
  it.each([
    ["cdpUrl", undefined],
    ["attachOnly", undefined],
    ["driver", "extension"],
    ["userDataDir", "/tmp/chrome-profile"],
  ])("rejects incompatible Lightpanda %s=%s", (key, value) => {
    const result = OpenClawSchemaShape.browser.safeParse({
      profiles: { lightweight: { ...lightpandaProfile, [key as string]: value } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(
        `profiles.lightweight.${key}`,
      );
    }
  });

  it("rejects a Lightpanda endpoint shared with Chromium", () => {
    const result = OpenClawSchemaShape.browser.safeParse({
      profiles: {
        lightweight: lightpandaProfile,
        alias: { engine: "chromium", cdpUrl: "ws://127.0.0.1:9222", attachOnly: true },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("dedicated CDP endpoint");
    }
  });
});
