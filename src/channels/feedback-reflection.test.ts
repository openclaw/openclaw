import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { recordChannelFeedbackEvent, runChannelFeedbackReflection } from "./feedback-reflection.js";

const appendTranscriptEvent = vi.hoisted(() => vi.fn(async () => undefined));
const dispatchChannelInboundTurn = vi.hoisted(() => vi.fn());
const loadSessionEntry = vi.hoisted(() => vi.fn());
const readSessionUpdatedAt = vi.hoisted(() => vi.fn());
const resolveStorePath = vi.hoisted(() => vi.fn(() => "/state/main/sessions.json"));

vi.mock("../config/sessions/paths.js", () => ({ resolveStorePath }));
vi.mock("../config/sessions/session-accessor.js", () => ({
  appendTranscriptEvent,
  loadSessionEntry,
  readSessionUpdatedAt,
}));
vi.mock("./turn/kernel.js", () => ({ dispatchChannelInboundTurn }));

const cfg = {} as OpenClawConfig;

describe("channel feedback reflection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs reflection in the original session and enforces cooldown", async () => {
    dispatchChannelInboundTurn.mockImplementationOnce(async (plan) => {
      await plan.delivery.deliver({
        text: JSON.stringify({
          learning: "Answer the direct question first.",
          followUp: true,
          userMessage: "Want a shorter version?",
        }),
      });
      return { admission: { kind: "dispatch" }, dispatched: true };
    });
    const params = {
      cfg,
      channel: "msteams",
      channelLabel: "Teams",
      agentId: "main",
      sessionKey: "agent:main:msteams:feedback-1",
      conversationId: "conversation-1",
      conversationKind: "group" as const,
      thumbedDownResponse: "Too much detail",
      userComment: "Be concise",
    };

    await expect(runChannelFeedbackReflection(params)).resolves.toEqual({
      status: "complete",
      learning: "Answer the direct question first.",
      followUp: true,
      userMessage: "Want a shorter version?",
      responseLength: 104,
    });
    expect(dispatchChannelInboundTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        channel: "msteams",
        route: { agentId: "main", sessionKey: params.sessionKey },
        ctxPayload: expect.objectContaining({ ChatType: "group" }),
      }),
    );
    await expect(runChannelFeedbackReflection(params)).resolves.toEqual({ status: "cooldown" });
    expect(dispatchChannelInboundTurn).toHaveBeenCalledTimes(1);
  });

  it("records feedback through the canonical transcript accessor", async () => {
    loadSessionEntry.mockReturnValue({ sessionId: "session-1" });
    const event = { type: "custom", event: "feedback", ts: 1 };

    await expect(
      recordChannelFeedbackEvent({
        cfg,
        agentId: "main",
        sessionKey: "agent:main:msteams:feedback-2",
        event,
      }),
    ).resolves.toBe(true);
    expect(appendTranscriptEvent).toHaveBeenCalledWith(
      {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:msteams:feedback-2",
        storePath: "/state/main/sessions.json",
      },
      event,
    );
  });
});
