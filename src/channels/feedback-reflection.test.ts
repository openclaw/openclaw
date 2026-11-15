import { beforeEach, expect, it, vi } from "vitest";
import { runChannelFeedbackReflection } from "./feedback-reflection.js";
import {
  consumeChannelAdmissionEvidence,
  readChannelContextAdmissionEvidence,
} from "./message-access/admission-evidence.js";

const dispatchRoutedChannelTurn = vi.hoisted(() => vi.fn());

// mock-isolation: Reflection dispatch uses a fixed session path rather than host state directories.
vi.mock("../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: vi.fn(() => "/state/main/sessions.json"),
}));
// mock-isolation: Persistence is exercised through the real feedback worker boundary.
vi.mock("../config/sessions/session-entry-read-runtime.js", () => ({
  withSessionEntryReadOnlyInWorker: vi.fn(),
  readSessionUpdatedAtInWorker: vi.fn(async () => undefined),
}));
vi.mock("./turn/lifecycle.js", () => ({ dispatchRoutedChannelTurn }));

const cfg = {};
const learning = "Answer the direct question first.";
const complete = {
  status: "complete",
  learning,
  storePath: "/state/main/sessions.json",
  followUp: false,
  userMessage: undefined,
  responseLength: 33,
};
function reflectionParams(id: string) {
  return {
    cfg,
    channel: "msteams",
    channelLabel: "Teams",
    agentId: "main",
    sessionKey: `agent:main:msteams:feedback-${id}`,
    conversationId: `conversation-${id}`,
    conversationKind: "direct" as const,
  };
}

function deliverReflection(text: string) {
  dispatchRoutedChannelTurn.mockImplementationOnce(async (plan) => {
    expect(
      consumeChannelAdmissionEvidence(readChannelContextAdmissionEvidence(plan.ctxPayload)),
    ).toMatchObject({ ingressState: "unsupported", decisionCoverage: "unsupported" });
    await plan.delivery.deliver({ text });
    return { admission: { kind: "dispatch" }, dispatched: true };
  });
}

beforeEach(() => vi.clearAllMocks());

it("runs reflection in the original session and enforces cooldown", async () => {
  deliverReflection(
    JSON.stringify({
      learning,
      followUp: true,
      userMessage: "Want a shorter version?",
    }),
  );
  const params = {
    ...reflectionParams("1"),
    conversationKind: "group" as const,
    thumbedDownResponse: "Too much detail",
    userComment: "Be concise",
  };

  await expect(runChannelFeedbackReflection(params)).resolves.toEqual({
    ...complete,
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

const structured = JSON.stringify({ learning, followUp: ["yes"] });
it.each([
  ["plain", learning, complete],
  ["empty", "", { status: "empty" }],
  ["structured", structured, { ...complete, responseLength: structured.length }],
] as const)("parses %s reflection without inventing directives", async (id, text, expected) => {
  deliverReflection(text);
  await expect(runChannelFeedbackReflection(reflectionParams(id))).resolves.toEqual(expected);
});
