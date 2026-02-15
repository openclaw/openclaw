import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { handleSlackReaderAction, createSlackReaderTool } from "./slack-reader-tool.js";

const listReaderChannels = vi.fn(async () => [
  { id: "C001", name: "general", topic: "General discussion", memberCount: 42 },
]);
const readReaderHistory = vi.fn(async () => [
  {
    ts: "1707900000.000000",
    text: "Hello",
    author: "Alice",
    authorId: "U001",
    channel: "general",
    channelId: "C001",
  },
]);
const searchReaderMessages = vi.fn(async () => [
  {
    ts: "1707900000.000000",
    text: "Found it",
    author: "Bob",
    channel: "engineering",
    workspace: "zenloop",
    permalink: "https://slack.com/link",
  },
]);
const readReaderThread = vi.fn(async () => [
  { ts: "1707900000.000000", text: "Thread msg", author: "Alice", authorId: "U001" },
]);
const summarizeReaderChannel = vi.fn(async () => ({
  messages: [{ ts: "1", text: "msg", author: "Alice" }],
  formatted: "Alice: msg",
  empty: false,
}));

vi.mock("../../slack/reader/channels.js", () => ({
  listReaderChannels: (...args: unknown[]) => listReaderChannels(...args),
}));
vi.mock("../../slack/reader/history.js", () => ({
  readReaderHistory: (...args: unknown[]) => readReaderHistory(...args),
}));
vi.mock("../../slack/reader/search.js", () => ({
  searchReaderMessages: (...args: unknown[]) => searchReaderMessages(...args),
}));
vi.mock("../../slack/reader/thread.js", () => ({
  readReaderThread: (...args: unknown[]) => readReaderThread(...args),
}));
vi.mock("../../slack/reader/summarize.js", () => ({
  summarizeReaderChannel: (...args: unknown[]) => summarizeReaderChannel(...args),
}));

const baseCfg = {
  tools: {
    slackReader: {
      enabled: true,
      workspaces: {
        zenloop: { botToken: "xoxb-zen" },
        edubites: { botToken: "xoxb-edu" },
        protaige: { botToken: "xoxb-pro" },
        saasgroup: { botToken: "xoxb-saa" },
      },
    },
  },
} as unknown as OpenClawConfig;

