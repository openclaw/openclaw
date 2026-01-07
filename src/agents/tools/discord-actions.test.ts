import { describe, expect, it, vi } from "vitest";

import type { DiscordActionConfig } from "../../config/config.js";
import { handleDiscordMessagingAction } from "./discord-actions-messaging.js";

const createThreadDiscord = vi.fn(async () => ({}));
const deleteMessageDiscord = vi.fn(async () => ({}));
const editMessageDiscord = vi.fn(async () => ({}));
const fetchChannelPermissionsDiscord = vi.fn(async () => ({}));
const fetchReactionsDiscord = vi.fn(async () => ({}));
const listPinsDiscord = vi.fn(async () => ({}));
const listThreadsDiscord = vi.fn(async () => ({}));
const pinMessageDiscord = vi.fn(async () => ({}));
const reactMessageDiscord = vi.fn(async () => ({}));
const readMessagesDiscord = vi.fn(async () => []);
const removeOwnReactionsDiscord = vi.fn(async () => ({ removed: ["👍"] }));
const removeReactionDiscord = vi.fn(async () => ({}));
const searchMessagesDiscord = vi.fn(async () => ({}));
const sendMessageDiscord = vi.fn(async () => ({}));
const sendPollDiscord = vi.fn(async () => ({}));
const sendStickerDiscord = vi.fn(async () => ({}));
const unpinMessageDiscord = vi.fn(async () => ({}));

vi.mock("../../discord/send.js", () => ({
  createThreadDiscord: (...args: unknown[]) => createThreadDiscord(...args),
  deleteMessageDiscord: (...args: unknown[]) => deleteMessageDiscord(...args),
  editMessageDiscord: (...args: unknown[]) => editMessageDiscord(...args),
  fetchChannelPermissionsDiscord: (...args: unknown[]) =>
    fetchChannelPermissionsDiscord(...args),
  fetchReactionsDiscord: (...args: unknown[]) => fetchReactionsDiscord(...args),
  listPinsDiscord: (...args: unknown[]) => listPinsDiscord(...args),
  listThreadsDiscord: (...args: unknown[]) => listThreadsDiscord(...args),
  pinMessageDiscord: (...args: unknown[]) => pinMessageDiscord(...args),
  reactMessageDiscord: (...args: unknown[]) => reactMessageDiscord(...args),
  readMessagesDiscord: (...args: unknown[]) => readMessagesDiscord(...args),
  removeOwnReactionsDiscord: (...args: unknown[]) =>
    removeOwnReactionsDiscord(...args),
  removeReactionDiscord: (...args: unknown[]) => removeReactionDiscord(...args),
  searchMessagesDiscord: (...args: unknown[]) => searchMessagesDiscord(...args),
  sendMessageDiscord: (...args: unknown[]) => sendMessageDiscord(...args),
  sendPollDiscord: (...args: unknown[]) => sendPollDiscord(...args),
  sendStickerDiscord: (...args: unknown[]) => sendStickerDiscord(...args),
  unpinMessageDiscord: (...args: unknown[]) => unpinMessageDiscord(...args),
}));

const enableAllActions = () => true;

const disabledActions = (key: keyof DiscordActionConfig) => key !== "reactions";

describe("handleDiscordMessagingAction", () => {
  it("adds reactions", async () => {
    await handleDiscordMessagingAction(
      "react",
      {
        channelId: "C1",
        messageId: "M1",
        emoji: "✅",
      },
      enableAllActions,
    );
    expect(reactMessageDiscord).toHaveBeenCalledWith("C1", "M1", "✅");
  });

  it("removes reactions on empty emoji", async () => {
    await handleDiscordMessagingAction(
      "react",
      {
        channelId: "C1",
        messageId: "M1",
        emoji: "",
      },
      enableAllActions,
    );
    expect(removeOwnReactionsDiscord).toHaveBeenCalledWith("C1", "M1");
  });

  it("removes reactions when remove flag set", async () => {
    await handleDiscordMessagingAction(
      "react",
      {
        channelId: "C1",
        messageId: "M1",
        emoji: "✅",
        remove: true,
      },
      enableAllActions,
    );
    expect(removeReactionDiscord).toHaveBeenCalledWith("C1", "M1", "✅");
  });

  it("rejects removes without emoji", async () => {
    await expect(
      handleDiscordMessagingAction(
        "react",
        {
          channelId: "C1",
          messageId: "M1",
          emoji: "",
          remove: true,
        },
        enableAllActions,
      ),
    ).rejects.toThrow(/Emoji is required/);
  });

  it("respects reaction gating", async () => {
    await expect(
      handleDiscordMessagingAction(
        "react",
        {
          channelId: "C1",
          messageId: "M1",
          emoji: "✅",
        },
        disabledActions,
      ),
    ).rejects.toThrow(/Discord reactions are disabled/);
  });
});
