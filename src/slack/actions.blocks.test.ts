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
        text: " ",
        blocks: [{ type: "divider" }],
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
