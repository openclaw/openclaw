import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { signalMessageActions } from "./signal.js";

const sendReactionSignal = vi.fn(async () => ({ ok: true }));
const removeReactionSignal = vi.fn(async () => ({ ok: true }));
const sendRemoteDeleteSignal = vi.fn(async () => true);
const sendPollCreateSignal = vi.fn(async () => ({ messageId: "999", timestamp: 999 }));
const sendPollVoteSignal = vi.fn(async () => ({ messageId: "999", timestamp: 999 }));
const sendPollTerminateSignal = vi.fn(async () => ({ messageId: "999", timestamp: 999 }));

vi.mock("../../../signal/send-reactions.js", () => ({
  sendReactionSignal: (...args: unknown[]) => sendReactionSignal(...args),
  removeReactionSignal: (...args: unknown[]) => removeReactionSignal(...args),
}));

vi.mock("../../../signal/send.js", () => ({
  sendRemoteDeleteSignal: (...args: unknown[]) => sendRemoteDeleteSignal(...args),
  sendPollCreateSignal: (...args: unknown[]) => sendPollCreateSignal(...args),
  sendPollVoteSignal: (...args: unknown[]) => sendPollVoteSignal(...args),
  sendPollTerminateSignal: (...args: unknown[]) => sendPollTerminateSignal(...args),
}));

