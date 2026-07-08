// Auth-profile plumbing tests for MCP loopback runtime tool resolution.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const resolveGatewayScopedToolsMock = vi.hoisted(() =>
  vi.fn((_params: { authProfileStore?: AuthProfileStore }) => ({
    agentId: "main",
    tools: [],
  })),
);

vi.mock("./tool-resolution.js", () => ({
  resolveGatewayScopedTools: resolveGatewayScopedToolsMock,
}));

import { resolveMcpLoopbackScopedTools } from "./mcp-http.runtime.js";

function createAuthProfileStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "xai-oauth": {
        type: "oauth",
        provider: "xai",
        access: "xai-access-token",
        refresh: "xai-refresh-token",
        expires: 1_900_000_000_000,
      },
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
