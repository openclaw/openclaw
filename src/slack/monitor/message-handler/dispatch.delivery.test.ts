import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchInboundMessageMock = vi.fn();
const deliverRepliesMock = vi.fn();
const removeAckReactionAfterReplyMock = vi.fn();
const recordSlackThreadParticipationMock = vi.fn();

vi.mock("../../../agents/identity.js", () => ({
  resolveHumanDelayConfig: () => ({ mode: "off" }),
}));

vi.mock("../../../auto-reply/dispatch.js", () => ({
  dispatchInboundMessage: (...args: unknown[]) => dispatchInboundMessageMock(...args),
}));

vi.mock("../../../channels/ack-reactions.js", () => ({
  removeAckReactionAfterReply: (...args: unknown[]) => removeAckReactionAfterReplyMock(...args),
}));

vi.mock("../../../channels/reply-prefix.js", () => ({
  createReplyPrefixOptions: () => ({}),
}));

vi.mock("../../../channels/typing.js", () => ({
  createTypingCallbacks: (callbacks: Record<string, unknown>) => callbacks,
}));

vi.mock("../../../infra/outbound/identity.js", () => ({
  resolveAgentOutboundIdentity: () => undefined,
}));

vi.mock("../../../media/local-roots.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../media/local-roots.js")>();
  return {
    ...actual,
    getAgentScopedMediaLocalRoots: () => [],
  };
});

vi.mock("../../../security/dm-policy-shared.js", () => ({
  resolvePinnedMainDmOwnerFromAllowlist: () => undefined,
}));

vi.mock("../../draft-stream.js", () => ({
  createSlackDraftStream: () => ({
    update: vi.fn(),
    clear: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    stop: vi.fn(),
    forceNewMessage: vi.fn(),
    messageId: vi.fn(() => undefined),
    channelId: vi.fn(() => undefined),
  }),
}));

vi.mock("../../sent-thread-cache.js", () => ({
  recordSlackThreadParticipation: (...args: unknown[]) =>
    recordSlackThreadParticipationMock(...args),
}));

vi.mock("../../stream-mode.js", () => ({
  applyAppendOnlyStreamUpdate: vi.fn(),
  buildStatusFinalPreviewText: vi.fn(),
  resolveSlackStreamingConfig: () => ({
    mode: "off",
    draftMode: "replace",
    nativeStreaming: false,
  }),
}));

vi.mock("../../threading.js", () => ({
  resolveSlackThreadTargets: ({ message }: { message: { thread_ts?: string } }) => ({
    statusThreadTs: message.thread_ts,
    isThreadReply: Boolean(message.thread_ts),
  }),
}));

vi.mock("../replies.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../replies.js")>();
  return {
    ...actual,
    deliverReplies: (...args: unknown[]) => deliverRepliesMock(...args),
  };
});

const { dispatchPreparedSlackMessage } = await import("./dispatch.js");

function createPreparedMessage(params?: { incidentRootOnly?: boolean }) {
  const incidentRootOnly = params?.incidentRootOnly ?? true;
  return {
    ctx: {
      cfg: {},
      runtime: { error: vi.fn() },
      app: { client: { chat: { update: vi.fn() } } },
      botToken: "xoxb-test",
      teamId: "T1",
      textLimit: 4000,
      typingReaction: "",
      removeAckAfterReply: false,
      setSlackThreadStatus: vi.fn(async () => {}),
      channelHistories: new Map(),
      historyLimit: 20,
      allowFrom: [],
    },
    account: {
      accountId: "default",
      config: {},
    },
    message: {
      channel: "C1",
      ts: "1700000000.000100",
      thread_ts: "1700000000.000100",
      text: "question",
      user: "U1",
    },
    route: {
      agentId: "agent-sre",
      accountId: "default",
      mainSessionKey: "main-slack-session",
    },
    channelConfig: incidentRootOnly ? { incidentRootOnly: true } : null,
    replyTarget: "channel:C1",
    ctxPayload: {
      CommandBody: "question",
      RawBody: "question",
    },
    replyToMode: "all" as const,
    isDirectMessage: false,
    isRoomish: false,
    historyKey: "slack:C1",
    preview: "question",
    ackReactionValue: "",
    ackReactionPromise: null,
  } as unknown as Parameters<typeof dispatchPreparedSlackMessage>[0];
}

