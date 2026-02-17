import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createSlackActions } from "./slack.actions.js";

const handleSlackAction = vi.fn(async () => ({ details: { ok: true } }));

vi.mock("../../agents/tools/slack-actions.js", () => ({
  handleSlackAction: (...args: unknown[]) => handleSlackAction(...args),
}));

describe("slack actions adapter", () => {
  beforeEach(() => {
    handleSlackAction.mockClear();
  });

  it("forwards threadId for read", async () => {
    const cfg = { channels: { slack: { botToken: "tok" } } } as OpenClawConfig;
    const actions = createSlackActions("slack");

    await actions.handleAction?.({
      channel: "slack",
      action: "read",
      cfg,
      params: {
        channelId: "C1",
        threadId: "171234.567",
      },
    });

    const [params] = handleSlackAction.mock.calls[0] ?? [];
    expect(params).toMatchObject({
      action: "readMessages",
      channelId: "C1",
      threadId: "171234.567",
    });
  });

  it("forwards normalized limit for emoji-list", async () => {
    const cfg = { channels: { slack: { botToken: "tok" } } } as OpenClawConfig;
    const actions = createSlackActions("slack");

    await actions.handleAction?.({
      channel: "slack",
      action: "emoji-list",
      cfg,
      params: {
        limit: "2.9",
      },
    });

    const [params] = handleSlackAction.mock.calls[0] ?? [];
    expect(params).toMatchObject({
      action: "emojiList",
      limit: 2,
    });
  });
});
