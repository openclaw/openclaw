import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

describe("resolveVisibleSessionKeys", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
    vi.resetModules();
  });

  it("returns null when visibility is all", async () => {
    const cfg = {
      tools: { sessions: { visibility: "all" } },
    } as OpenClawConfig;
    const { resolveVisibleSessionKeys } = await import("./sessions-visible-keys.js");
    await expect(
      resolveVisibleSessionKeys({ cfg, agentSessionKey: "agent:main:main" }),
    ).resolves.toBe(null);
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("returns only visible keys for tree visibility", async () => {
    callGatewayMock.mockResolvedValue({
      sessions: [
        { key: "agent:main:main" },
        { key: "agent:main:subagent:child" },
        { key: "agent:main:other" },
        { key: "unknown" },
      ],
    });
    const cfg = {
      tools: { sessions: { visibility: "tree" } },
    } as OpenClawConfig;
    const { resolveVisibleSessionKeys } = await import("./sessions-visible-keys.js");
    const keys = await resolveVisibleSessionKeys({ cfg, agentSessionKey: "agent:main:main" });
    expect(keys).not.toBeNull();
    expect(keys?.has("agent:main:main")).toBe(true);
    expect(keys?.has("agent:main:subagent:child")).toBe(true);
    expect(keys?.has("unknown")).toBe(false);
  });

  it("uses spawnedBy filter in sandbox spawned clamp mode", async () => {
    callGatewayMock.mockResolvedValue({
      sessions: [{ key: "agent:main:subagent:child" }],
    });
    const cfg = {
      tools: { sessions: { visibility: "tree" } },
      agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
    } as OpenClawConfig;
    const { resolveVisibleSessionKeys } = await import("./sessions-visible-keys.js");
    await resolveVisibleSessionKeys({
      cfg,
      agentSessionKey: "agent:main:main",
      sandboxed: true,
    });
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "sessions.list",
      params: {
        includeGlobal: false,
        includeUnknown: false,
        spawnedBy: "agent:main:main",
      },
    });
  });
});
