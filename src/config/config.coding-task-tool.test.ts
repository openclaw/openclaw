import { describe, expect, it, vi } from "vitest";

describe("coding_task config", () => {
  it("accepts tools.codingTask.enabled", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      tools: {
        codingTask: {
          enabled: true,
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts tools.codingTask tool controls", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      tools: {
        codingTask: {
          enabled: true,
          permissionMode: "default",
          toolPreset: "readonly",
          allowedTools: ["Read", "Grep"],
          disallowedTools: ["Bash"],
          settingSources: ["project"],
          additionalDirectories: ["/tmp"],
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects unknown keys under tools.codingTask", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      tools: {
        codingTask: {
          enabled: true,
          nope: true,
        },
      },
    });
    expect(res.ok).toBe(false);
  });
});
