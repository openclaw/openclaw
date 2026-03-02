import { beforeEach, describe, expect, test, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const loadConfigMock = vi.fn<() => OpenClawConfig>();

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: () => loadConfigMock(),
  };
});

describe("resolveAgentRoute fresh config routing", () => {
  beforeEach(() => {
    vi.resetModules();
    loadConfigMock.mockReset();
  });

  test("prefers fresh config bindings over stale caller cfg", async () => {
    const staleCfg: OpenClawConfig = {
      bindings: [{ agentId: "stale", match: { channel: "telegram", accountId: "work" } }],
    };
    const freshCfg: OpenClawConfig = {
      bindings: [{ agentId: "fresh", match: { channel: "telegram", accountId: "work" } }],
    };
    loadConfigMock.mockReturnValue(freshCfg);

    const { resolveAgentRoute } = await import("./resolve-route.js");
    const route = resolveAgentRoute({
      cfg: staleCfg,
      channel: "telegram",
      accountId: "work",
      peer: { kind: "direct", id: "123" },
    });

    expect(route.agentId).toBe("fresh");
    expect(route.matchedBy).toBe("binding.account");
  });

  test("falls back to caller cfg when fresh config degrades to empty", async () => {
    const staleCfg: OpenClawConfig = {
      bindings: [{ agentId: "stale", match: { channel: "telegram", accountId: "work" } }],
    };
    loadConfigMock.mockReturnValue({});

    const { resolveAgentRoute } = await import("./resolve-route.js");
    const route = resolveAgentRoute({
      cfg: staleCfg,
      channel: "telegram",
      accountId: "work",
      peer: { kind: "direct", id: "123" },
    });

    expect(route.agentId).toBe("stale");
    expect(route.matchedBy).toBe("binding.account");
  });

  test("falls back to caller cfg when fresh config load throws", async () => {
    const staleCfg: OpenClawConfig = {
      bindings: [{ agentId: "stale", match: { channel: "telegram", accountId: "work" } }],
    };
    loadConfigMock.mockImplementation(() => {
      throw new Error("config unavailable");
    });

    const { resolveAgentRoute } = await import("./resolve-route.js");
    const route = resolveAgentRoute({
      cfg: staleCfg,
      channel: "telegram",
      accountId: "work",
      peer: { kind: "direct", id: "123" },
    });

    expect(route.agentId).toBe("stale");
    expect(route.matchedBy).toBe("binding.account");
  });
});
