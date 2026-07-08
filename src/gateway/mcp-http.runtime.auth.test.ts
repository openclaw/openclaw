// Auth-profile plumbing tests for MCP loopback runtime tool resolution.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const resolveGatewayScopedToolsMock = vi.hoisted(() =>
  vi.fn(() => ({
    agentId: "main",
    tools: [],
  })),
);

vi.mock("./tool-resolution.js", () => ({
  resolveGatewayScopedTools: (...args: unknown[]) => resolveGatewayScopedToolsMock(...args),
}));

import { resolveMcpLoopbackScopedTools } from "./mcp-http.runtime.js";

function createAuthProfileStore(): {
  profiles: Record<string, { provider: string; type: string }>;
} {
  return {
    profiles: {
      "xai-oauth": { provider: "xai", type: "oauth" },
    },
  };
}

describe("resolveMcpLoopbackScopedTools auth profile plumbing", () => {
  beforeEach(() => {
    resolveGatewayScopedToolsMock.mockClear();
  });

  it("forwards authProfileStore to resolveGatewayScopedTools", () => {
    const authProfileStore = createAuthProfileStore();
    resolveMcpLoopbackScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main",
      messageProvider: undefined,
      currentChannelId: undefined,
      currentThreadTs: undefined,
      currentMessageId: undefined,
      currentInboundAudio: undefined,
      accountId: undefined,
      inboundEventKind: undefined,
      sourceReplyDeliveryMode: undefined,
      senderIsOwner: undefined,
      authProfileStore,
    });

    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(1);
    const passedParams = resolveGatewayScopedToolsMock.mock.calls[0]?.[0];
    expect(passedParams).toMatchObject({
      surface: "loopback",
      authProfileStore,
    });
  });

  it("does not pass authProfileStore when omitted", () => {
    resolveMcpLoopbackScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main",
      messageProvider: undefined,
      currentChannelId: undefined,
      currentThreadTs: undefined,
      currentMessageId: undefined,
      currentInboundAudio: undefined,
      accountId: undefined,
      inboundEventKind: undefined,
      sourceReplyDeliveryMode: undefined,
      senderIsOwner: undefined,
    });

    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(1);
    const passedParams = resolveGatewayScopedToolsMock.mock.calls[0]?.[0];
    expect(passedParams.authProfileStore).toBeUndefined();
  });
});
