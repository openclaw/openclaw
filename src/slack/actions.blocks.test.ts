import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({}),
}));

vi.mock("./accounts.js", () => ({
  resolveSlackAccount: () => ({
    accountId: "default",
    botToken: "xoxb-test",
    botTokenSource: "config",
    config: {},
  }),
}));

const { editSlackMessage } = await import("./actions.js");

function createClient() {
  return {
    chat: {
      update: vi.fn(async () => ({ ok: true })),
    },
  } as unknown as WebClient & {
    chat: {
      update: ReturnType<typeof vi.fn>;
    };
  };
}

describe("editSlackMessage blocks", () => {
  it("updates with valid blocks", async () => {
    const client = createClient();

    await editSlackMessage("C123", "171234.567", "", {
      token: "xoxb-test",
      client,
      blocks: [{ type: "divider" }],
    });

    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        ts: "171234.567",
        text: "Shared a Block Kit message",
        blocks: [{ type: "divider" }],
      }),
    );
  });

  it("uses image block text as edit fallback", async () => {
    const client = createClient();

    await editSlackMessage("C123", "171234.567", "", {
      token: "xoxb-test",
      client,
      blocks: [{ type: "image", image_url: "https://example.com/a.png", alt_text: "Chart" }],
    });

    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Chart",
      }),
    );
  });

  it("uses video block title as edit fallback", async () => {
    const client = createClient();

    await editSlackMessage("C123", "171234.567", "", {
      token: "xoxb-test",
      client,
      blocks: [
        {
          type: "video",
          title: { type: "plain_text", text: "Walkthrough" },
          video_url: "https://example.com/demo.mp4",
          thumbnail_url: "https://example.com/thumb.jpg",
          alt_text: "demo",
        },
      ],
    });

    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Walkthrough",
      }),
    );
  });

  it("uses generic file fallback text for file blocks", async () => {
    const client = createClient();

    await editSlackMessage("C123", "171234.567", "", {
      token: "xoxb-test",
      client,
      blocks: [{ type: "file", source: "remote", external_id: "F123" }],
    });

    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Shared a file",
      }),
    );
  });

  it("rejects empty blocks arrays", async () => {
    const client = createClient();

    await expect(
      editSlackMessage("C123", "171234.567", "updated", {
        token: "xoxb-test",
        client,
        blocks: [],
      }),
    ).rejects.toThrow(/must contain at least one block/i);

    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it("rejects blocks missing a type", async () => {
    const client = createClient();

    await expect(
      editSlackMessage("C123", "171234.567", "updated", {
        token: "xoxb-test",
        client,
        blocks: [{} as { type: string }],
      }),
    ).rejects.toThrow(/non-empty string type/i);

    expect(client.chat.update).not.toHaveBeenCalled();
  });
});
