import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { resolveMcpRequestContext } from "./mcp-http.request.js";

function requestWithConversationHeaders() {
  const request = new IncomingMessage(new Socket());
  request.headers = {
    "x-openclaw-current-channel-id": "room:caller-selected",
    "x-openclaw-current-thread-ts": "caller-thread",
  };
  return request;
}

describe("MCP current-conversation provenance", () => {
  it("marks generic bearer conversation headers as caller-controlled", () => {
    expect(
      resolveMcpRequestContext(requestWithConversationHeaders(), {}, { senderIsOwner: true }),
    ).toMatchObject({
      currentChannelId: "room:caller-selected",
      currentThreadTs: "caller-thread",
      currentConversationOrigin: "caller-token",
    });
  });

  it("reserves conversation headers for session-bound attach grants", () => {
    expect(
      resolveMcpRequestContext(
        requestWithConversationHeaders(),
        {},
        {
          senderIsOwner: false,
          boundSessionKey: "global",
          boundAgentId: "ops",
        },
      ),
    ).toMatchObject({
      currentChannelId: undefined,
      currentThreadTs: undefined,
      currentConversationOrigin: "server-session",
    });
  });

  it("takes run-bound conversation facts from the host grant, ignoring headers", () => {
    expect(
      resolveMcpRequestContext(
        requestWithConversationHeaders(),
        {},
        {
          senderIsOwner: false,
          boundClientGrant: {
            context: {
              sessionKey: "agent:main:discord:channel:bound",
              senderIsOwner: false,
              currentChannelId: "channel:bound",
              currentThreadTs: "bound-thread",
            },
            captureKey: "capture-test",
            admittedRunContext: {
              operationalRunInstance: { instanceId: "instance-test", runId: "run-test" },
            },
            isCurrent: () => true,
          },
        },
      ),
    ).toMatchObject({
      currentChannelId: "channel:bound",
      currentThreadTs: "bound-thread",
      currentConversationOrigin: "run-bound-grant",
    });
  });
});
