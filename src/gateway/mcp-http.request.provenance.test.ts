// Regression for the thread-binding origin provenance fail-closed gate
// (issue #158945 review P1): the MCP loopback authenticator must host-mint the
// current-conversation provenance so a caller cannot use a writable
// x-openclaw-current-channel-id header to select a child-thread binding target.
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import type { McpLoopbackRequestContext } from "./mcp-grant-store.js";
import { resolveMcpRequestContext } from "./mcp-http.request.js";

type McpLoopbackRequestAuthLike = Parameters<typeof resolveMcpRequestContext>[2];

function fakeRequest(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

const cfg = {} as Parameters<typeof resolveMcpRequestContext>[1];

describe("resolveMcpRequestContext current-conversation provenance", () => {
  it("stamps caller-token for the generic bearer branch that reads writable headers", () => {
    const context = resolveMcpRequestContext(
      fakeRequest({
        "x-session-key": "agent:main:telegram:group:chat123",
        "x-openclaw-current-channel-id": "telegram:chat123",
        "x-openclaw-current-thread-ts": "42",
      }),
      cfg,
      { senderIsOwner: true } satisfies McpLoopbackRequestAuthLike,
    );
    expect(context.currentChannelId).toBe("telegram:chat123");
    expect(context.currentThreadTs).toBe("42");
    expect(context.currentConversationOrigin).toBe("caller-token");
  });

  it("stamps server-session and reserves conversation headers for attach grants", () => {
    const context = resolveMcpRequestContext(
      fakeRequest({
        "x-openclaw-current-channel-id": "telegram:spoofed",
        "x-openclaw-current-thread-ts": "spoofed-thread",
      }),
      cfg,
      {
        senderIsOwner: false,
        boundSessionKey: "global",
        boundAgentId: "ops",
      } satisfies McpLoopbackRequestAuthLike,
    );
    expect(context.currentChannelId).toBeUndefined();
    expect(context.currentThreadTs).toBeUndefined();
    expect(context.currentConversationOrigin).toBe("server-session");
  });

  it("stamps run-bound-grant for immutable CLI grants and ignores spoofed headers", () => {
    const boundContext = {
      sessionKey: "agent:main:discord:channel:bound",
      senderIsOwner: false,
      currentChannelId: "discord:bound",
      currentThreadTs: "bound-thread",
    } as McpLoopbackRequestContext;
    const context = resolveMcpRequestContext(
      fakeRequest({
        "x-openclaw-current-channel-id": "telegram:spoofed",
        "x-openclaw-current-thread-ts": "spoofed-thread",
      }),
      cfg,
      {
        senderIsOwner: false,
        boundClientGrant: { context: boundContext },
      } as unknown as McpLoopbackRequestAuthLike,
    );
    expect(context.currentChannelId).toBe("discord:bound");
    expect(context.currentThreadTs).toBe("bound-thread");
    expect(context.currentConversationOrigin).toBe("run-bound-grant");
  });
});
