import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetInboundDedupe } from "../auto-reply/reply/inbound-dedupe.js";
import {
  defaultSlackTestConfig,
  getSlackClient,
  getSlackHandlerOrThrow,
  getSlackTestState,
  resetSlackTestState,
  runSlackMessageOnce,
  startSlackMonitor,
  stopSlackMonitor,
} from "./monitor.test-helpers.js";

const { monitorSlackProvider } = await import("./monitor.js");

const slackTestState = getSlackTestState();
const { sendMock, replyMock, reactMock, upsertPairingRequestMock } = slackTestState;

beforeEach(() => {
  resetInboundDedupe();
  resetSlackTestState(defaultSlackTestConfig());
});

describe("monitorSlackProvider tool results", () => {
  async function runDmMessageWithPolicy(policy: "open" | "allowlist" | "pairing" | "disabled") {
    slackTestState.config = {
      ...slackTestState.config,
      channels: {
        ...slackTestState.config.channels,
        slack: {
          ...slackTestState.config.channels?.slack,
          dm: { enabled: true, policy, allowFrom: [] },
        },
      },
    };

    const controller = new AbortController();
    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
    });

    await waitForSlackEvent("message");
    const handler = getSlackHandlers()?.get("message");
    if (!handler) {
      throw new Error("Slack message handler not registered");
    }

    await handler({
      event: {
        type: "message",
        user: "U1",
        text: "hello",
        ts: "200",
        channel: "D200",
        channel_type: "im",
      },
    });

    await flush();
    controller.abort();
    await run;
  }

  it("forces thread replies when replyToId is set", async () => {
    replyMock.mockResolvedValue({ text: "forced reply", replyToId: "555" });
    slackTestState.config = {
      messages: {
        responsePrefix: "PFX",
        ackReaction: "👀",
        ackReactionScope: "group-mentions",
      },
      channels: {
        slack: {
          dmPolicy: "open",
          allowFrom: ["*"],
          dm: { enabled: true },
          replyToMode: "off",
        },
      },
    };

    await runSlackMessageOnce(monitorSlackProvider, {
      event: {
        type: "message",
        user: "U1",
        text: "hello",
        ts: "789",
        channel: "C1",
        channel_type: "im",
      },
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][2]).toMatchObject({ threadTs: "555" });
  });

  it("reacts to mention-gated room messages when ackReaction is enabled", async () => {
    replyMock.mockResolvedValue(undefined);
    const client = getSlackClient();
    if (!client) {
      throw new Error("Slack client not registered");
    }
    const conversations = client.conversations as {
      info: ReturnType<typeof vi.fn>;
    };
    conversations.info.mockResolvedValueOnce({
      channel: { name: "general", is_channel: true },
    });

    await runSlackMessageOnce(monitorSlackProvider, {
      event: {
        type: "message",
        user: "U1",
        text: "<@bot-user> hello",
        ts: "456",
        channel: "C1",
        channel_type: "channel",
      },
    });

    expect(reactMock).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "456",
      name: "👀",
    });
  });

  it("replies with pairing code when dmPolicy is pairing and no allowFrom is set", async () => {
    slackTestState.config = {
      ...slackTestState.config,
      channels: {
        ...slackTestState.config.channels,
        slack: {
          ...slackTestState.config.channels?.slack,
          dm: { enabled: true, policy: "pairing", allowFrom: [] },
        },
      },
    };

    await runSlackMessageOnce(monitorSlackProvider, {
      event: {
        type: "message",
        user: "U1",
        text: "hello",
        ts: "123",
        channel: "C1",
        channel_type: "im",
      },
    });

    expect(replyMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(String(sendMock.mock.calls[0]?.[1] ?? "")).toContain("Your Slack user id: U1");
    expect(String(sendMock.mock.calls[0]?.[1] ?? "")).toContain("Pairing code: PAIRCODE");
  });

  it("does not resend pairing code when a request is already pending", async () => {
    slackTestState.config = {
      ...slackTestState.config,
      channels: {
        ...slackTestState.config.channels,
        slack: {
          ...slackTestState.config.channels?.slack,
          dm: { enabled: true, policy: "pairing", allowFrom: [] },
        },
      },
    };
    upsertPairingRequestMock
      .mockResolvedValueOnce({ code: "PAIRCODE", created: true })
      .mockResolvedValueOnce({ code: "PAIRCODE", created: false });

    const { controller, run } = startSlackMonitor(monitorSlackProvider);
    const handler = await getSlackHandlerOrThrow("message");

    const baseEvent = {
      type: "message",
      user: "U1",
      text: "hello",
      ts: "123",
      channel: "C1",
      channel_type: "im",
    };

    await handler({ event: baseEvent });
    await handler({ event: { ...baseEvent, ts: "124", text: "hello again" } });

    await stopSlackMonitor({ controller, run });

    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("allows DM processing in open mode even with an empty allowlist", async () => {
    replyMock.mockResolvedValue({ text: "ok" });
    await runDmMessageWithPolicy("open");

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
  });

  it("blocks unauthorized DM in allowlist mode without triggering pairing", async () => {
    replyMock.mockResolvedValue({ text: "ok" });
    await runDmMessageWithPolicy("allowlist");

    expect(replyMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
  });

  it("triggers pairing in pairing mode for unauthorized DM", async () => {
    replyMock.mockResolvedValue({ text: "ok" });
    await runDmMessageWithPolicy("pairing");

    expect(replyMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).toHaveBeenCalledTimes(1);
  });

  it("blocks DM in disabled mode", async () => {
    replyMock.mockResolvedValue({ text: "ok" });
    await runDmMessageWithPolicy("disabled");

    expect(replyMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
  });
});