describe("dispatchPreparedSlackMessage final-only delivery", () => {
  beforeEach(() => {
    deliverRepliesMock.mockReset();
    deliverRepliesMock.mockResolvedValue(1);
    dispatchInboundMessageMock.mockReset();
    dispatchInboundMessageMock.mockImplementation(async ({ dispatcher }) => {
      dispatcher.sendToolResult({ text: "tool update" });
      dispatcher.sendBlockReply({ text: "block update" });
      dispatcher.sendFinalReply({ text: "final answer" });
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      return {
        queuedFinal: true,
        counts: dispatcher.getQueuedCounts(),
      };
    });
    removeAckReactionAfterReplyMock.mockReset();
    removeAckReactionAfterReplyMock.mockImplementation(() => {});
    recordSlackThreadParticipationMock.mockReset();
  });

  it("drops tool and block deliveries in final-only Slack threads while still sending the final", async () => {
    await dispatchPreparedSlackMessage(createPreparedMessage({ incidentRootOnly: true }));

    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expect(
      deliverRepliesMock.mock.calls.map((call) => call[0].replies[0]?.text as string | undefined),
    ).toEqual(["final answer"]);
  });

  it("keeps tool, block, and final deliveries in normal Slack threads", async () => {
    await dispatchPreparedSlackMessage(createPreparedMessage({ incidentRootOnly: false }));

    expect(deliverRepliesMock).toHaveBeenCalledTimes(3);
    expect(
      deliverRepliesMock.mock.calls.map((call) => call[0].replies[0]?.text as string | undefined),
    ).toEqual(["tool update", "block update", "final answer"]);
  });

  it("uses skipped tool evidence to correct the final Slack reply", async () => {
    dispatchInboundMessageMock.mockImplementation(async ({ dispatcher }) => {
      dispatcher.sendToolResult({
        text: `--- v1 total >= 10k ---
55
--- v1 listed ---
48
--- v1 unlisted ---
7`,
      });
      dispatcher.sendToolResult({
        text: `- v1.1: 255 total, 174 listed, 81 unlisted
- v2: 134 total, 97 listed, 37 unlisted`,
      });
      dispatcher.sendToolResult({
        text: `| Version | Total ≥ $10k | Listed | Unlisted |
|---------|------------:|-------:|---------:|
| v1 | 55 | 48 | 7 |
| v1.1 | 255 | 174 | 81 |
| v2 | 134 | 97 | 37 |
| Grand total | 444 | 319 | 125 |`,
      });
      dispatcher.sendFinalReply({
        text: `**Vaults ≥ $10k: 544 total**

- v1.1: 255 total, 174 listed, 18 unlisted
- v2: 134 total, 79 listed, 37 unlisted

| Version | Total ≥ $10k | Listed | Unlisted |
|---------|------------:|-------:|---------:|
| v1 | 55 | 48 | 7 |
| v1.1 | 255 | 174 | 18 |
| v2 | 134 | 79 | 37 |
| Grand total | 444 | 301 | 62 |`,
      });
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      return {
        queuedFinal: true,
        counts: dispatcher.getQueuedCounts(),
      };
    });

    await dispatchPreparedSlackMessage(createPreparedMessage({ incidentRootOnly: true }));

    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    const finalReply = deliverRepliesMock.mock.calls[0]?.[0].replies[0]?.text as string | undefined;
    expect(finalReply).toContain("**Vaults ≥ $10k: 444 total**");
    expect(finalReply).toContain("- v1.1: 255 total, 174 listed, 81 unlisted");
    expect(finalReply).toContain("- v2: 134 total, 97 listed, 37 unlisted");
    expect(finalReply).toContain("| v1.1 | 255 | 174 | 81 |");
    expect(finalReply).toContain("| v2 | 134 | 97 | 37 |");
    expect(finalReply).toContain("| Grand total | 444 | 319 | 125 |");
  });

  it("ignores skipped block replies when collecting final-guard evidence", async () => {
    dispatchInboundMessageMock.mockImplementation(async ({ dispatcher }) => {
      dispatcher.sendToolResult({
        text: `| Version | Total ≥ $10k | Listed | Unlisted |
|---------|------------:|-------:|---------:|
| v1 | 55 | 48 | 7 |
| v1.1 | 255 | 174 | 81 |
| v2 | 134 | 97 | 37 |
| Grand total | 444 | 319 | 125 |`,
      });
      dispatcher.sendBlockReply({
        text: `- v1.1: 255 total, 174 listed, 18 unlisted
- v2: 134 total, 79 listed, 37 unlisted`,
      });
      dispatcher.sendFinalReply({
        text: `**Vaults ≥ $10k: 444 total**

- v1.1: 255 total, 174 listed, 81 unlisted
- v2: 134 total, 97 listed, 37 unlisted

| Version | Total ≥ $10k | Listed | Unlisted |
|---------|------------:|-------:|---------:|
| v1 | 55 | 48 | 7 |
| v1.1 | 255 | 174 | 81 |
| v2 | 134 | 97 | 37 |
| Grand total | 444 | 319 | 125 |`,
      });
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      return {
        queuedFinal: true,
        counts: dispatcher.getQueuedCounts(),
      };
    });

    await dispatchPreparedSlackMessage(createPreparedMessage({ incidentRootOnly: true }));

    const finalReply = deliverRepliesMock.mock.calls[0]?.[0].replies[0]?.text as string | undefined;
    expect(finalReply).toContain("**Vaults ≥ $10k: 444 total**");
    expect(finalReply).toContain("- v1.1: 255 total, 174 listed, 81 unlisted");
    expect(finalReply).toContain("- v2: 134 total, 97 listed, 37 unlisted");
    expect(finalReply).not.toContain("18 unlisted");
    expect(finalReply).not.toContain("79 listed");
  });
});
