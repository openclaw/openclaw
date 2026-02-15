import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { summarizeReaderChannel } from "./summarize.js";

function createMockClient() {
  return {
    conversations: {
      history: vi.fn(async () => ({
        messages: [
          { ts: "1707900000.000000", text: "We decided to migrate to PostgreSQL", user: "U001" },
          { ts: "1707900060.000000", text: "Action item: update the CI pipeline", user: "U002" },
          { ts: "1707900120.000000", text: "Deployment scheduled for Friday", user: "U001" },
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

describe("summarizeReaderChannel", () => {
  it("returns formatted messages for summarization", async () => {
    const client = createMockClient();
    const result = await summarizeReaderChannel(client, {
      channel: "#engineering",
      period: "today",
    });

    expect(result.messages).toHaveLength(3);
    expect(result.formatted).toContain("Alice");
    expect(result.formatted).toContain("migrate to PostgreSQL");
  });

  it('returns "no messages" indicator when channel is quiet', async () => {
    const client = {
      conversations: {
        history: vi.fn(async () => ({ messages: [], has_more: false })),
        list: vi.fn(async () => ({
          channels: [{ id: "C001", name: "quiet", is_archived: false }],
          response_metadata: {},
        })),
      },
      users: {
        info: vi.fn(async () => ({ user: { profile: { display_name: "Unknown" } } })),
      },
    } as unknown as WebClient;

    const result = await summarizeReaderChannel(client, {
      channel: "#quiet",
      period: "today",
    });

    expect(result.messages).toHaveLength(0);
    expect(result.empty).toBe(true);
  });

  it('calculates correct time bounds for "today"', async () => {
    const client = createMockClient();
    await summarizeReaderChannel(client, {
      channel: "#engineering",
      period: "today",
    });

    const historyCall = (client.conversations.history as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(historyCall.oldest).toBeDefined();
    // "today" should have an oldest timestamp that is today's start
    const oldest = Number(historyCall.oldest);
    const now = Date.now() / 1000;
    // oldest should be within the last 24 hours
    expect(now - oldest).toBeLessThan(86400 + 60);
  });

  it('calculates correct time bounds for "this_week"', async () => {
    const client = createMockClient();
    await summarizeReaderChannel(client, {
      channel: "#engineering",
      period: "this_week",
    });

    const historyCall = (client.conversations.history as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(historyCall.oldest).toBeDefined();
    const oldest = Number(historyCall.oldest);
    const now = Date.now() / 1000;
    // this_week should be within the last 7 days
    expect(now - oldest).toBeLessThan(7 * 86400 + 60);
  });

  it("includes author names in formatted output", async () => {
    const client = createMockClient();
    const result = await summarizeReaderChannel(client, {
      channel: "#engineering",
      period: "today",
    });

    expect(result.formatted).toContain("Alice");
    expect(result.formatted).toContain("Bob");
  });
});
