import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { readReaderThread } from "./thread.js";

function createMockClient() {
  return {
    conversations: {
      replies: vi.fn(async () => ({
        messages: [
          { ts: "1707900000.000000", text: "Thread parent", user: "U001" },
          {
            ts: "1707900060.000000",
            text: "First reply",
            user: "U002",
            thread_ts: "1707900000.000000",
          },
          {
            ts: "1707900120.000000",
            text: "Second reply",
            user: "U001",
            thread_ts: "1707900000.000000",
          },
        ],
        has_more: false,
      })),
      list: vi.fn(async () => ({
        channels: [{ id: "C001", name: "engineering", is_archived: false }],
        response_metadata: {},
      })),
    },
    users: {
      info: vi.fn(async (params: { user: string }) => {
        const users: Record<string, unknown> = {
          U001: { user: { id: "U001", profile: { display_name: "Alice" } } },
          U002: { user: { id: "U002", profile: { display_name: "Bob" } } },
        };
        return (
          users[params.user] ?? { user: { id: params.user, profile: { display_name: "Unknown" } } }
        );
      }),
    },
  } as unknown as WebClient;
}

describe("readReaderThread", () => {
  it("returns full thread with parent and all replies", async () => {
    const client = createMockClient();
    const result = await readReaderThread(client, {
      channel: "#engineering",
      threadTs: "1707900000.000000",
    });

    expect(result).toHaveLength(3);
    expect(result[0].text).toBe("Thread parent");
    expect(result[1].text).toBe("First reply");
    expect(result[2].text).toBe("Second reply");
  });

  it("resolves author names for thread messages", async () => {
    const client = createMockClient();
    const result = await readReaderThread(client, {
      channel: "#engineering",
      threadTs: "1707900000.000000",
    });

    expect(result[0].author).toBe("Alice");
    expect(result[1].author).toBe("Bob");
    expect(result[2].author).toBe("Alice");
  });

  it("passes correct channel and threadTs to Slack API", async () => {
    const client = createMockClient();
    await readReaderThread(client, {
      channel: "C001",
      threadTs: "1707900000.000000",
    });

    const repliesCall = (client.conversations.replies as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(repliesCall.channel).toBe("C001");
    expect(repliesCall.ts).toBe("1707900000.000000");
  });

  it("returns empty array for thread with no replies", async () => {
    const client = {
      conversations: {
        replies: vi.fn(async () => ({
          messages: [],
          has_more: false,
        })),
        list: vi.fn(async () => ({
          channels: [{ id: "C001", name: "engineering", is_archived: false }],
          response_metadata: {},
        })),
      },
      users: {
        info: vi.fn(async () => ({ user: { profile: { display_name: "Unknown" } } })),
      },
    } as unknown as WebClient;

    const result = await readReaderThread(client, {
      channel: "#engineering",
      threadTs: "1707900000.000000",
    });

    expect(result).toEqual([]);
  });
});
