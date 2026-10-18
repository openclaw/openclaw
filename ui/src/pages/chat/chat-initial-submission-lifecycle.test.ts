/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { clearChatHistory } from "./chat-history-actions.ts";
import { resetChatHistoryProjection } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatPageHost } from "./chat-pending-inputs.test-support.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import { admitChatSubmission } from "./history-merge.ts";
import { applyChatCacheSnapshot } from "./session-message-cache.ts";
import { buildInitialChatSubmission } from "./user-message-content.ts";

function initialSubmissionFixture() {
  const sessionKey = "agent:main:initial-lifecycle";
  let sessionId = "physical-a";
  const host = makeChatPageHost({
    sessionKey,
    requestHandlers: {
      "chat.history": () => ({
        sessionId,
        messages: [],
        sessionInfo: { key: sessionKey, sessionId, hasActiveRun: true, status: "running" },
      }),
    },
  });
  const input = expectDefined(
    buildInitialChatSubmission(
      sessionKey,
      { text: "original initial prompt", createdAt: 1 },
      expectDefined(host.client, "connected client"),
      "initial-run",
    ),
    "initial prompt",
  );
  host.chatSubmissions.retain(input);
  const retained = expectDefined(
    host.chatSubmissions.readInitial(sessionKey, input.owner),
    "retained initial input",
  );
  admitChatSubmission(host, undefined);
  const submitNewer = () => {
    const newer = expectDefined(
      buildInitialChatSubmission(
        host.sessionKey,
        { text: "new initial prompt", createdAt: 2 },
        input.owner,
        "new-run",
      ),
      "new initial prompt",
    );
    host.chatSubmissions.retain(newer);
    admitChatSubmission(host, undefined);
    return newer.message;
  };
  return { host, input, retained, submitNewer, replace: () => (sessionId = "physical-b") };
}

describe("initial submission lifecycle", () => {
  it("preserves cache-only resets and binds the first authoritative physical session", async () => {
    const { host, input, retained, replace } = initialSubmissionFixture();
    applyChatCacheSnapshot(host, {
      messages: [],
      sessionId: "cached-placeholder",
      pagination: { hasMore: false },
    });
    resetChatHistoryProjection(host);
    admitChatSubmission(host, undefined);
    expect(host.chatMessages).toEqual([input.message]);
    await loadChatHistory(host);
    expect(host.currentSessionId).toBe("physical-a");
    expect(host.chatMessages).toEqual([input.message]);
    replace();
    await loadChatHistory(host);
    expect(host.currentSessionId).toBe("physical-b");
    expect(host.chatMessages).toEqual([]);
    expect(retained).toMatchObject({ pending: false, message: null });
    host.chatSubmissions.retain(input);
    admitChatSubmission(host, undefined);
    expect(host.chatMessages).toEqual([]);
  });

  it.each(["completed", "uncertain", "not-started", "rejected", "newer handoff"] as const)(
    "retires an initial prompt only after an issued clear (%s)",
    async (result) => {
      const { host, input, retained, submitNewer } = initialSubmissionFixture();
      await loadChatHistory(host);
      const response = createDeferred<"completed">();
      const reset = vi.spyOn(host.sessions, "reset");
      if (result === "rejected") {
        reset.mockRejectedValue(new Error("Reset was refused"));
      } else if (result === "newer handoff") {
        reset.mockReturnValue(response.promise);
      } else {
        reset.mockResolvedValue(result);
      }
      const clearing = clearChatHistory(host);
      if (result === "newer handoff") {
        const newerMessage = submitNewer();
        response.resolve("completed");
        await clearing;
        expect(host.chatMessages).toEqual([newerMessage]);
        expect(retained).toMatchObject({ pending: false, message: null });
        return;
      }
      await clearing;
      resetChatHistoryProjection(host);
      host.chatSubmissions.retain(input);
      admitChatSubmission(host, undefined);
      expect(host.chatMessages).toEqual(
        result === "completed" || result === "uncertain" ? [] : [input.message],
      );
    },
  );

  it.each(["reset", "new"])(
    "retires initial ownership on authoritative %s and admits a newer run",
    async (reason) => {
      const { host, input, submitNewer } = initialSubmissionFixture();
      await loadChatHistory(host);
      handlePageGatewayEvent(host, {
        type: "event",
        event: "sessions.changed",
        payload: {
          sessionKey: host.sessionKey,
          sessionId: host.currentSessionId,
          agentId: "main",
          reason,
        },
      });
      await loadChatHistory(host);
      host.chatSubmissions.retain(input);
      admitChatSubmission(host, undefined);
      expect(host.chatMessages).toEqual([]);
      const newerMessage = submitNewer();
      expect(host.chatMessages).toEqual([newerMessage]);
    },
  );
});
