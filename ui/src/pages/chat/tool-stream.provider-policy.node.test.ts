import { describe, expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { reduceChatSessionProjection } from "./history-merge.ts";
import { adoptStartedChatRun, reconcileChatRunLifecycle } from "./run-lifecycle.ts";
import { resetToolStream } from "./tool-stream-state.ts";
import { agentEvent, createHost as createToolStreamHost } from "./tool-stream.test-helpers.ts";
import { handleAgentEvent } from "./tool-stream.ts";

function createHost(overrides?: Parameters<typeof createToolStreamHost>[0]) {
  const host = createToolStreamHost(overrides);
  return {
    ...host,
    sessions: { ...host.sessions, reconcileRunTerminal: vi.fn() },
  };
}

function policyEvent(state: string, seq: number, runId = "run-1", sessionKey = "main") {
  return agentEvent(
    runId,
    seq,
    "notice",
    {
      phase: "provider_policy",
      category: "cyber",
      provider: "openai",
      state,
      model: "original-model",
      fallbackModel: "alternate-model",
    },
    sessionKey,
  );
}

describe("provider policy composer notices", () => {
  it("projects typed notices and rejects stale, foreign, and unclassified events", () => {
    const host = createHost({ chatRunId: "run-1" });
    handleAgentEvent(host, policyEvent("buffering", 2));
    expect(host.providerPolicyNotice?.state).toBe("buffering");
    handleAgentEvent(host, policyEvent("blocked", 4));
    const blocked = host.providerPolicyNotice;
    expect(blocked?.state).toBe("blocked");

    for (const event of [
      policyEvent("buffering", 3),
      policyEvent("buffering", 4),
      policyEvent("buffering", 5, "run-other"),
      policyEvent("buffering", 6, "run-1", "another-session"),
      policyEvent("invented-state", 7),
      {
        ...policyEvent("buffering", 8),
        data: { phase: "provider_policy", message: "cyber policy" },
      },
      {
        ...policyEvent("buffering", 9),
        data: { ...policyEvent("buffering", 9).data, provider: "another-provider" },
      },
      policyEvent("buffering", 10),
      policyEvent("fallback", 11),
    ]) {
      handleAgentEvent(host, event);
      expect(host.providerPolicyNotice).toBe(blocked);
    }
    expect(host.guardianNotices).toEqual([]);
  });

  it("lets an automatic Daybreak escalation supersede the block it followed", () => {
    const host = createHost({ chatRunId: "run-1" });
    handleAgentEvent(host, policyEvent("blocked", 1));
    expect(host.providerPolicyNotice?.state).toBe("blocked");
    handleAgentEvent(host, policyEvent("escalated", 2));
    expect(host.providerPolicyNotice).toMatchObject({
      state: "escalated",
      fallbackModel: "alternate-model",
    });
  });

  it("reports an unauthorized Daybreak target instead of a silent block", () => {
    const host = createHost({ chatRunId: "run-1" });
    handleAgentEvent(host, policyEvent("blocked", 1));
    handleAgentEvent(host, policyEvent("unavailable", 2));
    expect(host.providerPolicyNotice?.state).toBe("unavailable");
    // The escalation outcome is terminal for the turn; buffering cannot reopen it.
    handleAgentEvent(host, policyEvent("buffering", 3));
    expect(host.providerPolicyNotice?.state).toBe("unavailable");
  });

  it("clears buffering without clearing a provider reroute or terminal policy block", () => {
    const host = createHost({ chatRunId: "run-1" });
    handleAgentEvent(host, policyEvent("buffering", 1));
    handleAgentEvent(host, policyEvent("cleared", 2));
    expect(host.providerPolicyNotice).toBeNull();
    handleAgentEvent(host, policyEvent("buffering", 1));
    expect(host.providerPolicyNotice).toBeNull();

    handleAgentEvent(host, policyEvent("fallback", 3));
    handleAgentEvent(host, policyEvent("cleared", 4));
    expect(host.providerPolicyNotice).toMatchObject({
      state: "fallback",
      fallbackModel: "alternate-model",
    });
    handleAgentEvent(host, policyEvent("blocked", 5));
    handleAgentEvent(host, policyEvent("cleared", 6));
    reconcileChatRunLifecycle(host, {
      clearLocalRun: true,
      clearToolStreamForRun: true,
      requestUpdate: false,
    });
    expect(host.providerPolicyNotice?.state).toBe("blocked");
    resetToolStream(host);
    handleAgentEvent(host, policyEvent("buffering", 1));
    expect(host.providerPolicyNotice?.state).toBe("blocked");
  });

  it("preserves pre-ACK notices for the adopted run and retires them on the next turn", () => {
    const host = {
      ...createHost(),
      chatMessages: [],
      chatQueue: [
        {
          id: "send-1",
          text: "hello",
          createdAt: 1,
          sendRunId: "run-1",
          sendState: "sending",
          sessionKey: "main",
        },
      ] satisfies ChatQueueItem[],
    };
    handleAgentEvent(host, policyEvent("buffering", 1));
    expect(host.providerPolicyNotice?.state).toBe("buffering");
    adoptStartedChatRun(host, "run-1", 1);
    host.chatQueue = [];
    expect(host.providerPolicyNotice?.state).toBe("buffering");
    adoptStartedChatRun(host, "run-2", 2);
    expect(host.providerPolicyNotice).toBeNull();
    reconcileChatRunLifecycle(host, { clearLocalRun: true, requestUpdate: false });
    handleAgentEvent(host, policyEvent("blocked", 10));
    expect(host.providerPolicyNotice).toBeNull();
  });

  it("rejects ownerless delayed events after reset and unrelated events during a pending send", () => {
    const host = {
      ...createHost(),
      chatMessages: [],
      chatSending: true,
      chatQueue: [] as ChatQueueItem[],
    };
    handleAgentEvent(host, policyEvent("blocked", 1));
    expect(host.providerPolicyNotice).toBeUndefined();

    adoptStartedChatRun(host, "run-1", 1);
    handleAgentEvent(host, policyEvent("blocked", 2));
    expect(host.providerPolicyNotice?.state).toBe("blocked");
    reconcileChatRunLifecycle(host, { clearLocalRun: true, requestUpdate: false });
    reduceChatSessionProjection(host, { type: "sessionReset" });
    expect(host.providerPolicyNotice).toBeNull();
    handleAgentEvent(host, policyEvent("blocked", 3));
    expect(host.providerPolicyNotice).toBeNull();

    host.chatQueue = [
      {
        id: "send-2",
        text: "next",
        createdAt: 2,
        sendRunId: "run-2",
        sendState: "sending",
        sessionKey: "main",
      },
    ];
    handleAgentEvent(host, policyEvent("blocked", 4));
    expect(host.providerPolicyNotice).toBeNull();
    handleAgentEvent(host, policyEvent("buffering", 1, "run-2"));
    expect(host.providerPolicyNotice).toMatchObject({ state: "buffering", runId: "run-2" });
  });
});
