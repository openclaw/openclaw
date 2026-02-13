import { describe, expect, it, vi } from "vitest";

describe("gateway.tools config", () => {
  it("accepts gateway.tools allow and deny lists", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      gateway: {
        tools: {
          allow: ["gateway"],
          deny: ["sessions_spawn", "sessions_send"],
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects invalid gateway.tools values", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      gateway: {
        tools: {
          allow: "gateway",
        },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("gateway.tools.allow");
    }
  });
});
