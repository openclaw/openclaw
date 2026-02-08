import os from "node:os";
import { describe, expect, it, vi } from "vitest";

describe("system-presence", () => {
  it("does not crash when os.networkInterfaces throws", async () => {
    vi.spyOn(os, "networkInterfaces").mockImplementation(() => {
      throw new Error("uv_interface_addresses failed");
    });

    // system-presence seeds self presence at module init time, so we must
    // mock before importing the module.
    const mod = await import(`./system-presence.js?test=${Date.now()}`);

    const entries = mod.listSystemPresence();
    expect(entries.length).toBeGreaterThan(0);
  });
});
