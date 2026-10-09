import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadVoiceWakeRoutingConfig } from "../../infra/voicewake-routing.js";
import { loadSessionEntry } from "../session-utils.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { voicewakeRoutingHandlers } from "./voicewake-routing.js";

vi.mock("../../infra/voicewake-routing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/voicewake-routing.js")>()),
  loadVoiceWakeRoutingConfig: vi.fn(),
}));
vi.mock("../session-utils.js", () => ({ loadSessionEntry: vi.fn() }));

const routingConfig = {
  version: 1 as const,
  defaultTarget: { mode: "current" as const },
  routes: [{ trigger: "robot wake", target: { sessionKey: "agent:main:voice" } }],
  updatedAtMs: 0,
};

beforeEach(() => {
  vi.mocked(loadVoiceWakeRoutingConfig).mockReset().mockResolvedValue(routingConfig);
  vi.mocked(loadSessionEntry)
    .mockReset()
    .mockReturnValue({
      cfg: {},
      canonicalKey: "agent:main:voice",
    } as ReturnType<typeof loadSessionEntry>);
});

describe("voicewake.routing.resolve", () => {
  it("returns the configured session for a matched wake trigger", async () => {
    const respond = vi.fn();
    const handler = voicewakeRoutingHandlers["voicewake.routing.resolve"];
    expect(handler).toBeDefined();
    await handler?.({
      params: { trigger: "robot wake" },
      respond,
      context: { getRuntimeConfig: () => ({}), logGateway: { warn: vi.fn() } },
    } as unknown as GatewayRequestHandlerOptions);
    expect(respond).toHaveBeenCalledWith(true, { sessionKey: "agent:main:voice" });
  });

  it("leaves an unmatched wake trigger on the current Talk selection", async () => {
    const respond = vi.fn();
    const handler = voicewakeRoutingHandlers["voicewake.routing.resolve"];
    expect(handler).toBeDefined();
    await handler?.({
      params: { trigger: "another wake" },
      respond,
      context: { getRuntimeConfig: () => ({}), logGateway: { warn: vi.fn() } },
    } as unknown as GatewayRequestHandlerOptions);
    expect(respond).toHaveBeenCalledWith(true, { sessionKey: null });
  });

  it("uses an explicit default agent route when no trigger-specific rule matches", async () => {
    vi.mocked(loadVoiceWakeRoutingConfig).mockResolvedValue({
      ...routingConfig,
      defaultTarget: { agentId: "main" },
    });
    const respond = vi.fn();
    await voicewakeRoutingHandlers["voicewake.routing.resolve"]?.({
      params: { trigger: "another wake" },
      respond,
      context: { getRuntimeConfig: () => ({}), logGateway: { warn: vi.fn() } },
    } as unknown as GatewayRequestHandlerOptions);
    expect(respond).toHaveBeenCalledWith(true, { sessionKey: "agent:main:main" });
  });

  it("rejects a configured route whose agent is no longer available", async () => {
    vi.mocked(loadVoiceWakeRoutingConfig).mockResolvedValue({
      ...routingConfig,
      routes: [{ trigger: "robot wake", target: { agentId: "removed" } }],
    });
    const respond = vi.fn();
    await voicewakeRoutingHandlers["voicewake.routing.resolve"]?.({
      params: { trigger: "robot wake" },
      respond,
      context: { getRuntimeConfig: () => ({}), logGateway: { warn: vi.fn() } },
    } as unknown as GatewayRequestHandlerOptions);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "voice wake route is unavailable" }),
    );
  });
});
