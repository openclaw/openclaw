import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runChannelFeedbackReflection } from "./feedback-reflection.js";
import {
  consumeChannelAdmissionEvidence,
  readChannelContextAdmissionEvidence,
} from "./message-access/admission-evidence.js";

const dispatchRoutedChannelTurn = vi.hoisted(() => vi.fn());
const resolveStorePath = vi.hoisted(() => vi.fn(() => "/state/main/sessions.json"));

vi.mock("../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: resolveStorePath,
}));
// mock-isolation: Persistence is exercised through the real feedback worker boundary.
vi.mock("../config/sessions/session-entry-read-runtime.js", () => ({
  withSessionEntryReadOnlyInWorker: vi.fn(),
  readSessionUpdatedAtInWorker: vi.fn(async () => undefined),
}));
vi.mock("./turn/lifecycle.js", () => ({ dispatchRoutedChannelTurn }));

const cfg = {} as OpenClawConfig;

describe("channel feedback reflection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("classifies internal reflection as explicitly unsupported provenance", async () => {
    dispatchRoutedChannelTurn.mockImplementationOnce(async (plan) => {
      expect(
        consumeChannelAdmissionEvidence(
          readChannelContextAdmissionEvidence(plan.ctxPayload as object),
        ),
      ).toMatchObject({ ingressState: "unsupported", decisionCoverage: "unsupported" });
      return { admission: { kind: "dispatch" }, dispatched: false };
    });
    await runChannelFeedbackReflection({
      cfg,
      channel: "msteams",
      channelLabel: "Teams",
      agentId: "main",
      sessionKey: "agent:main:msteams:feedback-unsupported",
      conversationId: "conversation-unsupported",
      conversationKind: "direct",
    });
  });

  it("runs reflection in the original session and enforces cooldown", async () => {
    dispatchRoutedChannelTurn.mockImplementationOnce(async (plan) => {
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
      storePath: "/state/main/sessions.json",
      followUp: true,
      userMessage: "Want a shorter version?",
      responseLength: 104,
    });
    expect(dispatchRoutedChannelTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        channel: "msteams",
        route: { agentId: "main", sessionKey: params.sessionKey },
        ctxPayload: expect.objectContaining({
          ChatType: "group",
          ConversationRouteContextObserved: false,
        }),
      }),
    );
    await expect(runChannelFeedbackReflection(params)).resolves.toEqual({ status: "cooldown" });
    expect(dispatchRoutedChannelTurn).toHaveBeenCalledTimes(1);
  });

  it("preserves a plain-text reflection as internal learning", async () => {
    dispatchRoutedChannelTurn.mockImplementationOnce(async (plan) => {
      await plan.delivery.deliver({ text: "Answer the direct question first." });
      return { admission: { kind: "dispatch" }, dispatched: true };
    });

    await expect(
      runChannelFeedbackReflection({
        cfg,
        channel: "msteams",
        channelLabel: "Teams",
        agentId: "main",
        sessionKey: "agent:main:msteams:feedback-plain",
        conversationId: "conversation-plain",
        conversationKind: "direct",
      }),
    ).resolves.toEqual({
      status: "complete",
      learning: "Answer the direct question first.",
      storePath: "/state/main/sessions.json",
      followUp: false,
      userMessage: undefined,
      responseLength: 33,
    });
  });

  it("does not treat structured follow-up values as directives", async () => {
    dispatchRoutedChannelTurn.mockImplementationOnce(async (plan) => {
      await plan.delivery.deliver({
        text: JSON.stringify({ learning: "Be concise.", followUp: ["yes"] }),
      });
      return { admission: { kind: "dispatch" }, dispatched: true };
    });

    await expect(
      runChannelFeedbackReflection({
        cfg,
        channel: "msteams",
        channelLabel: "Teams",
        agentId: "main",
        sessionKey: "agent:main:msteams:feedback-structured",
        conversationId: "conversation-structured",
        conversationKind: "direct",
      }),
    ).resolves.toMatchObject({ status: "complete", followUp: false });
  });
});
