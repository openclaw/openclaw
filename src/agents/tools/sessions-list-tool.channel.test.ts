import { describe, expect, it } from "vitest";
import type { callGateway as gatewayCall } from "../../gateway/call.js";
import { createSessionChannelReadFixture } from "./sessions-channel-read-result.test-support.js";
import { createSessionsListTool } from "./sessions-list-tool.js";

describe("sessions_list channel visibility", () => {
  it.each([true, "all"] as const)(
    "preserves explicit archived=%s same-channel metadata inventory",
    async (archived) => {
      const requester = "agent:main:slack:channel:c111:thread:0.101";
      const sibling = "agent:main:slack:channel:c111:thread:0.102";
      const row = (key: string, isArchived: boolean) => ({
        key,
        sessionId: key,
        agentId: "main",
        chatType: "channel" as const,
        space: "t111",
        archived: isArchived,
        archivedAt: isArchived ? 20 : undefined,
        origin: { provider: "slack", chatType: "channel" },
        deliveryContext: { channel: "slack", accountId: "default", to: "channel:c111" },
      });
      const requesterRow = row(requester, false);
      const archivedRow = row(sibling, true);
      const inventory = archived === "all" ? [requesterRow, archivedRow] : [archivedRow];
      const owner = createSessionChannelReadFixture([requesterRow, archivedRow]);
      const tool = createSessionsListTool({
        agentSessionKey: requester,
        config: { tools: { sessions: { visibility: "channel" } } },
        callGateway: async <T = Record<string, unknown>>(
          request: Parameters<typeof gatewayCall>[0],
        ): Promise<T> => {
          if (request.method === "sessions.describe") {
            return {
              session: [requesterRow, archivedRow].find(
                (candidate) => candidate.key === (request.params as { key: string }).key,
              ),
            } as T;
          }
          expect(request.method).toBe("sessions.list");
          expect(request.params).toMatchObject({ archived });
          return { sessions: inventory, hasMore: false } as T;
        },
      });

      const result = await owner.run(() => tool.execute("channel-list-archived", { archived }));

      expect(result.details).toMatchObject({
        count: inventory.length,
        sessions: inventory.map(({ key, archived: state }) => ({ key, archived: state })),
      });
      expect(JSON.stringify(result.details)).not.toContain("archivedAt");
    },
  );

  it.each([false, true])(
    "requires a live disclosure owner only for cross-session channel rows (%s)",
    async (includeSibling) => {
      const requester = "agent:main:slack:channel:c111:thread:0.001";
      const sibling = "agent:main:slack:channel:c111:thread:0.002";
      const rows = [requester, ...(includeSibling ? [sibling] : [])].map((key) => ({
        key,
        sessionId: key,
        agentId: "main",
        chatType: "channel",
        space: "t111",
        origin: { provider: "slack", chatType: "channel" },
        deliveryContext: { channel: "slack", accountId: "default", to: "channel:c111" },
      }));
      const tool = createSessionsListTool({
        agentSessionKey: requester,
        config: { tools: { sessions: { visibility: "channel" } } },
        callGateway: async <T = Record<string, unknown>>(
          request: Parameters<typeof gatewayCall>[0],
        ): Promise<T> => {
          if (request.method === "sessions.describe") {
            return {
              session: rows.find((row) => row.key === (request.params as { key: string }).key),
            } as T;
          }
          return { sessions: rows, hasMore: false } as T;
        },
      });
      const result = tool.execute("channel-list-missing-owner", {});
      if (includeSibling) {
        await expect(result).rejects.toThrow(
          "Cross-session channel retrieval requires the local Gateway read owner",
        );
      } else {
        expect((await result).details).toMatchObject({
          count: 1,
          sessions: [expect.objectContaining({ key: requester })],
        });
      }
    },
  );

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
      chatType: "channel" as const,
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
    const owner = createSessionChannelReadFixture(rows);
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
    const result = await owner.run(() => tool.execute("channel-list", {}));
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
    const owner = createSessionChannelReadFixture([requesterRow, siblingRow]);
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
            if (siblingDescriptions > 1) {
              owner.setRow(row(sibling, "channel:c222", "SIBLING SECRET"));
            }
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

    const result = await owner.run(() =>
      tool.execute("channel-list-revalidation", { messageLimit: 1 }),
    );

    expect(result.details).toMatchObject({
      count: 1,
      sessions: [expect.objectContaining({ key: requester })],
    });
    expect(JSON.stringify(result.details)).not.toContain("SIBLING SECRET");
    expect(JSON.stringify(result.details)).not.toContain("SIBLING TRANSCRIPT SECRET");
    expect(siblingDescriptions).toBe(2);
    expect(historyCalls).toBe(1);
  });

  it("checks channel routes after the final owner preparation await", async () => {
    const requester = "agent:main:slack:channel:c111:thread:3.001";
    const sibling = "agent:main:slack:channel:c111:thread:3.002";
    const row = (key: string, to = "channel:c111") => ({
      key,
      sessionId: key,
      agentId: "main",
      chatType: "channel" as const,
      space: "t111",
      label: key === sibling ? "LATE CHANNEL SECRET" : "requester",
      origin: { provider: "slack", chatType: "channel" },
      deliveryContext: { channel: "slack", accountId: "default", to },
    });
    const rows = [row(requester), row(sibling)];
    const owner = createSessionChannelReadFixture(rows);
    const prepare = owner.projection.withPreparedExactRows.bind(owner.projection);
    owner.projection.withPreparedExactRows = async (queries, consume, options) => {
      await Promise.resolve();
      // Metadata-only reassignment retains sessionId/lifecycle generation.
      owner.setRow(row(sibling, "channel:c222"));
      return prepare(queries, consume, options);
    };
    const tool = createSessionsListTool({
      agentSessionKey: requester,
      config: { tools: { sessions: { visibility: "channel" } } },
      callGateway: async <T = Record<string, unknown>>(
        request: Parameters<typeof gatewayCall>[0],
      ): Promise<T> => {
        if (request.method === "sessions.describe") {
          return {
            session: rows.find(
              (candidate) => candidate.key === (request.params as { key: string }).key,
            ),
          } as T;
        }
        return { sessions: rows, hasMore: false } as T;
      },
    });

    const result = await owner.run(() => tool.execute("channel-list-owner-preparation", {}));

    expect(result.details).toMatchObject({
      count: 1,
      sessions: [expect.objectContaining({ key: requester })],
    });
    expect(JSON.stringify(result.details)).not.toContain("LATE CHANNEL SECRET");
  });
});
