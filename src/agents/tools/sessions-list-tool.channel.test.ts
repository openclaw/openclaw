import { describe, expect, it } from "vitest";
import type { callGateway as gatewayCall } from "../../gateway/call.js";
import { createSessionsListTool } from "./sessions-list-tool.js";

describe("sessions_list channel visibility", () => {
  it("lists same-channel siblings without exposing other-channel metadata", async () => {
    const requester = "agent:main:slack:channel:c111:thread:1.001";
    const sibling = "agent:main:slack:channel:c111:thread:1.002";
    const other = "agent:main:slack:channel:c222:thread:1.003";
    const row = (key: string, to: string) => ({
      key,
      sessionId: key,
      agentId: "main",
      classification: "thread",
      peerKind: "channel",
      chatType: "channel",
      space: "t111",
      label: key === other ? "OTHER CUSTOMER SECRET" : "same channel",
      origin: { provider: "slack", chatType: "channel" },
      deliveryContext: { channel: "slack", accountId: "default", to },
    });
    const rows = [
      row(requester, "channel:c111"),
      row(sibling, "channel:c111"),
      row(other, "channel:c222"),
    ];
    const tool = createSessionsListTool({
      agentSessionKey: requester,
      config: { tools: { sessions: { visibility: "channel" } } },
      callGateway: async <T = Record<string, unknown>>(
        request: Parameters<typeof gatewayCall>[0],
      ): Promise<T> => {
        if (request.method === "sessions.describe") {
          return { session: rows[0] } as T;
        }
        return { sessions: rows, hasMore: false } as T;
      },
    });
    const result = await tool.execute("channel-list", {});
    expect(result.details).toMatchObject({
      count: 2,
      visibility: { mode: "channel" },
      sessions: [
        expect.objectContaining({ key: requester }),
        expect.objectContaining({ key: sibling }),
      ],
    });
    expect(JSON.stringify(result.details)).not.toContain("OTHER CUSTOMER SECRET");
  });
});
