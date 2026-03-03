import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetInboundDedupe } from "../auto-reply/reply/inbound-dedupe.js";
import {
  flush,
  getSlackClient,
  getSlackHandlerOrThrow,
  getSlackTestState,
  resetSlackTestState,
  startSlackMonitor,
  stopSlackMonitor,
} from "./monitor.test-helpers.js";

const { monitorSlackProvider } = await import("./monitor.js");

const slackTestState = getSlackTestState();

type SlackConversationsClient = {
  history: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
};

function makeThreadReplyEvent() {
  return {
    event: {
      type: "message",
      user: "U1",
      text: "hello",
      ts: "456",
      parent_user_id: "U2",
      channel: "C1",
      channel_type: "channel",
    },
  };
}

function getConversationsClient(): SlackConversationsClient {
  const client = getSlackClient();
  if (!client) {
    throw new Error("Slack client not registered");
  }
  return client.conversations as SlackConversationsClient;
}

async function runMissingThreadScenario(params: {
  historyResponse?: { messages: Array<{ ts?: string; thread_ts?: string }> };
  historyError?: Error;
}) {
  slackTestState.replyMock.mockResolvedValue({ text: "thread reply" });

  const conversations = getConversationsClient();
  if (params.historyError) {
    conversations.history.mockRejectedValueOnce(params.historyError);
  } else {
    conversations.history.mockResolvedValueOnce(
      params.historyResponse ?? { messages: [{ ts: "456" }] },
    );
  }

  const { controller, run } = startSlackMonitor(monitorSlackProvider);
  const handler = await getSlackHandlerOrThrow("message");
  await handler(makeThreadReplyEvent());

  await flush();
  await stopSlackMonitor({ controller, run });

  expect(slackTestState.sendMock).toHaveBeenCalledTimes(1);
  return slackTestState.sendMock.mock.calls[0]?.[2];
}

beforeEach(() => {
  resetInboundDedupe();
  resetSlackTestState({
    messages: { responsePrefix: "PFX" },
    channels: {
      slack: {
        dm: { enabled: true, policy: "open", allowFrom: ["*"] },
        groupPolicy: "open",
        channels: { C1: { allow: true, requireMention: false } },
      },
    },
  });
  const conversations = getConversationsClient();
  conversations.info.mockResolvedValue({
    channel: { name: "general", is_channel: true },
  });
});

describe("monitorSlackProvider threading", () => {
  it("recovers missing thread_ts when parent_user_id is present", async () => {
    const options = await runMissingThreadScenario({
      historyResponse: { messages: [{ ts: "456", thread_ts: "111.222" }] },
    });
    expect(options).toMatchObject({ threadTs: "111.222" });
  });

  it("continues without thread_ts when history lookup returns no thread result", async () => {
    const options = await runMissingThreadScenario({
      historyResponse: { messages: [{ ts: "456" }] },
    });
    expect(options).not.toMatchObject({ threadTs: "111.222" });
  });

  it("continues without thread_ts when history lookup throws", async () => {
    const options = await runMissingThreadScenario({
      historyError: new Error("history failed"),
    });
    expect(options).not.toMatchObject({ threadTs: "111.222" });
  });
});