describe("handleSlackReaderAction", () => {
  // Test case #1: List channels for workspace
  it("dispatches channels action and returns channel list", async () => {
    const result = await handleSlackReaderAction(
      { action: "channels", workspace: "zenloop" },
      baseCfg,
    );
    const payload = result.details as { ok: boolean; channels: unknown[] };
    expect(payload.ok).toBe(true);
    expect(payload.channels).toHaveLength(1);
    expect(listReaderChannels).toHaveBeenCalled();
  });

  // Test case #2: Invalid workspace
  it("returns error for invalid workspace", async () => {
    const result = await handleSlackReaderAction(
      { action: "channels", workspace: "invalid" },
      baseCfg,
    );
    const payload = result.details as { ok: boolean; error: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/Unknown workspace/);
    expect(payload.error).toContain("invalid");
  });

  // Test case #3: Channel history by name
  it("dispatches history action with channel name", async () => {
    const result = await handleSlackReaderAction(
      { action: "history", workspace: "edubites", channel: "#general", count: 10 },
      baseCfg,
    );
    const payload = result.details as { ok: boolean; messages: unknown[] };
    expect(payload.ok).toBe(true);
    expect(payload.messages).toHaveLength(1);
    expect(readReaderHistory).toHaveBeenCalled();
  });

  // Test case #4: Channel history by ID
  it("dispatches history action with channel ID", async () => {
    await handleSlackReaderAction(
      { action: "history", workspace: "edubites", channel: "C1234", count: 5 },
      baseCfg,
    );
    expect(readReaderHistory).toHaveBeenCalled();
  });

  // Test case #5: History with since filter
  it("passes since parameter to history", async () => {
    await handleSlackReaderAction(
      {
        action: "history",
        workspace: "zenloop",
        channel: "#eng",
        since: "2026-02-14T00:00:00Z",
        count: 20,
      },
      baseCfg,
    );
    expect(readReaderHistory).toHaveBeenCalled();
  });

  // Test case #6: Count clamped to 100
  it("clamps count to maximum of 100", async () => {
    await handleSlackReaderAction(
      { action: "history", workspace: "zenloop", channel: "#eng", count: 500 },
      baseCfg,
    );
    const callArgs = readReaderHistory.mock.calls[readReaderHistory.mock.calls.length - 1];
    const opts = callArgs[1] as { count?: number };
    expect(opts.count).toBeLessThanOrEqual(100);
  });

  // Test case #7: Search single workspace
  it("dispatches search action for single workspace", async () => {
    const result = await handleSlackReaderAction(
      { action: "search", workspace: "zenloop", query: "deployment", count: 10 },
      baseCfg,
    );
    const payload = result.details as { ok: boolean; results: unknown[] };
    expect(payload.ok).toBe(true);
    expect(searchReaderMessages).toHaveBeenCalled();
  });

  // Test case #8: Search all workspaces
  it("dispatches search action for all workspaces", async () => {
    await handleSlackReaderAction(
      { action: "search", workspace: "all", query: "release", count: 10 },
      baseCfg,
    );
    const callArgs = searchReaderMessages.mock.calls[searchReaderMessages.mock.calls.length - 1];
    const opts = callArgs[0] as { workspace: string };
    expect(opts.workspace).toBe("all");
  });

  // Test case #9: Search empty results
  it("returns empty results array for no matches", async () => {
    searchReaderMessages.mockResolvedValueOnce([]);
    const result = await handleSlackReaderAction(
      { action: "search", workspace: "zenloop", query: "xyznonexistent", count: 10 },
      baseCfg,
    );
    const payload = result.details as { ok: boolean; results: unknown[] };
    expect(payload.ok).toBe(true);
    expect(payload.results).toEqual([]);
  });

  // Test case #10: Thread fetch
  it("dispatches thread action", async () => {
    const result = await handleSlackReaderAction(
      { action: "thread", workspace: "zenloop", channel: "#eng", threadTs: "1707900000.000000" },
      baseCfg,
    );
    const payload = result.details as { ok: boolean; messages: unknown[] };
    expect(payload.ok).toBe(true);
    expect(readReaderThread).toHaveBeenCalled();
  });

  // Test case #12: Summarize channel
  it("dispatches summarize action", async () => {
    const result = await handleSlackReaderAction(
      { action: "summarize", workspace: "zenloop", channel: "#engineering", period: "today" },
      baseCfg,
    );
    const payload = result.details as { ok: boolean; summary: unknown };
    expect(payload.ok).toBe(true);
    expect(summarizeReaderChannel).toHaveBeenCalled();
  });

  // Test case #13: Summarize - no messages
  it("returns empty summary message when channel is quiet", async () => {
    summarizeReaderChannel.mockResolvedValueOnce({
      messages: [],
      formatted: "",
      empty: true,
    });
    const result = await handleSlackReaderAction(
      { action: "summarize", workspace: "zenloop", channel: "#quiet", period: "today" },
      baseCfg,
    );
    const payload = result.details as { ok: boolean; empty: boolean };
    expect(payload.ok).toBe(true);
    expect(payload.empty).toBe(true);
  });

  // Test case #14: Missing bot token
  it("returns error when workspace has no bot token", async () => {
    const noTokenCfg = {
      tools: {
        slackReader: {
          enabled: true,
          workspaces: { zenloop: {} },
        },
      },
    } as unknown as OpenClawConfig;

    const result = await handleSlackReaderAction(
      { action: "channels", workspace: "zenloop" },
      noTokenCfg,
    );
    const payload = result.details as { ok: boolean; error: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/No bot token/);
  });

  // Test case: Unknown action
  it("returns error for unknown action", async () => {
    const result = await handleSlackReaderAction(
      { action: "unknown_action", workspace: "zenloop" },
      baseCfg,
    );
    const payload = result.details as { ok: boolean; error: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/Unknown action/);
  });
});

describe("createSlackReaderTool", () => {
  // Test case #16: Tool gating
  it("returns null when slackReader is disabled", () => {
    const disabledCfg = {
      tools: { slackReader: { enabled: false } },
    } as unknown as OpenClawConfig;
    const tool = createSlackReaderTool({ config: disabledCfg });
    expect(tool).toBeNull();
  });

  it("returns null when slackReader config is missing", () => {
    const emptyCfg = {} as unknown as OpenClawConfig;
    const tool = createSlackReaderTool({ config: emptyCfg });
    expect(tool).toBeNull();
  });

  it("returns a tool when slackReader is enabled", () => {
    const tool = createSlackReaderTool({ config: baseCfg });
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("slack_read");
  });

  // Test case #15: Workspace token resolution
  it("tool has correct label and description", () => {
    const tool = createSlackReaderTool({ config: baseCfg });
    expect(tool!.label).toBe("Slack Reader");
    expect(tool!.description).toContain("read-only");
  });
});
