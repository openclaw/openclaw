import { afterEach, describe, it, expect, vi } from "vitest";
import { probeFeishu, clearProbeCache } from "./probe.js";

vi.mock("./client.js", () => ({
  createFeishuClient: vi.fn(() => ({
    request: vi.fn().mockResolvedValue({
      code: 0,
      bot: { bot_name: "TestBot", open_id: "ou_bot" },
    }),
  })),
}));

afterEach(() => {
  clearProbeCache();
});

describe("probeFeishu", () => {
  it("returns error when credentials are missing", async () => {
    const result = await probeFeishu();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("missing credentials");
  });

  it("returns error when appId is empty", async () => {
    const result = await probeFeishu({ appId: "", appSecret: "s" });
    expect(result.ok).toBe(false);
  });

  it("returns ok with bot info on success", async () => {
    const result = await probeFeishu({ appId: "cli_abc", appSecret: "secret" });
    expect(result.ok).toBe(true);
    expect(result.appId).toBe("cli_abc");
    expect(result.botName).toBe("TestBot");
    expect(result.botOpenId).toBe("ou_bot");
  });

  it("caches successful results", async () => {
    const r1 = await probeFeishu({ appId: "cli_abc", appSecret: "secret" });
    const r2 = await probeFeishu({ appId: "cli_abc", appSecret: "secret" });
    expect(r1).toEqual(r2);
  });

  it("cache is cleared by clearProbeCache", async () => {
    await probeFeishu({ appId: "cli_abc", appSecret: "secret" });
    clearProbeCache();
    const result = await probeFeishu({ appId: "cli_abc", appSecret: "secret" });
    expect(result.ok).toBe(true);
  });
});
