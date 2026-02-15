import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { readReaderHistory } from "./history.js";

function createMockClient() {
  return {
    conversations: {
      history: vi.fn(async () => ({
        messages: [
          { ts: "1707900000.000000", text: "Hello world", user: "U001" },
          { ts: "1707900060.000000", text: "Hi there", user: "U002" },
        ],
        has_more: false,
      })),
      list: vi.fn(async () => ({
        channels: [{ id: "C001", name: "general", is_archived: false }],
        response_metadata: {},
      })),
    },
    users: {
      info: vi.fn(async (params: { user: string }) => {
        const users: Record<string, unknown> = {
          U001: {
            user: { id: "U001", profile: { display_name: "Alice", real_name: "Alice Smith" } },
          },
          U002: { user: { id: "U002", profile: { display_name: "Bob", real_name: "Bob Jones" } } },
        };
        return (
          users[params.user] ?? { user: { id: params.user, profile: { display_name: "Unknown" } } }
        );
      }),
    },
  } as unknown as WebClient;
}

describe("readReaderHistory", () => {
  it("returns messages with resolved author names", async () => {
    const client = createMockClient();
    const result = await readReaderHistory(client, {
      channel: "#general",
      count: 10,
    });

    expect(result).toHaveLength(2);
    expect(result[0].author).toBe("Alice");
    expect(result[0].authorId).toBe("U001");
    expect(result[0].text).toBe("Hello world");
    expect(result[0].ts).toBe("1707900000.000000");
  });

  it("resolves channel by ID", async () => {
    const client = createMockClient();
    const result = await readReaderHistory(client, {
      channel: "C001",
      count: 5,
    });

    expect(result).toHaveLength(2);
  });

  it("filters messages by since timestamp", async () => {
    const client = createMockClient();
    await readReaderHistory(client, {
      channel: "#general",
      count: 20,
      since: "2026-02-14T00:00:00Z",
    });

    const historyCall = (client.conversations.history as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(historyCall.oldest).toBeDefined();
  });

  it("clamps count to maximum of 100", async () => {
    const client = createMockClient();
    await readReaderHistory(client, {
      channel: "#general",
      count: 500,
    });

    const historyCall = (client.conversations.history as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(historyCall.limit).toBeLessThanOrEqual(100);
  });

  it("uses default count of 20 when not specified", async () => {
    const client = createMockClient();
    await readReaderHistory(client, {
      channel: "#general",
    });

    const historyCall = (client.conversations.history as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(historyCall.limit).toBe(20);
  });
});
