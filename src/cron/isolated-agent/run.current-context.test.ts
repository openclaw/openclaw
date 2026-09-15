import { describe, expect, it } from "vitest";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  dispatchCronDeliveryMock,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  makeCronSessionEntry,
  mockRunCronFallbackPassthrough,
  readSessionMessagesAsyncMock,
  resolveCronSessionMock,
  resolveCronDeliveryPlanMock,
  resolveDeliveryTargetMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const sourceSessionKey = "agent:default:telegram:direct:42";

function embeddedPrompt(): string {
  const prompt = runEmbeddedAgentMock.mock.calls[0]?.[0]?.prompt;
  if (typeof prompt !== "string") {
    throw new Error("expected embedded run prompt");
  }
  return prompt;
}

describe("runCronIsolatedAgentTurn — current conversation context", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });

  it("prepends the bound source conversation to a current-target payload", async () => {
    mockRunCronFallbackPassthrough();
    const sourceSessionEntry = makeCronSessionEntry({
      sessionId: "source-session",
      lifecycleRevision: "source-revision",
    });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({ store: { [sourceSessionKey]: sourceSessionEntry } }),
    );
    readSessionMessagesAsyncMock.mockResolvedValue([
      { role: "user", content: "Otters hold hands while sleeping." },
      { role: "assistant", content: "Got it." },
    ]);

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          sessionKey: sourceSessionKey,
          sessionTarget: "current",
          payload: { kind: "agentTurn", message: "Summarize the animal fact." },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(readSessionMessagesAsyncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionEntry: sourceSessionEntry,
        sessionId: "source-session",
        sessionKey: sourceSessionKey,
      }),
      { mode: "recent", maxBytes: 256 * 1024, maxLines: 220, maxMessages: 220 },
    );
    expect(embeddedPrompt()).toContain(
      "Recent conversation:\n- User: Otters hold hands while sleeping.\n- Assistant: Got it.\n\nSummarize the animal fact.",
    );
    expect(dispatchCronDeliveryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSessionKey,
        sourceSessionGeneration: {
          sessionId: "source-session",
          lifecycleRevision: "source-revision",
        },
      }),
    );
  });

  it("leaves isolated-target payloads unchanged", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        store: {
          [sourceSessionKey]: makeCronSessionEntry({ sessionId: "source-session" }),
        },
      }),
    );
    readSessionMessagesAsyncMock.mockResolvedValue([
      { role: "user", content: "This must not be carried." },
    ]);

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          sessionKey: sourceSessionKey,
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "Run independently." },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(readSessionMessagesAsyncMock).not.toHaveBeenCalled();
    expect(embeddedPrompt()).toContain("Run independently.");
    expect(embeddedPrompt()).not.toContain("Recent conversation:");
  });

  it("admits a saved matching topic as the isolated exec completion owner", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({ requested: true, mode: "announce" });
    const topicSessionKey = "agent:default:telegram:group:-100123:topic:42";
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        store: {
          [topicSessionKey]: makeCronSessionEntry({
            sessionId: "topic-session",
            lifecycleRevision: "topic-revision",
          }),
        },
      }),
    );
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "telegram",
      to: "-100123:topic:42",
      threadId: 42,
      mode: "explicit",
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          sessionKey: topicSessionKey,
          sessionTarget: "isolated",
          delivery: { mode: "announce", channel: "telegram", to: "-100123:topic:42" },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        execCompletionSessionKey: topicSessionKey,
        execCompletionSessionGeneration: {
          sessionId: "topic-session",
          lifecycleRevision: "topic-revision",
        },
      }),
    );
  });

  it("rejects a matching topic route when no saved source session exists", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({ requested: true, mode: "announce" });
    const topicSessionKey = "agent:default:telegram:group:-100123:topic:42";
    resolveCronSessionMock.mockReturnValue(makeCronSession({ store: {} }));
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "telegram",
      to: "-100123:topic:42",
      threadId: 42,
      mode: "explicit",
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          sessionKey: topicSessionKey,
          sessionTarget: "isolated",
          delivery: { mode: "announce", channel: "telegram", to: "-100123:topic:42" },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(runEmbeddedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        execCompletionSessionKey: undefined,
        execCompletionSessionGeneration: undefined,
      }),
    );
  });
});