describe("signalMessageActions", () => {
  it("returns no actions when no configured accounts exist", () => {
    const cfg = {} as OpenClawConfig;
    expect(signalMessageActions.listActions({ cfg })).toEqual([]);
  });

  it("hides react when reactions are disabled", () => {
    const cfg = {
      channels: { signal: { account: "+15550001111", actions: { reactions: false } } },
    } as OpenClawConfig;
    expect(signalMessageActions.listActions({ cfg })).toEqual([
      "send",
      "unsend",
      "poll",
      "pollVote",
      "pollClose",
    ]);
  });

  it("enables react when at least one account allows reactions", () => {
    const cfg = {
      channels: {
        signal: {
          actions: { reactions: false },
          accounts: {
            work: { account: "+15550001111", actions: { reactions: true } },
          },
        },
      },
    } as OpenClawConfig;
    expect(signalMessageActions.listActions({ cfg })).toEqual([
      "send",
      "react",
      "unsend",
      "poll",
      "pollVote",
      "pollClose",
    ]);
  });

  it("skips send for plugin dispatch", () => {
    expect(signalMessageActions.supportsAction?.({ action: "send" })).toBe(false);
    expect(signalMessageActions.supportsAction?.({ action: "react" })).toBe(true);
  });

  it("blocks reactions when action gate is disabled", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111", actions: { reactions: false } } },
    } as OpenClawConfig;

    await expect(
      signalMessageActions.handleAction({
        action: "react",
        params: { to: "+15550001111", messageId: "123", emoji: "✅" },
        cfg,
        accountId: undefined,
      }),
    ).rejects.toThrow(/actions\.reactions/);
  });

  it("uses account-level actions when enabled", async () => {
    sendReactionSignal.mockClear();
    const cfg = {
      channels: {
        signal: {
          actions: { reactions: false },
          accounts: {
            work: { account: "+15550001111", actions: { reactions: true } },
          },
        },
      },
    } as OpenClawConfig;

    await signalMessageActions.handleAction({
      action: "react",
      params: { to: "+15550001111", messageId: "123", emoji: "👍" },
      cfg,
      accountId: "work",
    });

    expect(sendReactionSignal).toHaveBeenCalledWith("+15550001111", 123, "👍", {
      accountId: "work",
    });
  });

  it("normalizes uuid recipients", async () => {
    sendReactionSignal.mockClear();
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;

    await signalMessageActions.handleAction({
      action: "react",
      params: {
        recipient: "uuid:123e4567-e89b-12d3-a456-426614174000",
        messageId: "123",
        emoji: "🔥",
      },
      cfg,
      accountId: undefined,
    });

    expect(sendReactionSignal).toHaveBeenCalledWith(
      "123e4567-e89b-12d3-a456-426614174000",
      123,
      "🔥",
      { accountId: undefined },
    );
  });

  it("requires targetAuthor for group reactions", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;

    await expect(
      signalMessageActions.handleAction({
        action: "react",
        params: { to: "signal:group:group-id", messageId: "123", emoji: "✅" },
        cfg,
        accountId: undefined,
      }),
    ).rejects.toThrow(/targetAuthor/);
  });

  it("passes groupId and targetAuthor for group reactions", async () => {
    sendReactionSignal.mockClear();
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;

    await signalMessageActions.handleAction({
      action: "react",
      params: {
        to: "signal:group:group-id",
        targetAuthor: "uuid:123e4567-e89b-12d3-a456-426614174000",
        messageId: "123",
        emoji: "✅",
      },
      cfg,
      accountId: undefined,
    });

    expect(sendReactionSignal).toHaveBeenCalledWith("", 123, "✅", {
      accountId: undefined,
      groupId: "group-id",
      targetAuthor: "uuid:123e4567-e89b-12d3-a456-426614174000",
      targetAuthorUuid: undefined,
    });
  });

  it("handles unsend action", async () => {
    sendRemoteDeleteSignal.mockClear();
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;

    const result = await signalMessageActions.handleAction({
      action: "unsend",
      params: {
        to: "+15551234567",
        messageId: "1234567890",
      },
      cfg,
      accountId: undefined,
    });

    expect(sendRemoteDeleteSignal).toHaveBeenCalledWith("+15551234567", 1234567890, {
      accountId: undefined,
    });
    expect(result.details).toMatchObject({
      ok: true,
      deleted: "1234567890",
    });
  });

  it("handles unsend for group target", async () => {
    sendRemoteDeleteSignal.mockClear();
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;

    await signalMessageActions.handleAction({
      action: "unsend",
      params: {
        to: "signal:group:group-id",
        messageId: "9876543210",
      },
      cfg,
      accountId: undefined,
    });

    expect(sendRemoteDeleteSignal).toHaveBeenCalledWith("signal:group:group-id", 9876543210, {
      accountId: undefined,
    });
  });

  it("rejects unsend when action is disabled", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111", actions: { unsend: false } } },
    } as OpenClawConfig;

    await expect(
      signalMessageActions.handleAction({
        action: "unsend",
        params: {
          to: "+15551234567",
          messageId: "1234567890",
        },
        cfg,
        accountId: undefined,
      }),
    ).rejects.toThrow(/actions\.unsend/);
  });

  it("rejects unsend with invalid messageId", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;

    await expect(
      signalMessageActions.handleAction({
        action: "unsend",
        params: {
          to: "+15551234567",
          messageId: "0",
        },
        cfg,
        accountId: undefined,
      }),
    ).rejects.toThrow(/Invalid messageId/);
  });

  it("rejects unsend when remote delete fails", async () => {
    sendRemoteDeleteSignal.mockClear().mockResolvedValueOnce(false);
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;

    await expect(
      signalMessageActions.handleAction({
        action: "unsend",
        params: {
          to: "+15551234567",
          messageId: "1234567890",
        },
        cfg,
        accountId: undefined,
      }),
    ).rejects.toThrow(/Failed to delete/);
  });

  it("enables poll, pollVote, and pollClose by default", () => {
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;
    const actions = signalMessageActions.listActions({ cfg });
    expect(actions).toContain("poll");
    expect(actions).toContain("pollVote");
    expect(actions).toContain("pollClose");
  });

  it("hides poll when disabled", () => {
    const cfg = {
      channels: { signal: { account: "+15550001111", actions: { poll: false } } },
    } as OpenClawConfig;
    const actions = signalMessageActions.listActions({ cfg });
    expect(actions).not.toContain("poll");
  });

  it("handles poll action", async () => {
    sendPollCreateSignal.mockClear();
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;

    const result = await signalMessageActions.handleAction({
      action: "poll",
      params: {
        to: "+15551234567",
        pollQuestion: "Lunch?",
        pollOption: ["Pizza", "Sushi"],
        pollMulti: false,
      },
      cfg,
      accountId: undefined,
    });

    expect(sendPollCreateSignal).toHaveBeenCalledWith("+15551234567", {
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      allowMultiple: false,
      accountId: undefined,
    });
    expect(result.details).toMatchObject({
      ok: true,
      messageId: "999",
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      allowMultiple: false,
    });
  });

  it("defaults poll action to allow multiple selections", async () => {
    sendPollCreateSignal.mockClear();
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;

    await signalMessageActions.handleAction({
      action: "poll",
      params: {
        to: "+15551234567",
        pollQuestion: "Lunch?",
        pollOption: ["Pizza", "Sushi"],
      },
      cfg,
      accountId: undefined,
    });

    expect(sendPollCreateSignal).toHaveBeenCalledWith("+15551234567", {
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      allowMultiple: true,
      accountId: undefined,
    });
  });

  it("rejects poll when action is disabled", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111", actions: { poll: false } } },
    } as OpenClawConfig;

    await expect(
      signalMessageActions.handleAction({
        action: "poll",
        params: {
          to: "+15551234567",
          pollQuestion: "Lunch?",
          pollOption: ["Pizza", "Sushi"],
        },
        cfg,
        accountId: undefined,
      }),
    ).rejects.toThrow(/actions\.poll/);
  });

  it("hides pollVote when disabled", () => {
    const cfg = {
      channels: { signal: { account: "+15550001111", actions: { pollVote: false } } },
    } as OpenClawConfig;
    const actions = signalMessageActions.listActions({ cfg });
    expect(actions).not.toContain("pollVote");
  });

  it("hides pollClose when disabled", () => {
    const cfg = {
      channels: { signal: { account: "+15550001111", actions: { pollClose: false } } },
    } as OpenClawConfig;
    const actions = signalMessageActions.listActions({ cfg });
    expect(actions).not.toContain("pollClose");
  });

  it("handles pollVote action", async () => {
    sendPollVoteSignal.mockClear();
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;

    const result = await signalMessageActions.handleAction({
      action: "pollVote",
      params: {
        to: "+15551234567",
        messageId: "1234567890",
        targetAuthor: "+15559999999",
        pollOptions: [0, 2],
      },
      cfg,
      accountId: undefined,
    });

    expect(sendPollVoteSignal).toHaveBeenCalledWith("+15551234567", {
      pollAuthor: "+15559999999",
      pollTimestamp: 1234567890,
      optionIndexes: [0, 2],
      accountId: undefined,
    });
    expect(result.details).toMatchObject({
      ok: true,
      voted: [0, 2],
    });
  });

  it("handles pollVote for group target", async () => {
    sendPollVoteSignal.mockClear();
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;

    await signalMessageActions.handleAction({
      action: "pollVote",
      params: {
        to: "group:abc123",
        messageId: "9876543210",
        targetAuthor: "+15559999999",
        pollOptions: [1],
      },
      cfg,
      accountId: undefined,
    });

    expect(sendPollVoteSignal).toHaveBeenCalledWith("group:abc123", {
      pollAuthor: "+15559999999",
      pollTimestamp: 9876543210,
      optionIndexes: [1],
      accountId: undefined,
    });
  });

  it("rejects pollVote when action is disabled", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111", actions: { pollVote: false } } },
    } as OpenClawConfig;

    await expect(
      signalMessageActions.handleAction({
        action: "pollVote",
        params: {
          to: "+15551234567",
          messageId: "1234567890",
          targetAuthor: "+15559999999",
          pollOptions: [0],
        },
        cfg,
        accountId: undefined,
      }),
    ).rejects.toThrow(/actions\.pollVote/);
  });

  it("accepts pollOption (singular) for pollVote", async () => {
    sendPollVoteSignal.mockClear();
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;

    await signalMessageActions.handleAction({
      action: "pollVote",
      params: {
        to: "+15551234567",
        messageId: "1234567890",
        targetAuthor: "+15559999999",
        pollOption: [1],
      },
      cfg,
      accountId: undefined,
    });

    expect(sendPollVoteSignal).toHaveBeenCalledWith("+15551234567", {
      pollAuthor: "+15559999999",
      pollTimestamp: 1234567890,
      optionIndexes: [1],
      accountId: undefined,
    });
  });

  it("rejects pollVote without pollOptions", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;

    await expect(
      signalMessageActions.handleAction({
        action: "pollVote",
        params: {
          to: "+15551234567",
          messageId: "1234567890",
          targetAuthor: "+15559999999",
        },
        cfg,
        accountId: undefined,
      }),
    ).rejects.toThrow(/pollOptions/);
  });

  it("handles pollClose action", async () => {
    sendPollTerminateSignal.mockClear();
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;

    const result = await signalMessageActions.handleAction({
      action: "pollClose",
      params: {
        to: "+15551234567",
        messageId: "1234567890",
      },
      cfg,
      accountId: undefined,
    });

    expect(sendPollTerminateSignal).toHaveBeenCalledWith("+15551234567", {
      pollTimestamp: 1234567890,
      accountId: undefined,
    });
    expect(result.details).toMatchObject({
      ok: true,
      closed: "1234567890",
    });
  });

  it("handles pollClose for group target", async () => {
    sendPollTerminateSignal.mockClear();
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;

    await signalMessageActions.handleAction({
      action: "pollClose",
      params: {
        to: "group:xyz789",
        messageId: "9876543210",
      },
      cfg,
      accountId: undefined,
    });

    expect(sendPollTerminateSignal).toHaveBeenCalledWith("group:xyz789", {
      pollTimestamp: 9876543210,
      accountId: undefined,
    });
  });

  it("rejects pollClose when action is disabled", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111", actions: { pollClose: false } } },
    } as OpenClawConfig;

    await expect(
      signalMessageActions.handleAction({
        action: "pollClose",
        params: {
          to: "+15551234567",
          messageId: "1234567890",
        },
        cfg,
        accountId: undefined,
      }),
    ).rejects.toThrow(/actions\.pollClose/);
  });
});
