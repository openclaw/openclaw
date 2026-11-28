import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OpenClawSchema } from "./zod-schema.js";
import { OpenClawSchemaShape } from "./zod-schema.root-shape.js";

const externalProfile = {
  engine: "lightpanda",
  cdpUrl: "ws://127.0.0.1:9222/",
  attachOnly: true,
};

it("constructs the profile name validator once, when the browser shape is needed", () => {
  const browser = OpenClawSchemaShape.browser.unwrap();
  const clone = browser.clone();
  using profileNameRegex = vi.spyOn(z.ZodString.prototype, "regex", "get");

  expect(OpenClawSchema.safeParse({}).success).toBe(true);
  expect(profileNameRegex).not.toHaveBeenCalled();
  expect(OpenClawSchema.safeParse({ browser: {} }).success).toBe(true);
  expect(profileNameRegex).toHaveBeenCalledTimes(1);

  expect(clone.shape.profiles).toBe(browser.shape.profiles);
  expect(browser.toJSONSchema().properties).toHaveProperty("profiles");
  expect(profileNameRegex).toHaveBeenCalledTimes(1);
});

describe.each(["lightpanda", "kitesurf"] as const)("%s browser engine config", (engine) => {
  it.each([
    ["cdpUrl", undefined],
    ["attachOnly", undefined],
    ["driver", "extension"],
    ["userDataDir", "/tmp/chrome-profile"],
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
