import { describe, expect, it } from "vitest";
import { validateConfigObjectWithPlugins } from "./config.js";

describe("config hooks mapping channel validation", () => {
  it("accepts extension channel IDs in hooks.mappings[].channel", () => {
    const res = validateConfigObjectWithPlugins({
      agents: { list: [{ id: "pi" }] },
      hooks: {
        mappings: [
          {
            match: { path: "custom" },
            action: "agent",
            channel: "bluebubbles",
          },
        ],
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects empty hooks.mappings[].channel", () => {
    const res = validateConfigObjectWithPlugins({
      agents: { list: [{ id: "pi" }] },
      hooks: {
        mappings: [
          {
            match: { path: "custom" },
            action: "agent",
            channel: "   ",
          },
        ],
      },
    });
    expect(res.ok).toBe(false);
    if (res.ok) {
      throw new Error("expected validation failure");
    }
    expect(res.issues.some((issue) => issue.path === "hooks.mappings.0.channel")).toBe(true);
  });
});
