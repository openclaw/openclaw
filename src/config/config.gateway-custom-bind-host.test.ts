import { describe, expect, it, vi } from "vitest";

describe("gateway.customBindHost", () => {
  it("accepts custom bind mode with customBindHost", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      gateway: {
        bind: "custom",
        customBindHost: "192.168.1.100",
      },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts customBindHost with lan bind mode", async () => {
    // customBindHost is documented for bind="custom", but Zod validates
    // schema shape only - runtime handles semantic validation.
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      gateway: {
        bind: "lan",
        customBindHost: "10.0.0.5",
      },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts customBindHost with 0.0.0.0", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      gateway: {
        bind: "custom",
        customBindHost: "0.0.0.0",
      },
    });
    expect(res.ok).toBe(true);
  });
});
