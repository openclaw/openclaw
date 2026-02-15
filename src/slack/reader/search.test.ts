import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { searchReaderMessages } from "./search.js";

function createMockClient() {
  return {
    search: {
      messages: vi.fn(async () => ({
        messages: {
          matches: [
            {
              ts: "1707900000.000000",
              text: "We need to deploy the release",
              user: "U001",
              username: "alice",
              channel: { id: "C001", name: "engineering" },
              permalink: "https://slack.com/archives/C001/p1707900000000000",
            },
            {
              ts: "1707900120.000000",
              text: "Release notes are ready",
              user: "U002",
              username: "bob",
              channel: { id: "C002", name: "general" },
              permalink: "https://slack.com/archives/C002/p1707900120000000",
            },
          ],
          total: 2,
        },
      })),
    },
  } as unknown as WebClient;
}

describe("searchReaderMessages", () => {
  it("searches a single workspace and returns matching messages", async () => {
    const client = createMockClient();
    const result = await searchReaderMessages({
      clients: { zenloop: client },
      workspace: "zenloop",
      query: "release",
      count: 10,
    });

    expect(result).toHaveLength(2);
    expect(result[0].text).toContain("deploy the release");
    expect(result[0].channel).toBe("engineering");
    expect(result[0].permalink).toBeDefined();
  });

  it('searches all workspaces when workspace is "all"', async () => {
    const zenClient = createMockClient();
    const eduClient = createMockClient();
    const result = await searchReaderMessages({
      clients: { zenloop: zenClient, edubites: eduClient },
      workspace: "all",
      query: "release",
      count: 10,
    });

    // Should have results from both workspaces
    expect(result.length).toBeGreaterThanOrEqual(2);
    const workspaces = new Set(result.map((m) => m.workspace));
    expect(workspaces.size).toBeGreaterThanOrEqual(2);
  });

  it("tags results with workspace name in all-workspace search", async () => {
    const zenClient = createMockClient();
    const result = await searchReaderMessages({
      clients: { zenloop: zenClient },
      workspace: "all",
      query: "deployment",
      count: 10,
    });

    for (const msg of result) {
      expect(msg.workspace).toBeDefined();
    }
  });

  it("returns empty array when no matches found", async () => {
    const client = {
      search: {
        messages: vi.fn(async () => ({
          messages: { matches: [], total: 0 },
        })),
      },
    } as unknown as WebClient;

    const result = await searchReaderMessages({
      clients: { zenloop: client },
      workspace: "zenloop",
      query: "xyznonexistent",
      count: 10,
    });

    expect(result).toEqual([]);
  });
});
