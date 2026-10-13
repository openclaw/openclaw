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
          const key = (request.params as { key?: string }).key;
          return { session: rows.find((candidate) => candidate.key === key) ?? null } as T;
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

  it("drops a sibling whose channel route changes before result emission", async () => {
    const requester = "agent:main:slack:channel:c111:thread:2.001";
    const sibling = "agent:main:slack:channel:c111:thread:2.002";
    const row = (key: string, to: string, label: string) => ({
      key,
      sessionId: key,
      agentId: "main",
      classification: "thread" as const,
      peerKind: "channel" as const,
      chatType: "channel" as const,
      space: "t111",
      label,
      origin: { provider: "slack", chatType: "channel" },
      deliveryContext: { channel: "slack", accountId: "default", to },
    });
    const requesterRow = row(requester, "channel:c111", "requester");
    const siblingRow = row(sibling, "channel:c111", "SIBLING SECRET");
    let siblingDescriptions = 0;
    let historyCalls = 0;
    const tool = createSessionsListTool({
      agentSessionKey: requester,
      config: { tools: { sessions: { visibility: "channel" } } },
      callGateway: async <T = Record<string, unknown>>(
        request: Parameters<typeof gatewayCall>[0],
      ): Promise<T> => {
        if (request.method === "sessions.describe") {
          const key = (request.params as { key?: string }).key;
          if (key === sibling) {
            siblingDescriptions += 1;
            return {
              session:
                siblingDescriptions === 1
                  ? siblingRow
                  : row(sibling, "channel:c222", "SIBLING SECRET"),
            } as T;
          }
          return { session: key === requester ? requesterRow : null } as T;
        }
        if (request.method === "chat.history") {
          historyCalls += 1;
          const key = (request.params as { sessionKey?: string }).sessionKey;
          return {
            messages: [
              {
                role: "user",
                content: key === sibling ? "SIBLING TRANSCRIPT SECRET" : "requester message",
              },
            ],
          } as T;
        }
        return { sessions: [requesterRow, siblingRow], hasMore: false } as T;
      },
    });

    const result = await tool.execute("channel-list-revalidation", { messageLimit: 1 });

    expect(result.details).toMatchObject({
      count: 1,
      sessions: [expect.objectContaining({ key: requester })],
    });
    expect(JSON.stringify(result.details)).not.toContain("SIBLING SECRET");
    expect(JSON.stringify(result.details)).not.toContain("SIBLING TRANSCRIPT SECRET");
    expect(siblingDescriptions).toBe(2);
    expect(historyCalls).toBe(1);
  });
});
