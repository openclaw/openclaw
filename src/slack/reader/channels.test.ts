import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { listReaderChannels } from "./channels.js";

function createMockClient() {
  return {
    conversations: {
      list: vi.fn(async () => ({
        channels: [
          {
            id: "C001",
            name: "general",
            topic: { value: "General discussion" },
            num_members: 42,
            is_archived: false,
          },
          {
            id: "C002",
            name: "engineering",
            topic: { value: "Engineering talk" },
            num_members: 15,
            is_archived: false,
          },
        ],
        response_metadata: {},
      })),
    },
  } as unknown as WebClient;
}

describe("listReaderChannels", () => {
  it("returns channels with id, name, topic, and memberCount", async () => {
    const client = createMockClient();
    const result = await listReaderChannels(client);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: "C001",
      name: "general",
      topic: "General discussion",
      memberCount: 42,
    });
    expect(result[1]).toEqual({
      id: "C002",
      name: "engineering",
      topic: "Engineering talk",
      memberCount: 15,
    });
  });

  it("returns empty array when no channels exist", async () => {
    const client = {
      conversations: {
        list: vi.fn(async () => ({ channels: [], response_metadata: {} })),
      },
    } as unknown as WebClient;

    const result = await listReaderChannels(client);
    expect(result).toEqual([]);
  });

  it("handles missing topic gracefully", async () => {
    const client = {
      conversations: {
        list: vi.fn(async () => ({
          channels: [{ id: "C001", name: "no-topic", num_members: 5, is_archived: false }],
          response_metadata: {},
        })),
      },
    } as unknown as WebClient;

    const result = await listReaderChannels(client);
    expect(result[0].topic).toBe("");
  });
});
